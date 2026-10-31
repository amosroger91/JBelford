/**
 * Starts the dashboard against a temporary database containing a deterministic
 * FIXTURE session (synthetic events; never presented as a live run).
 * Used by Playwright only.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MarketEvent } from '../../src/paper/domain';
import { PaperRuntime } from '../../src/paper/runtime';
import { TradingService } from '../../src/paper/service';
import { TradingStore } from '../../src/paper/store';
import { startWeb } from '../../src/paper/web/server';
import { PRODUCT, ScriptedStrategy, T0, testConfig } from '../paper/harness';

const dir = mkdtempSync(join(tmpdir(), 'jb-e2e-'));
const db = join(dir, 'fixture.db');
const cfg = testConfig(
  { storage: { db }, purpose: 'E2E fixture <img src=x onerror=alert(1)> <script>alert("xss")</script>' },
  join(dir, 'rec'),
);
const store = new TradingStore(db);
const svc = new TradingService(store);
function buildSession(id: string): void {
  const sid = svc.createSession(cfg, PRODUCT, { kind: 'forward', now: T0, id });
  const strat = new ScriptedStrategy();
  const rt = new PaperRuntime(store, cfg, sid, PRODUCT, { mode: 'forward', strategy: strat, recorder: null });
  let t = T0;
  let seq = 0;
  const ev = (e: Omit<MarketEvent, 'ordinal' | 'receiptTime'>) => rt.ingest({ ...(e as MarketEvent), ordinal: 0, receiptTime: t });
  ev({ kind: 'lifecycle', state: 'started' } as never);
  ev({ kind: 'connection', epoch: 1, state: 'open' } as never);
  ev({
    kind: 'book_snapshot',
    epoch: 1,
    seq: seq++,
    exchangeTime: t,
    bids: [{ price: '79999', qty: '3' }],
    asks: [{ price: '80000', qty: '3' }],
  } as never);
  for (let i = 0; i < 4; i++) {
    strat.target = i % 2 === 0 ? 0.05 : 0;
    const start = Math.floor(t / 300_000) * 300_000;
    ev({
      kind: 'trade',
      epoch: 1,
      seq: seq++,
      exchangeTime: start + 1000,
      tradeId: `x${i}`,
      price: '80000',
      size: '0.1',
      venueSide: 'BUY',
    } as never);
    t = start + 302_000;
    ev({ kind: 'book_update', epoch: 1, seq: seq++, exchangeTime: t, changes: [{ side: 'bid', price: '79999', qty: '3' }] } as never);
    t += 1000;
    ev({ kind: 'book_update', epoch: 1, seq: seq++, exchangeTime: t, changes: [{ side: 'ask', price: '80000', qty: '3' }] } as never);
    t += 60_000;
    ev({ kind: 'tick' } as never);
  }
  rt.finish();
}
// One session per Playwright project so control tests are independent of run order.
buildSession('fixture-desktop');
buildSession('fixture-mobile');
store.close();

const port = Number(process.env.E2E_PORT ?? 8799);
const token = process.env.E2E_TOKEN ?? 'e2e0123456789abcdef0123456789abcdef0123456789ab';
await startWeb({ dbPath: db, port, token, allowStart: false, quiet: true });
console.log(`fixture dashboard ready on ${port}`);
