import { describe, expect, it } from 'vitest';
import { TradingEngine } from '../src/exec/engine';
import { PaperAdapter } from '../src/exec/paperAdapter';
import { GuardedAdapter } from '../src/exec/guardedAdapter';
import { RiskEngine } from '../src/risk/engine';
import { MomentumStrategy, type PreparedSeries, type Signal } from '../src/strategy/momentum';
import type { Candle } from '../src/core/types';
import type { Store } from '../src/persistence/store';
import { FEES, MARKET, PARAMS, memStore, T0 } from './helpers';

/** Strategy whose entry signal the test controls; exits use the real levels. */
class StubStrategy extends MomentumStrategy {
  enter = false;
  override prepare(): PreparedSeries {
    return {} as PreparedSeries;
  }
  override signalAt(): Signal {
    return { enter: this.enter, reasons: this.enter ? [] : ['stub'], metrics: {} };
  }
}

function harness(opts: { store?: Store; faults?: { ambiguousCreateRate: number; rejectRate: number }; seed?: number; now?: number } = {}) {
  const clock = { now: opts.now ?? T0 + 3_600_000 };
  const store = opts.store ?? memStore();
  const risk = new RiskEngine(store);
  const paper = new PaperAdapter(store, {
    startingUsd: 50,
    fees: FEES,
    takerSlippageBps: 5,
    market: MARKET,
    faults: opts.faults,
    seed: opts.seed,
    now: () => clock.now,
  });
  let bid = 77000;
  const guarded = new GuardedAdapter(paper, risk, store, () => bid, () => clock.now);
  const strategy = new StubStrategy(PARAMS, FEES);
  let killed = false;
  const engine = new TradingEngine(store, risk, guarded, strategy, { fees: FEES, spreadBps: 1, takerSlippageBps: 5 }, {
    mode: 'paper',
    ambiguousGraceMs: 0,
    sizeFraction: 0.98,
    balanceSnapshotMs: 60_000,
    now: () => clock.now,
    killSwitch: () => killed,
  });
  const candles: Candle[] = [];
  const h = {
    store,
    risk,
    paper,
    engine,
    strategy,
    clock,
    kill: () => (killed = true),
    book(b: number, a = b + 0.1) {
      bid = b;
      const q = { bid: b, ask: a, ts: clock.now };
      paper.onBook(q);
      engine.onBook(q);
    },
    newBar() {
      const ts = Math.floor(clock.now / 60_000) * 60_000 - 60_000;
      if (candles.at(-1)?.ts !== ts) candles.push({ ts, open: bid, high: bid, low: bid, close: bid, volume: 1 });
      engine.onCandles([...candles]);
    },
    advance(ms: number) {
      clock.now += ms;
    },
    async tick() {
      h.newBar();
      await engine.tick();
    },
    async enterAndFill(price = 77000) {
      h.book(price);
      strategy.enter = true;
      await h.tick();
      strategy.enter = false;
      const entry = store.openOrders().find((o) => o.purpose === 'entry');
      expect(entry, 'entry order placed').toBeDefined();
      h.advance(1000);
      paper.onPrint(price - 1, clock.now);
      await h.tick(); // sync fill -> position; places take-profit
      return entry!;
    },
  };
  return h;
}

