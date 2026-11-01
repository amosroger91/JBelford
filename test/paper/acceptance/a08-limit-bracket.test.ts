import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BracketSpec, Candle, MarketEvent } from '../../../src/paper/domain';
import { PaperBroker } from '../../../src/paper/execution/paper';
import { OrderBook } from '../../../src/paper/market/book';
import { applyDiff, applySnapshot, normalizeBinanceUs, type DepthSyncState } from '../../../src/paper/market/binanceus';
import { dec, str } from '../../../src/paper/money';
import { ruleFor } from '../../../src/paper/strategies/rules';
import { FAMILIES, type Series } from '../../../src/paper/research/bracket';
import { canonicalJournal, diffJournals, journalHash } from '../../../src/paper/evaluation/canonical';
import { Recorder } from '../../../src/paper/market/recorder';
import { PaperRuntime } from '../../../src/paper/runtime';
import { TradingService, runReplay } from '../../../src/paper/service';
import { TradingStore } from '../../../src/paper/store';
import { PRODUCT, ScriptedStrategy, T0, started, testConfig } from '../harness';

const SPEC: BracketSpec = { entryOffsetBps: 0, entryValidMs: 30 * 60_000, tpPct: '1.5', slPct: '3', maxHoldMs: 6 * 3_600_000 };
const binanceCfg = (over: Record<string, unknown> = {}, dir?: string) =>
  testConfig(
    {
      venue: 'binanceus',
      fees: { takerRate: '0.002', makerRate: '0.0005' },
      risk: { maxOrderPctEquity: '0.20', maxOpenOrders: 2, minTouchDepthUsd: '1' },
      ...over,
    },
    dir,
  );

function bracketHarness(over: Record<string, unknown> = {}) {
  const strat = new ScriptedStrategy();
  strat.bracket = SPEC;
  const h = started({ cfg: binanceCfg(over), strategy: strat });
  h.snapshot([['79999', '5']], [['80000', '5']]);
  return { h, strat };
}

/** Enter: signal on a venue bar, activate after the delay, then fill via a trade-through and a book cross. */
function enter(h: ReturnType<typeof bracketHarness>['h'], strat: ScriptedStrategy) {
  strat.target = 1;
  h.venueBar('80000');
  strat.target = 'hold';
  h.t += 1000;
  h.update('ask', '80000', '5'); // activation after 750ms arrival delay
  h.trade('79999', '1'); // touch only: no fill
  h.trade('79998.5', '0.01'); // trades through: partial fill 0.01
  // the market moves through our level: bids fall away, an ask prints below our bid -> remainder fills
  h.update('bid', '79997', '5');
  h.update('bid', '79999', '0');
  h.update('ask', '79998', '5');
  // then recovers to the original book
  h.update('ask', '79998', '0');
  h.update('bid', '79999', '5');
}

describe('limit fill model (limit-trade-through-v1)', () => {
  const broker = new PaperBroker({
    takerRate: dec('0.002'),
    makerRate: dec('0.0005'),
    participation: dec('1'),
    guardBps: 50,
    baseIncrement: dec('0.00000001'),
    baseMinSize: dec('0.00000001'),
  });
  const book = new OrderBook();
  book.loadSnapshot([{ price: '99', qty: '1' }], [{ price: '101', qty: '1' }]);
  const o = {
    orderId: 'o',
    sessionId: 's',
    side: 'buy' as const,
    limit: dec('100'),
    remaining: dec('2'),
    priorFills: 0,
    time: T0,
    ordinal: 1,
  };

  it('rejects post-only orders that would take liquidity', () => {
    expect(broker.postOnlyViolation(book, 'buy', dec('101'))).toMatch(/would take/);
    expect(broker.postOnlyViolation(book, 'sell', dec('99'))).toMatch(/would take/);
    expect(broker.postOnlyViolation(book, 'buy', dec('100'))).toBeNull();
  });
  it('a touch is not a fill; a trade-through fills only up to the printed size, at the limit, with the maker fee', () => {
    expect(broker.onTradeForLimit(o, dec('100'), dec('5'))).toBeNull();
    expect(broker.onTradeForLimit(o, dec('99.99'), dec('0.4'))).toMatchObject({
      price: '100',
      qty: '0.4',
      fee: '0.02',
      liquidity: 'maker',
    });
  });
  it('the book moving through the level fills the remainder', () => {
    const crossed = new OrderBook();
    crossed.loadSnapshot([{ price: '98', qty: '1' }], [{ price: '99.5', qty: '1' }]);
    expect(broker.onBookForLimit(crossed, o)).toMatchObject({ price: '100', qty: '2' });
  });
});

