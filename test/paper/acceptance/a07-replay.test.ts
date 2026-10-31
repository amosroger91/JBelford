import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MarketEvent } from '../../../src/paper/domain';
import { canonicalJournal, diffJournals, journalHash } from '../../../src/paper/evaluation/canonical';
import { Recorder, readDataset, readManifest } from '../../../src/paper/market/recorder';
import { PaperRuntime } from '../../../src/paper/runtime';
import { TradingService, runReplay } from '../../../src/paper/service';
import { TradingStore } from '../../../src/paper/store';
import { PRODUCT, ScriptedStrategy, T0, testConfig } from '../harness';

/**
 * 18. Recorded replay with the same events, config, recorded decisions and
 * clock rules yields the same canonical financial journal hash. The scenario
 * spans orders, fills, a partial fill, a feed gap, a process restart with a
 * new runtime, and a recorded control, all through the recorder.
 */
describe('18. deterministic recorded replay', () => {
  it('reproduces the canonical journal exactly across restart, gap, partial fill and controls', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jb-replay-'));
    const cfg = testConfig({ storage: { db: join(dir, 'live.db') }, execution: { participation: '0.5' } }, join(dir, 'rec'));
    const store = new TradingStore(cfg.storage.db);
    const svc = new TradingService(store);
    const id = svc.createSession(cfg, PRODUCT, { kind: 'forward', now: T0, id: 'live-1' });
    const strat = new ScriptedStrategy();
    let t = T0;
    let seq = 0;
    const run = (rt: PaperRuntime, e: Omit<MarketEvent, 'ordinal' | 'receiptTime'>) =>
      rt.ingest({ ...(e as MarketEvent), ordinal: 0, receiptTime: t });
    const bar = (rt: PaperRuntime, price: string) => {
      const start = Math.floor(t / 300_000) * 300_000;
      run(rt, {
        kind: 'trade',
        epoch: 1,
        seq: seq++,
        exchangeTime: start + 1000,
        tradeId: `x${seq}`,
        price,
        size: '0.1',
        venueSide: 'SELL',
      } as never);
      t = start + 302_000;
      run(rt, { kind: 'book_update', epoch: 1, seq: seq++, exchangeTime: t, changes: [{ side: 'bid', price: '1', qty: '0' }] } as never);
    };

    // ---- first process ----
    let rec = new Recorder(cfg.recording.dir, id, id, cfg.recording.segmentSeconds * 1000, false);
    let rt = new PaperRuntime(store, cfg, id, PRODUCT, { mode: 'forward', strategy: strat, recorder: rec });
    run(rt, { kind: 'lifecycle', state: 'started' } as never);
    run(rt, { kind: 'connection', epoch: 1, state: 'open' } as never);
    run(rt, {
      kind: 'book_snapshot',
      epoch: 1,
      seq: seq++,
      exchangeTime: t,
      bids: [{ price: '79999', qty: '0.004' }],
      asks: [
        { price: '80000', qty: '0.004' },
        { price: '80001', qty: '0.002' },
      ],
    } as never);
    strat.target = 0.2;
    bar(rt, '80000');
    t += 800;
    run(rt, {
      kind: 'book_update',
      epoch: 1,
      seq: seq++,
      exchangeTime: t,
      changes: [{ side: 'ask', price: '80000', qty: '0.004' }],
    } as never); // partial (participation 50%)
    t += 1000;
    run(rt, { kind: 'tick' } as never);
    run(rt, { kind: 'seq_gap', epoch: 1, expected: 99, got: 101 } as never);
    run(rt, { kind: 'lifecycle', state: 'stopping', detail: 'bounded run' } as never);
    rt.finish();
    rec.close();

    // ---- second process (restart) ----
    t += 600_000;
    rec = new Recorder(cfg.recording.dir, id, id, cfg.recording.segmentSeconds * 1000, false);
    rt = new PaperRuntime(store, cfg, id, PRODUCT, { mode: 'forward', strategy: strat, recorder: rec });
    run(rt, { kind: 'lifecycle', state: 'restarted' } as never);
    run(rt, { kind: 'connection', epoch: 2, state: 'open' } as never);
    run(rt, {
      kind: 'book_snapshot',
      epoch: 2,
      seq: seq++,
      exchangeTime: t,
      bids: [{ price: '81000', qty: '1' }],
      asks: [{ price: '81001', qty: '1' }],
    } as never);
    strat.target = 0;
    bar(rt, '81000');
    t += 1000;
    run(rt, { kind: 'book_update', epoch: 2, seq: seq++, exchangeTime: t, changes: [{ side: 'bid', price: '81000', qty: '1' }] } as never);
    t += 60_000;
    run(rt, { kind: 'tick' } as never);
    run(rt, { kind: 'control', action: 'stop', requestId: 'stop-1' } as never);
    rt.finish();
    rec.close();

    expect(store.all('SELECT * FROM fills').length).toBeGreaterThanOrEqual(2);
    expect(store.get("SELECT COUNT(*) AS n FROM orders WHERE status = 'cancelled' AND filled_qty <> '0'")!.n).toBe(1); // partial fill
    const datasetDir = join(cfg.recording.dir, id);
    expect(readManifest(datasetDir).segments.length).toBeGreaterThanOrEqual(2);
    expect([...readDataset(datasetDir)].length).toBeGreaterThan(10);

    // ---- replay into a separate experiment database ----
    const r = runReplay({
      sourceDbPath: cfg.storage.db,
      sourceSessionId: id,
      datasetDir,
      replayDbPath: join(dir, 'replay.db'),
      replayId: 'replay-xyz',
    });
    const rs = new TradingStore(join(dir, 'replay.db'));
    const a = journalHash(store, id);
    const b = journalHash(rs, r.replaySessionId);
    const diff = diffJournals(canonicalJournal(store, id), canonicalJournal(rs, r.replaySessionId));
    expect(diff).toBeNull();
    expect(b.hash).toBe(a.hash);
    expect(r.replaySessionId).not.toBe(id); // run metadata differs, canonical content does not
    // Replay never touched the live session's database.
    expect(store.all("SELECT * FROM sessions WHERE id = 'replay-xyz'")).toHaveLength(0);
    rs.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a corrupted segment is rejected rather than silently replayed', async () => {
    const { writeFileSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'jb-corrupt-'));
    const rec = new Recorder(dir, 'ds', null, 1000, false);
    rec.append({ kind: 'tick', ordinal: 1, receiptTime: T0 });
    rec.append({ kind: 'tick', ordinal: 2, receiptTime: T0 + 1 });
    rec.close();
    const m = readManifest(join(dir, 'ds'));
    writeFileSync(join(dir, 'ds', m.segments[0]!.file), 'tampered');
    expect(() => [...readDataset(join(dir, 'ds'))]).toThrow(/hash mismatch/);
    rmSync(dir, { recursive: true, force: true });
  });
});
