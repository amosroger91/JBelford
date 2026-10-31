import { describe, expect, it } from 'vitest';
import type { MarketEvent } from '../../../src/paper/domain';
import { str } from '../../../src/paper/money';
import { PaperRuntime } from '../../../src/paper/runtime';
import { PRODUCT, ScriptedStrategy, harness, started, testConfig } from '../harness';
import { TradingStore } from '../../../src/paper/store';

describe('10. no fill before decision completion + arrival; none during an outage', () => {
  it('fills only on a book state received at or after the simulated arrival time', () => {
    const strat = new ScriptedStrategy();
    const h = started({ strategy: strat });
    h.snapshot([['79999', '5']], [['80000', '5']]);
    strat.target = 0.2;
    h.completeBar();
    const o = h.rt.ledger.openOrders(h.sessionId)[0]!;
    expect(o.arrivalAt - o.submittedAt).toBe(750);
    h.t += 500;
    h.update('ask', '80000', '5'); // before arrival
    expect(h.store.all('SELECT * FROM fills')).toHaveLength(0);
    h.t += 300;
    h.update('ask', '80000.5', '5'); // after arrival
    const fills = h.store.all('SELECT * FROM fills');
    expect(fills).toHaveLength(1);
    expect(fills[0]!.time as number).toBeGreaterThanOrEqual(o.arrivalAt);
  });

  it('waits through a disconnect and expires the order instead of inventing an outage fill', () => {
    const strat = new ScriptedStrategy();
    const h = started({ strategy: strat });
    h.snapshot([['79999', '5']], [['80000', '5']]);
    strat.target = 0.2;
    h.completeBar();
    h.ev({ kind: 'connection', epoch: 1, state: 'closed' } as MarketEvent);
    h.t += 1000;
    h.tick(0);
    expect(h.store.all('SELECT * FROM fills')).toHaveLength(0);
    h.t += 70_000; // past validUntil while still disconnected
    h.tick(0);
    const o = h.store.get('SELECT status, reject_reason FROM orders')!;
    expect(o.status).toBe('expired');
    expect(h.store.all('SELECT * FROM fills')).toHaveLength(0);
    expect(h.rt.ledger.verify(h.sessionId)).toEqual([]);
  });

  it('stale feed (no data within staleMs) blocks new orders', () => {
    const strat = new ScriptedStrategy();
    const h = started({ strategy: strat });
    h.snapshot([['79999', '5']], [['80000', '5']]);
    h.t += 6000;
    h.tick(0);
    expect(h.rt.snapshotStatus().feed).toBe('stale');
    strat.target = 0.2;
    const barStart = Math.floor(h.t / 300_000) * 300_000;
    h.trade('80000', '0.1', barStart + 1);
    h.t = barStart + 302_000;
    h.tick(0);
    expect(h.store.all('SELECT * FROM orders')).toHaveLength(0);
    expect(h.store.get("SELECT detail FROM risk_events WHERE check_name = 'feed'")!.detail).toMatch(/stale/);
  });
});