describe('bracket lifecycle (paper engine)', () => {
  it('limit entry -> resting take-profit -> maker exit; P&L matches a hand calculation', () => {
    const { h, strat } = bracketHarness();
    enter(h, strat);
    const entry = h.store.get("SELECT order_type, post_only, limit_price, filled_qty, status FROM orders WHERE purpose = 'strategy'")!;
    expect(entry).toMatchObject({ order_type: 'limit', post_only: 1, limit_price: '79999', filled_qty: '0.025', status: 'filled' });
    // take-profit: ceil(79999 * 1.015, 0.01) = 81198.99
    h.t += 1000;
    h.update('bid', '79999', '5'); // activates the take-profit
    const tp = h.store.get("SELECT order_type, limit_price, qty FROM orders WHERE purpose = 'take_profit'")!;
    expect(tp).toMatchObject({ order_type: 'limit', limit_price: '81198.99', qty: '0.025' });
    h.trade('81199', '1'); // trades through the target
    const bracket = h.store.get('SELECT status, exit_reason FROM brackets')!;
    expect(bracket).toMatchObject({ status: 'closed', exit_reason: 'take_profit' });
    const bal = h.rt.ledger.balances(h.sessionId);
    // entry fees 0.399995 + 0.5999925 ; exit 2029.97475 * 0.0005 = 1.014987375 -> 1.01498738
    expect(str(bal.realizedPnl)).toBe('27.98477512');
    expect(str(bal.btcAvailable + bal.btcReserved)).toBe('0');
    expect(h.rt.ledger.verify(h.sessionId)).toEqual([]);
  });

  it('stop: cancels the take-profit and exits at market with the taker fee', () => {
    const { h, strat } = bracketHarness();
    enter(h, strat);
    h.t += 1000;
    h.update('bid', '79999', '5');
    // stop = floor(79999 * 0.97, 0.01) = 77599.03; market drops through it
    h.snapshot([['77599', '5']], [['77600', '5']], 2);
    h.t += 1000;
    h.update('bid', '77599', '5'); // exit order arrives after the delay
    const b = h.store.get('SELECT status, exit_reason FROM brackets')!;
    expect(b).toMatchObject({ status: 'closed', exit_reason: 'stop' });
    expect(h.store.get("SELECT status FROM orders WHERE purpose = 'take_profit'")!.status).toBe('cancelled');
    const exit = h.store.get(
      "SELECT f.price, f.qty, f.fee FROM fills f JOIN orders o ON o.order_id = f.order_id WHERE o.purpose = 'stop'",
    )!;
    expect(exit).toMatchObject({ price: '77599', qty: '0.025' });
    expect(exit.fee).toBe(str((dec('0.025') * dec('77599') * dec('0.002')) / 10n ** 24n)); // taker, exact here
    expect(h.rt.ledger.verify(h.sessionId)).toEqual([]);
  });

  it('max hold: exits at market after the holding limit', () => {
    const { h, strat } = bracketHarness();
    enter(h, strat);
    for (let i = 0; i < 7; i++) h.freshTick(3_600_000, 'bid', '79999', '5');
    h.t += 1000;
    h.update('bid', '79999', '5');
    expect(h.store.get('SELECT status, exit_reason FROM brackets')).toMatchObject({ status: 'closed', exit_reason: 'max_hold' });
  });

  it('an unfilled entry expires, releases its reservation and closes the bracket', () => {
    const { h, strat } = bracketHarness();
    strat.target = 1;
    h.venueBar('80000');
    strat.target = 'hold';
    for (let i = 0; i < 4; i++) h.freshTick(10 * 60_000, 'ask', '80000', '5');
    expect(h.store.get("SELECT status FROM orders WHERE purpose = 'strategy'")!.status).toBe('expired');
    expect(h.store.get('SELECT status, exit_reason FROM brackets')!.status).toBe('closed');
    expect(str(h.rt.ledger.balances(h.sessionId).usdReserved)).toBe('0');
  });

  it('a partially filled entry expires: the fill stands, the rest is released, the take-profit covers the fill', () => {
    const { h, strat } = bracketHarness();
    strat.target = 1;
    h.venueBar('80000');
    strat.target = 'hold';
    h.t += 1000;
    h.update('ask', '80000', '5');
    h.trade('79998.5', '0.01');
    for (let i = 0; i < 4; i++) h.freshTick(10 * 60_000, 'ask', '80000', '5');
    expect(h.store.get("SELECT status, filled_qty FROM orders WHERE purpose = 'strategy'")).toMatchObject({
      status: 'expired',
      filled_qty: '0.01',
    });
    expect(str(h.rt.ledger.balances(h.sessionId).usdReserved)).toBe('0');
    expect(h.store.get("SELECT qty, status FROM orders WHERE purpose = 'take_profit'")).toMatchObject({ qty: '0.01', status: 'accepted' });
    expect(h.rt.ledger.verify(h.sessionId)).toEqual([]);
  });

  it('only one bracket at a time; pause keeps inventory and resume re-arms the take-profit', () => {
    const { h, strat } = bracketHarness();
    enter(h, strat);
    h.t += 1000;
    h.update('bid', '79999', '5');
    strat.target = 1;
    h.venueBar('80000');
    strat.target = 'hold';
    expect(h.store.get("SELECT detail FROM risk_events WHERE check_name = 'bracket'")!.detail).toMatch(/already open/);
    h.ev({ kind: 'control', action: 'pause', requestId: 'p' } as MarketEvent);
    expect(h.store.get("SELECT status FROM orders WHERE purpose = 'take_profit'")!.status).toBe('cancelled');
    expect(str(h.rt.ledger.balances(h.sessionId).btcAvailable)).toBe('0.025');
    h.ev({ kind: 'control', action: 'resume', requestId: 'r' } as MarketEvent);
    h.t += 1000;
    h.update('bid', '79999', '5');
    expect(h.store.all("SELECT * FROM orders WHERE purpose = 'take_profit' AND status IN ('accepted','partially_filled')")).toHaveLength(1);
  });
});

