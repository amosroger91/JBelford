import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeMessage, parseTime, type NormalizeState } from '../../../src/paper/market/coinbase';
import { OrderBook } from '../../../src/paper/market/book';
import { BarBuilder } from '../../../src/paper/features';
import { dec, str } from '../../../src/paper/money';
import type { MarketEvent } from '../../../src/paper/domain';
import { T0, started } from '../harness';

const FIXTURE = join(import.meta.dirname, '..', '..', 'fixtures', 'coinbase', 'ws-capture-2026-10-31.jsonl');
const capture = readFileSync(FIXTURE, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { recv: number; msg: Record<string, unknown> });

describe('8. Coinbase feed contract (recorded live messages, 2026-10-31)', () => {
  it('normalizes the real capture: one snapshot, contiguous per-socket sequence, decimal strings preserved', () => {
    const st: NormalizeState = { epoch: 1, lastSeq: -1, duplicates: 0 };
    const events = capture.flatMap((c) => normalizeMessage(c.msg, c.recv, st));
    expect(events.filter((e) => e.kind === 'seq_gap')).toEqual([]);
    const snap = events.find((e) => e.kind === 'book_snapshot') as Extract<MarketEvent, { kind: 'book_snapshot' }>;
    expect(snap.bids.length).toBeGreaterThan(10);
    expect(snap.asks.length).toBeGreaterThan(10);
    expect(snap.bids[0]!.price).toMatch(/^\d+(\.\d+)?$/); // exact string, no float conversion
    expect(events.some((e) => e.kind === 'book_update')).toBe(true);
    expect(events.some((e) => e.kind === 'trade')).toBe(true);
    expect(events.some((e) => e.kind === 'heartbeat')).toBe(true);
    const book = new OrderBook();
    book.loadSnapshot(snap.bids, snap.asks);
    for (const e of events) if (e.kind === 'book_update') for (const c of e.changes) book.set(c.side, dec(c.price), dec(c.qty));
    expect(book.crossed()).toBe(false);
  });

  it('parses nanosecond timestamps to milliseconds', () => {
    expect(parseTime('2026-10-31T09:20:29.61147298Z')).toBe(Date.UTC(2026, 9, 31, 9, 20, 29, 611));
  });

  it('applies new_quantity as an ABSOLUTE size and removes a level at zero', () => {
    const b = new OrderBook();
    b.loadSnapshot([{ price: '100', qty: '0.5' }], [{ price: '101', qty: '1' }]);
    b.set('bid', dec('100'), dec('0.2'));
    expect(str(b.bestBid()!.qty)).toBe('0.2'); // not 0.7
    b.set('bid', dec('100.5'), dec('0.1'));
    expect(str(b.bestBid()!.price)).toBe('100.5');
    b.set('bid', dec('100.5'), dec('0'));
    expect(str(b.bestBid()!.price)).toBe('100');
    expect(b.depthCount().bids).toBe(1);
  });

  it('detects gaps per socket, drops duplicates, and never compares counters across reconnect epochs', () => {
    const msg = (seq: number) => ({
      channel: 'heartbeats',
      timestamp: '2026-10-31T09:20:29.9Z',
      sequence_num: seq,
      events: [{ heartbeat_counter: seq, current_time: '' }],
    });
    const a: NormalizeState = { epoch: 1, lastSeq: -1, duplicates: 0 };
    normalizeMessage(msg(0), T0, a);
    normalizeMessage(msg(1), T0, a);
    expect(normalizeMessage(msg(1), T0, a)).toEqual([]); // duplicate
    expect(a.duplicates).toBe(1);
    const gap = normalizeMessage(msg(5), T0, a);
    expect(gap[0]).toMatchObject({ kind: 'seq_gap', expected: 2, got: 5 });
    // A new socket (new epoch) starts its own counter at 0: no false gap.
    const b: NormalizeState = { epoch: 2, lastSeq: -1, duplicates: 0 };
    expect(normalizeMessage(msg(0), T0, b)[0]!.kind).toBe('heartbeat');
  });

  it('keeps the venue trade side as a label only; bars do not depend on it', () => {
    const x = new BarBuilder();
    const y = new BarBuilder();
    x.onTrade('1', '100', '1', T0 + 1000);
    y.onTrade('1', '100', '1', T0 + 1000);
    // (venue side is not an input to BarBuilder at all)
    expect(x.advance(T0 + 400_000)).toEqual(y.advance(T0 + 400_000));
  });

  it('a crossed book or sequence gap invalidates the book and blocks trading until resynchronized', () => {
    const h = started();
    h.snapshot([['100', '1']], [['101', '1']]);
    expect(h.rt.snapshotStatus().feed).toBe('healthy');
    h.update('bid', '102', '1'); // crosses the ask
    expect(h.rt.snapshotStatus().feed).toBe('gap');
    expect(h.rt.book.synced).toBe(false);
    h.snapshot([['100', '1']], [['101', '1']], 2);
    expect(h.rt.snapshotStatus().feed).toBe('healthy');
    h.ev({ kind: 'seq_gap', epoch: 2, expected: 10, got: 12 } as MarketEvent);
    expect(h.rt.snapshotStatus().feed).toBe('gap');
    expect(h.store.all('SELECT * FROM observation_gaps').length).toBeGreaterThanOrEqual(2);
  });
});

describe('9. causal bars: no incomplete, future or revised values in a snapshot', () => {
  it('an in-progress bar never appears; a completed bar is immutable; late trades are counted, not merged', () => {
    const b = new BarBuilder(300_000, 2_000);
    b.onTrade('a', '100', '1', T0 + 10_000);
    b.onTrade('b', '105', '1', T0 + 200_000);
    expect(b.advance(T0 + 300_000)).toEqual([]); // end reached but grace not elapsed
    expect(b.completed()).toEqual([]);
    const done = b.advance(T0 + 302_000);
    expect(done).toEqual([{ start: T0, open: '100', high: '105', low: '100', close: '105', volume: '2' }]);
    b.onTrade('late', '999', '5', T0 + 250_000); // belongs to the completed bucket
    expect(b.lateTrades).toBe(1);
    expect(b.completed()[0]!.high).toBe('105');
    b.onTrade('future', '200', '1', T0 + 310_000); // next bucket, not complete yet
    expect(b.completed()).toHaveLength(1);
  });

  it('the decision snapshot contains only completed bars', () => {
    const h = started();
    h.snapshot([['79999', '1']], [['80000', '1']]);
    h.trade('80000', '0.1', T0 + 1000);
    h.trade('80100', '0.1', T0 + 301_000); // next bucket in progress
    h.t = T0 + 302_500;
    h.update('bid', '1', '0');
    const strat = (h.rt as unknown as { o: { strategy: { calls: { bars: { start: number }[] }[] } } }).o.strategy;
    const last = strat.calls.at(-1)!;
    expect(last.bars.map((x) => x.start)).toEqual([T0]);
  });
});