describe('TradingEngine (paper) lifecycle', () => {
  it('enters with a post-only bid, rests a take-profit, and books a winning trade net of fees', async () => {
    const h = harness();
    const entry = await h.enterAndFill(77000);
    expect(entry).toMatchObject({ side: 'buy', type: 'limit', postOnly: true, price: 77000 });
    expect(entry.amount * 77000).toBeLessThanOrEqual(10);
    const pos = h.store.openPosition()!;
    expect(pos.takeProfitPrice).toBeCloseTo(77770, 6);
    expect(pos.stopPrice).toBeCloseTo(76615, 6);
    const tp = h.store.openOrders().find((o) => o.purpose === 'take_profit')!;
    expect(tp).toMatchObject({ side: 'sell', postOnly: true });
    expect(tp.price).toBeCloseTo(77770, 1);

    h.advance(60_000);
    h.book(77800);
    await h.tick();
    expect(h.store.openPosition()).toBeUndefined();
    const t = h.store.recentTrades(1)[0]!;
    expect(t.exitReason).toBe('take_profit');
    const gross = t.amount * (77770 - 77000);
    expect(t.grossPnl).toBeCloseTo(gross, 2);
    expect(t.netPnl).toBeCloseTo(gross - t.amount * 77000 * 0.004 - t.amount * 77770 * 0.004, 6);
    expect(t.netPnl).toBeGreaterThan(0);
  });

  it('exits at market on the stop and records the loss including taker fee', async () => {
    const h = harness();
    await h.enterAndFill(77000);
    h.advance(60_000);
    h.book(76600);
    await h.tick();
    expect(h.store.openPosition()).toBeUndefined();
    const t = h.store.recentTrades(1)[0]!;
    expect(t.exitReason).toBe('stop_loss');
    expect(t.exitPrice).toBeCloseTo(76600 * (1 - 0.0005), 4);
    expect(t.exitFee).toBeCloseTo(t.amount * t.exitPrice * 0.008, 8);
    expect(t.netPnl).toBeLessThan(0);
    expect(h.store.openOrders()).toHaveLength(0);
  });

  it('cancels an unfilled entry after the timeout (non-fill)', async () => {
    const h = harness();
    h.book(77000);
    h.strategy.enter = true;
    await h.tick();
    h.strategy.enter = false;
    h.advance(61_000);
    h.book(77010);
    await h.tick();
    expect(h.store.openOrders()).toHaveLength(0);
    expect(h.store.openPosition()).toBeUndefined();
    expect(h.store.recentOrders(1)[0]!.status).toBe('canceled');
    expect(h.engine.phase()).toBe('FLAT');
  });

  it('exits after max hold time', async () => {
    const h = harness();
    await h.enterAndFill(77000);
    h.advance(PARAMS.maxHoldMinutes * 60_000);
    h.book(77100);
    await h.tick();
    expect(h.store.recentTrades(1)[0]!.exitReason).toBe('max_hold');
  });

  it('does not enter on stale market data', async () => {
    const h = harness();
    h.book(77000);
    h.advance(20_000); // book is now 20s old
    h.strategy.enter = true;
    await h.tick();
    expect(h.store.recentOrders()).toHaveLength(0);
  });

  it('reconciles an ambiguous create that DID reach the exchange without sending a duplicate', async () => {
    // seed chosen so the first create is "ambiguous_created"
    let seed = 0;
    for (; seed < 200; seed++) {
      const h = harness({ faults: { ambiguousCreateRate: 1, rejectRate: 0 }, seed });
      h.book(77000);
      h.strategy.enter = true;
      await h.tick();
      const o = h.store.recentOrders(1)[0]!;
      if ((await h.paper.fetchOrderByClientId(o.clientOrderId)) !== null) break;
    }
    const h = harness({ faults: { ambiguousCreateRate: 1, rejectRate: 0 }, seed });
    h.book(77000);
    h.strategy.enter = true;
    await h.tick();
    expect(h.store.recentOrders(1)[0]!.status).toBe('unknown');
    expect(h.engine.isStateCertain()).toBe(false);
    h.advance(1000);
    await h.tick(); // reconcile
    expect(h.engine.isStateCertain()).toBe(true);
    const orders = h.store.recentOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]!.status).toBe('open');
    expect((await h.paper.fetchOpenOrders()).length).toBe(1);
  });

  it('marks an ambiguous create that never reached the exchange as not placed', async () => {
    let seed = 0;
    for (; seed < 200; seed++) {
      const h = harness({ faults: { ambiguousCreateRate: 1, rejectRate: 0 }, seed });
      h.book(77000);
      h.strategy.enter = true;
      await h.tick();
      const o = h.store.recentOrders(1)[0]!;
      if ((await h.paper.fetchOrderByClientId(o.clientOrderId)) === null) break;
    }
    const h = harness({ faults: { ambiguousCreateRate: 1, rejectRate: 0 }, seed });
    h.book(77000);
    h.strategy.enter = true;
    await h.tick();
    h.strategy.enter = false;
    h.advance(1000);
    await h.tick();
    expect(h.engine.isStateCertain()).toBe(true);
    expect(h.store.recentOrders(1)[0]!.status).toBe('rejected');
    expect(h.store.openOrders()).toHaveLength(0);
  });

  it('recovers an open position after a restart and still enforces the stop', async () => {
    const store = memStore();
    const a = harness({ store });
    await a.enterAndFill(77000);
    const now = a.clock.now;
    // "crash": new engine, new paper adapter instance, same database
    const b = harness({ store, now: now + 30_000 });
    b.book(77050);
    await b.tick();
    expect(b.engine.isStateCertain()).toBe(true);
    expect(b.store.openPosition()).toBeDefined();
    expect(b.store.openOrders().filter((o) => o.purpose === 'take_profit')).toHaveLength(1);
    b.advance(60_000);
    b.book(76500);
    await b.tick();
    expect(b.store.recentTrades(1)[0]!.exitReason).toBe('stop_loss');
  });

  it('kill switch cancels orders, flattens, halts and stops', async () => {
    const h = harness();
    await h.enterAndFill(77000);
    h.kill();
    h.advance(1000);
    h.book(77010);
    await h.tick();
    expect(h.engine.isStopped()).toBe(true);
    expect(h.store.openPosition()).toBeUndefined();
    expect(h.store.openOrders()).toHaveLength(0);
    expect(h.store.recentTrades(1)[0]!.exitReason).toBe('kill_switch');
    expect(h.risk.activeHalt(h.clock.now)?.kind).toBe('manual_reset');
    expect((await h.paper.fetchBalance()).btc).toBeCloseTo(0, 12);
  });

  it('three consecutive stop-outs shut trading down', async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) {
      await h.enterAndFill(77000);
      h.advance(60_000);
      h.book(76500);
      await h.tick();
      h.advance(5 * 60_000 + 1000);
    }
    expect(h.store.recentTrades(5)).toHaveLength(3);
    expect(h.risk.activeHalt(h.clock.now)?.kind).toBe('manual_reset');
    h.book(77000);
    h.strategy.enter = true;
    await h.tick();
    expect(h.store.openOrders()).toHaveLength(0);
  });

  it('halts when the exchange balance does not match tracked state', async () => {
    const store = memStore();
    const h = harness({ store });
    h.book(77000);
    await h.tick(); // first reconcile sets baseline BTC = 0
    expect(h.engine.isStateCertain()).toBe(true);
    // Simulate BTC appearing out of nowhere (e.g. manual trade on the account)
    const st = store.getKv<{ balance: { usd: number; btc: number } }>('paper.state')!;
    st.balance.btc = 0.001;
    store.setKv('paper.state', st);
    const h2 = harness({ store, now: h.clock.now + 1000 });
    h2.book(77000);
    await h2.tick();
    expect(h2.engine.isStateCertain()).toBe(false);
    expect(h2.risk.activeHalt(h2.clock.now)?.reason).toMatch(/balance/);
  });

  it('never places more than one entry while one is working', async () => {
    const h = harness();
    h.book(77000);
    h.strategy.enter = true;
    for (let i = 0; i < 5; i++) {
      await h.tick();
      h.advance(10_000);
      h.book(77000);
    }
    expect(h.store.recentOrders().filter((o) => o.purpose === 'entry')).toHaveLength(1);
  });
});