describe('Binance.US depth sync', () => {
  it('drops covered diffs, requires the bridging diff, then strict continuity; a gap resets the book', () => {
    const st: DepthSyncState = { epoch: 1, snapshotId: null, lastU: null, buffer: [] };
    expect(applyDiff(st, { U: 95, u: 99, b: [], a: [], E: T0 }, T0)).toEqual([]); // buffered
    expect(applyDiff(st, { U: 100, u: 103, b: [['100.00000000', '1.00000000']], a: [], E: T0 }, T0)).toEqual([]);
    const evs = applySnapshot(st, { lastUpdateId: 101, bids: [['99.00', '1']], asks: [['101.00', '1']] }, T0);
    expect(evs.map((e) => e.kind)).toEqual(['book_snapshot', 'book_update']); // 95..99 dropped, 100..103 bridges 102
    expect((evs[1] as Extract<MarketEvent, { kind: 'book_update' }>).changes[0]).toEqual({ side: 'bid', price: '100', qty: '1' });
    expect(applyDiff(st, { U: 104, u: 105, b: [], a: [], E: T0 }, T0)[0]!.kind).toBe('book_update');
    expect(applyDiff(st, { U: 104, u: 105, b: [], a: [], E: T0 }, T0)).toEqual([]); // duplicate
    expect(applyDiff(st, { U: 107, u: 108, b: [], a: [], E: T0 }, T0)[0]).toMatchObject({ kind: 'seq_gap', expected: 106, got: 107 });
    expect(st.snapshotId).toBeNull();
  });

  it('real 6-minute capture: bridges the snapshot with no gaps, never crosses, emits one closed bar', () => {
    const lines = readFileSync(join(__dirname, '../../fixtures/binanceus/ws-capture-2026-10-31.jsonl'), 'utf8').trim().split('\n');
    const st: DepthSyncState = { epoch: 1, snapshotId: null, lastU: null, buffer: [] };
    const book = new OrderBook();
    const kinds: string[] = [];
    for (const line of lines) {
      const m = JSON.parse(line) as {
        recv: number;
        msg?: unknown;
        rest?: { lastUpdateId: number; bids: [string, string][]; asks: [string, string][] };
      };
      const evs = m.rest ? applySnapshot(st, m.rest, m.recv) : normalizeBinanceUs(m.msg, m.recv, st);
      for (const e of evs) {
        kinds.push(e.kind);
        if (e.kind === 'book_snapshot') book.loadSnapshot(e.bids, e.asks);
        if (e.kind === 'book_update') for (const c of e.changes) book.set(c.side, dec(c.price), dec(c.qty));
        if (e.kind === 'book_snapshot' || e.kind === 'book_update') expect(book.crossed()).toBe(false);
      }
    }
    expect(kinds).not.toContain('seq_gap');
    expect(kinds.filter((k) => k === 'book_snapshot')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'book_update').length).toBeGreaterThan(400);
    expect(kinds.filter((k) => k === 'bar')).toHaveLength(1);
  });

  it('emits venue bars only for CLOSED klines', () => {
    const st: DepthSyncState = { epoch: 1, snapshotId: null, lastU: null, buffer: [] };
    const k = (x: boolean) => ({
      stream: 'btcusd@kline_5m',
      data: { e: 'kline', k: { t: T0, o: '1.0', h: '2.0', l: '0.5', c: '1.5', v: '3.0', x } },
    });
    expect(normalizeBinanceUs(k(false), T0, st)).toEqual([]);
    expect(normalizeBinanceUs(k(true), T0, st)).toEqual([
      { kind: 'bar', ordinal: 0, receiptTime: T0, candle: { start: T0, open: '1', high: '2', low: '0.5', close: '1.5', volume: '3' } },
    ]);
  });
});