describe('12. pause / stop / restart never flatten holdings or duplicate orders', () => {
  it('pause during a pending order cancels it, keeps inventory, and restart creates nothing new', () => {
    const strat = new ScriptedStrategy();
    const h = started({ strategy: strat });
    h.snapshot([['79999', '5']], [['80000', '5']]);
    strat.target = 0.2;
    h.completeBar();
    h.t += 1000;
    h.update('ask', '80000', '5'); // first order fills
    const btcAfterFill = h.rt.ledger.balances(h.sessionId).btcAvailable;
    expect(btcAfterFill > 0n).toBe(true);
    strat.target = 0.2;
    h.completeBar(); // second order pending (arrival in future)
    expect(h.rt.ledger.openOrders(h.sessionId)).toHaveLength(1);
    h.ev({ kind: 'control', action: 'pause', requestId: 'r1' } as MarketEvent);
    expect(h.rt.ledger.openOrders(h.sessionId)).toHaveLength(0);
    expect(h.rt.ledger.balances(h.sessionId).btcAvailable).toBe(btcAfterFill);
    expect(h.store.all("SELECT * FROM orders WHERE side = 'sell'")).toHaveLength(0);
    // "Restart": a new runtime over the same database.
    const rt2 = new PaperRuntime(h.store, h.cfg, h.sessionId, PRODUCT, { mode: 'forward', strategy: strat, recorder: null });
    rt2.ingest({ kind: 'lifecycle', ordinal: 0, receiptTime: h.t + 10_000, state: 'restarted' } as MarketEvent);
    expect(h.store.all('SELECT * FROM orders')).toHaveLength(2);
    expect(rt2.ledger.balances(h.sessionId).btcAvailable).toBe(btcAfterFill);
    expect(rt2.snapshotStatus().status).toBe('paused');
    expect(rt2.ledger.verify(h.sessionId)).toEqual([]);
  });

  it('stop cancels open orders and keeps holdings; flatten without healthy data is deferred, never priced', () => {
    const strat = new ScriptedStrategy();
    const h = started({ strategy: strat });
    h.snapshot([['79999', '5']], [['80000', '5']]);
    strat.target = 0.2;
    h.completeBar();
    h.t += 1000;
    h.update('ask', '80000', '5');
    const held = h.rt.ledger.balances(h.sessionId).btcAvailable;
    h.ev({ kind: 'connection', epoch: 1, state: 'closed' } as MarketEvent);
    h.ev({ kind: 'control', action: 'flatten', requestId: 'f1' } as MarketEvent);
    expect(h.store.get("SELECT kind FROM audit WHERE kind LIKE 'flatten%' ORDER BY id DESC")!.kind).toBe('flatten_deferred');
    expect(h.rt.ledger.balances(h.sessionId).btcAvailable).toBe(held);
    h.ev({ kind: 'control', action: 'stop', requestId: 's1' } as MarketEvent);
    expect(h.rt.snapshotStatus().status).toBe('stopped');
    expect(h.rt.ledger.balances(h.sessionId).btcAvailable).toBe(held);
  });

  it('explicit flatten with healthy data sells at the bid as a separately recorded simulated liquidation', () => {
    const strat = new ScriptedStrategy();
    const h = started({ strategy: strat });
    h.snapshot([['79999', '5']], [['80000', '5']]);
    strat.target = 0.2;
    h.completeBar();
    h.t += 1000;
    h.update('ask', '80000', '5');
    h.ev({ kind: 'control', action: 'flatten', requestId: 'f2' } as MarketEvent);
    h.t += 1000;
    h.update('bid', '79999', '5');
    const sell = h.store.get("SELECT purpose, status, filled_qty FROM orders WHERE side = 'sell'")!;
    expect(sell).toMatchObject({ purpose: 'flatten', status: 'filled' });
    expect(str(h.rt.ledger.balances(h.sessionId).btcAvailable)).toBe('0');
  });
});

describe('daily loss and drawdown pause new risk but keep holdings', () => {
  it('blocks buys after the UTC-day loss limit', () => {
    const cfg = testConfig({ risk: { dailyLossPausePct: '0.0001' } });
    const strat = new ScriptedStrategy();
    const h = started({ cfg, strategy: strat });
    h.snapshot([['79999', '5']], [['80000', '5']]);
    h.tick(60_000); // valuation sets day-start equity
    strat.target = 0.05;
    h.completeBar();
    h.t += 1000;
    h.update('ask', '80000', '5'); // buy: fees reduce equity below the tiny limit
    h.tick(60_000);
    strat.target = 0.2;
    h.completeBar();
    expect(h.store.get("SELECT passed, detail FROM risk_events WHERE check_name = 'daily_loss' ORDER BY id DESC")).toMatchObject({
      passed: 0,
    });
  });
});

describe('regression: deterministic order ids are scoped to their session', () => {
  it('two sessions in one database deciding on the same bar both trade independently', () => {
    const store = new TradingStore(':memory:');
    const results = [0, 1].map(() => {
      const strat = new ScriptedStrategy();
      return { h: harness({ store, strategy: strat }), strat };
    });
    for (const { h, strat } of results) {
      h.ev({ kind: 'lifecycle', state: 'started' } as MarketEvent);
      h.snapshot([['79999', '5']], [['80000', '5']]);
      strat.target = 0.2;
      h.completeBar();
      h.t += 1000;
      h.update('ask', '80000', '5');
    }
    const [a, b] = results.map((r) => r.h.sessionId);
    expect(a).not.toBe(b);
    for (const s of [a!, b!]) {
      expect(store.all('SELECT * FROM fills WHERE session_id = ?', s)).toHaveLength(1);
      expect(results[0]!.h.rt.ledger.verify(s)).toEqual([]);
    }
    expect(store.get('SELECT COUNT(DISTINCT order_id) AS n FROM orders')!.n).toBe(1); // same deterministic id, different sessions
  });
});