describe('capitulation strategy parity with research', () => {
  it('the live rule fires on exactly the bars the research signal fires on', () => {
    // synthetic fixture: quiet drift, then a 4% drop on a 6x volume spike, then a green bar
    const bars: Candle[] = [];
    let px = 80000;
    for (let i = 0; i < 400; i++) {
      const o = px;
      px = i >= 380 && i < 395 ? px * 0.9972 : px * (1 + 0.0001 * Math.sin(i));
      const c = i === 396 ? o * 1.002 : px;
      if (i === 396) px = c;
      bars.push({
        start: T0 + i * 300_000,
        open: String(o),
        high: String(Math.max(o, c)),
        low: String(Math.min(o, c)),
        close: String(c),
        volume: i >= 393 && i <= 396 ? '6' : '1',
      });
    }
    const s: Series = {
      t: new Float64Array(bars.map((b) => b.start)),
      o: new Float64Array(bars.map((b) => Number(b.open))),
      h: new Float64Array(bars.map((b) => Number(b.high))),
      l: new Float64Array(bars.map((b) => Number(b.low))),
      c: new Float64Array(bars.map((b) => Number(b.close))),
      v: new Float64Array(bars.map((b) => Number(b.volume))),
    };
    const p = { lookback: 48, dropPct: 3, volMult: 5 };
    const research = FAMILIES.capitulation!.signal(s, p, new Map());
    const live = ruleFor('capitulation');
    let fired = 0;
    for (let i = 300; i < bars.length; i++) {
      const out = live.rule(bars.slice(Math.max(0, i + 1 - 300), i + 1), { positionSince: null, weight: 0 }, { ...live.defaults, ...p });
      expect(!out.hold, `bar ${i}`).toBe(research[i] === 1);
      if (!out.hold) fired++;
    }
    expect(fired).toBeGreaterThan(0);
  });
});

describe('replay determinism with brackets and limit orders', () => {
  it('reproduces the canonical journal (including brackets) exactly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jb-bracket-replay-'));
    const cfg = binanceCfg({ storage: { db: join(dir, 'live.db') } }, join(dir, 'rec'));
    const store = new TradingStore(cfg.storage.db);
    const id = new TradingService(store).createSession(cfg, PRODUCT, { kind: 'forward', now: T0, id: 'b-live' });
    const strat = new ScriptedStrategy();
    strat.bracket = SPEC;
    const rec = new Recorder(cfg.recording.dir, id, id, 60_000, false);
    const rt = new PaperRuntime(store, cfg, id, PRODUCT, { mode: 'forward', strategy: strat, recorder: rec });
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
      bids: [{ price: '79999', qty: '5' }],
      asks: [{ price: '80000', qty: '5' }],
    } as never);
    strat.target = 1;
    t = T0 + 300_500;
    ev({ kind: 'bar', candle: { start: T0, open: '80000', high: '80000', low: '80000', close: '80000', volume: '1' } } as never);
    strat.target = 'hold';
    t += 1000;
    ev({ kind: 'book_update', epoch: 1, seq: seq++, exchangeTime: t, changes: [{ side: 'ask', price: '80000', qty: '5' }] } as never);
    ev({
      kind: 'trade',
      epoch: 1,
      seq: seq++,
      exchangeTime: t,
      tradeId: 'a',
      price: '79998',
      size: '1',
      venueSide: 'buyer_is_maker',
    } as never);
    t += 1000;
    ev({ kind: 'book_update', epoch: 1, seq: seq++, exchangeTime: t, changes: [{ side: 'bid', price: '79999', qty: '5' }] } as never);
    ev({
      kind: 'trade',
      epoch: 1,
      seq,
      exchangeTime: t,
      tradeId: 'b',
      price: '81200',
      size: '1',
      venueSide: 'buyer_is_taker',
    } as never);
    t += 60_000;
    ev({ kind: 'tick' } as never);
    // bounded run ends (the process stops observing), then the operator stops it offline
    ev({ kind: 'lifecycle', state: 'stopping', detail: 'bounded run' } as never);
    rt.finish();
    rec.close();
    expect(new TradingService(store).control(id, 'stop', t + 5_000).mode).toBe('applied');
    expect(store.get('SELECT exit_reason FROM brackets')!.exit_reason).toBe('take_profit');
    const r = runReplay({
      sourceDbPath: cfg.storage.db,
      sourceSessionId: id,
      datasetDir: join(cfg.recording.dir, id),
      replayDbPath: join(dir, 'replay.db'),
      replayId: 'b-replay',
    });
    const rs = new TradingStore(join(dir, 'replay.db'));
    expect(diffJournals(canonicalJournal(store, id), canonicalJournal(rs, r.replaySessionId))).toBeNull();
    expect(journalHash(rs, r.replaySessionId).hash).toBe(journalHash(store, id).hash);
    rs.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
