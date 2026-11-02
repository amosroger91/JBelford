import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PaperOnlyError } from '../../src/paper/domain';
import { checkRequest, NetworkPolicyError } from '../../src/paper/market/netguard';
import { parseKalshiConfig, type KalshiConfig } from '../../src/kalshi/config';
import { KalshiPaperEngine, UNIT, type KalshiEvent, type MarketInfo } from '../../src/kalshi/engine';
import { replayKalshi, reportKalshi, runKalshiLive } from '../../src/kalshi/service';

const T0 = Date.UTC(2026, 10, 2, 5, 0, 0);
const BASE = {
  mode: 'paper',
  purpose: 'unit test',
  series: ['KXGOLD15M'],
  bankrollUsd: 50,
  minFavoriteBid: 0.8,
  maxCollateralPerMarketUsd: 10,
  orderContracts: 10,
  stopPostingSecondsBeforeClose: 0,
  pollMs: 1000,
  marketsRefreshMs: 5000,
  settleWaitMs: 60_000,
  recordingDir: 'data/kalshi-test',
};
const cfgOf = (over: Record<string, unknown> = {}): KalshiConfig => parseKalshiConfig({ ...BASE, ...over });
const u = (dollars: number) => Math.round(dollars * UNIT);
const market = (over: Partial<MarketInfo> = {}): MarketInfo => ({
  ticker: 'KXGOLD15M-A',
  series: 'KXGOLD15M',
  closeTime: T0 + 15 * 60_000,
  status: 'active',
  feeType: 'quadratic',
  feeMultiplier: 1,
  ...over,
});
const book = (t: number, yes: [number, number][], no: [number, number][], ticker = 'KXGOLD15M-A'): KalshiEvent => ({
  kind: 'book',
  t,
  ticker,
  yes: yes.map(([p, s]) => [u(p), s]),
  no: no.map(([p, s]) => [u(p), s]),
});
/** A taker bought `side` at `price` (dollars). */
const trade = (t: number, id: string, side: 'yes' | 'no', price: number, count: number, ticker = 'KXGOLD15M-A'): KalshiEvent => ({
  kind: 'trades',
  t,
  ticker,
  trades: [{ id, yesPx: side === 'yes' ? u(price) : u(1 - price), count, takerSide: side, ts: t }],
});

function engineWithOrder(over: Record<string, unknown> = {}) {
  const e = new KalshiPaperEngine(cfgOf(over));
  e.ingest({ kind: 'markets', t: T0, markets: [market()] });
  // YES is the favorite at 0.90 bid (5 contracts displayed); NO longshot.
  e.ingest(
    book(
      T0 + 1000,
      [
        [0.89, 100],
        [0.9, 5],
      ],
      [
        [0.05, 50],
        [0.08, 20],
      ],
    ),
  );
  return e;
}

describe('Kalshi paper engine: quoting', () => {
  it('joins the best bid on the favorite side, behind the displayed queue', () => {
    const e = engineWithOrder();
    expect(e.openOrders()).toEqual([expect.objectContaining({ side: 'yes', price: u(0.9), qty: 10, queueAhead: 5 })]);
    expect(e.reserved()).toBe(10 * u(0.9));
  });
  it('quotes the NO side when NO is the favorite, and nothing when neither side is >= 80c', () => {
    const e = new KalshiPaperEngine(cfgOf());
    e.ingest({ kind: 'markets', t: T0, markets: [market()] });
    e.ingest(book(T0 + 1000, [[0.1, 5]], [[0.85, 7]]));
    expect(e.openOrders()[0]).toMatchObject({ side: 'no', price: u(0.85), queueAhead: 7 });
    e.ingest(book(T0 + 2000, [[0.4, 5]], [[0.55, 7]]));
    expect(e.openOrders()).toEqual([]);
  });
  it('caps size by collateral per market and by free cash', () => {
    const e = engineWithOrder({ maxCollateralPerMarketUsd: 5 });
    expect(e.openOrders()[0]!.qty).toBe(5); // floor(5 / 0.90)
    const poor = engineWithOrder({ bankrollUsd: 2 });
    expect(poor.openOrders()[0]!.qty).toBe(2);
  });
  it('re-quotes an unfilled order when the best bid moves, and cancels at the close', () => {
    const e = engineWithOrder();
    e.ingest(book(T0 + 2000, [[0.91, 3]], [[0.05, 50]]));
    expect(e.openOrders()[0]).toMatchObject({ price: u(0.91), queueAhead: 3 });
    e.ingest(book(T0 + 15 * 60_000, [[0.91, 3]], [[0.05, 50]]));
    expect(e.openOrders()).toEqual([]);
    expect(e.reserved()).toBe(0);
  });
});

describe('Kalshi paper engine: queue-conservative fills', () => {
  it('a longshot buyer at our level consumes the queue ahead first, then fills us', () => {
    const e = engineWithOrder();
    e.ingest(trade(T0 + 2000, 't1', 'no', 0.1, 3)); // matched YES bids at 0.90: queue 5 -> 2
    expect(e.fills).toEqual([]);
    e.ingest(trade(T0 + 3000, 't2', 'no', 0.1, 6)); // 2 ahead, 4 to us
    expect(e.fills).toEqual([expect.objectContaining({ qty: 4, price: u(0.9), through: false, fee: 0 })]);
    expect(e.positions.get('KXGOLD15M-A')).toMatchObject({ side: 'yes', qty: 4, cost: 4 * u(0.9) });
    expect(e.cash).toBe(u(50) - 4 * u(0.9));
  });
  it('a trade below our price traded through our level: fully filled', () => {
    const e = engineWithOrder();
    e.ingest(trade(T0 + 2000, 't1', 'no', 0.12, 1)); // YES bid side traded at 0.88 < 0.90
    expect(e.fills[0]).toMatchObject({ qty: 10, through: true });
    expect(e.openOrders()).toEqual([]);
  });
  it('ignores favorite buyers, better-priced matches, duplicates and trades before placement', () => {
    const e = engineWithOrder();
    e.ingest(trade(T0 + 2000, 'a', 'yes', 0.92, 50)); // taker bought YES: not our side of the book
    e.ingest(trade(T0 + 2000, 'b', 'no', 0.09, 50)); // matched a 0.91 YES bid, better than ours
    e.ingest(trade(T0 + 500, 'c', 'no', 0.1, 50)); // printed before we were placed
    expect(e.fills).toEqual([]);
    e.ingest(trade(T0 + 3000, 'd', 'no', 0.1, 4));
    e.ingest(trade(T0 + 3000, 'd', 'no', 0.1, 4)); // same id again
    expect(e.openOrders()[0]!.queueAhead).toBe(1);
  });
  it('cancellations ahead of us shrink the queue only when the displayed size falls below it', () => {
    const e = engineWithOrder();
    e.ingest(book(T0 + 2000, [[0.9, 8]], [[0.05, 50]])); // more joined behind us: queue stays 5
    expect(e.openOrders()[0]!.queueAhead).toBe(5);
    e.ingest(book(T0 + 3000, [[0.9, 1]], [[0.05, 50]])); // only 1 left displayed
    expect(e.openOrders()[0]!.queueAhead).toBe(1);
  });
  it('charges maker fees (rounded up to the cent) only on maker-fee series', () => {
    const e = new KalshiPaperEngine(cfgOf());
    e.ingest({ kind: 'markets', t: T0, markets: [market({ feeType: 'quadratic_with_maker_fees' })] });
    e.ingest(book(T0 + 1000, [[0.9, 0]], [[0.05, 50]]));
    e.ingest(book(T0 + 1500, [[0.9, 1]], [[0.05, 50]]));
    e.ingest(trade(T0 + 2000, 't', 'no', 0.12, 1));
    // 0.0175 * 10 * 0.9 * 0.1 = $0.01575 -> $0.02
    expect(e.fills[0]!.fee).toBe(u(0.02));
  });
});

describe('Kalshi paper engine: settlement', () => {
  it('pays $1 per contract when the favorite wins, nothing when it loses, refunds on void', () => {
    for (const [result, pnl] of [
      ['yes', 10 * u(0.1)],
      ['no', -10 * u(0.9)],
      ['void', 0],
    ] as const) {
      const e = engineWithOrder();
      e.ingest(trade(T0 + 2000, 't', 'no', 0.12, 1));
      e.ingest({ kind: 'result', t: T0 + 16 * 60_000, ticker: 'KXGOLD15M-A', result });
      expect(e.settlements[0]).toMatchObject({ result, qty: 10, pnl });
      expect(e.cash).toBe(u(50) + pnl);
      expect(e.positions.size).toBe(0);
    }
  });
  it('stop cancels resting orders but keeps positions until they settle', () => {
    const e = engineWithOrder();
    e.ingest(trade(T0 + 2000, 't', 'no', 0.1, 9));
    e.ingest({ kind: 'stop', t: T0 + 3000, reason: 'test' });
    expect(e.openOrders()).toEqual([]);
    expect(e.positions.get('KXGOLD15M-A')!.qty).toBe(4);
    e.ingest(book(T0 + 4000, [[0.9, 5]], [[0.05, 50]]));
    expect(e.openOrders()).toEqual([]); // no new quotes after stop
  });
});

describe('Kalshi paper safety', () => {
  it('refuses live mode and credential keys', () => {
    expect(() => parseKalshiConfig({ ...BASE, mode: 'live' })).toThrow(PaperOnlyError);
    expect(() => parseKalshiConfig({ ...BASE, apiKeyId: 'x' })).toThrow(PaperOnlyError);
  });
  it('allows only public Kalshi market-data GETs', () => {
    const k = 'https://api.elections.kalshi.com/trade-api/v2';
    for (const p of [
      '/markets',
      '/markets/trades',
      '/markets/KXGOLD15M-26NOV020000-00',
      '/markets/KXGOLD15M-26NOV020000-00/orderbook',
      '/series/KXGOLD15M',
    ])
      expect(() => checkRequest('GET', k + p)).not.toThrow();
    expect(() => checkRequest('GET', k + '/portfolio/balance')).toThrow(NetworkPolicyError);
    expect(() => checkRequest('POST', k + '/portfolio/orders')).toThrow(NetworkPolicyError);
    expect(() => checkRequest('GET', 'https://evil.example/trade-api/v2/markets')).toThrow(NetworkPolicyError);
  });
});

describe('Kalshi live loop (stubbed public API) and replay', () => {
  it('records every observation; replay reproduces the result hash exactly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jb-kalshi-'));
    let clock = T0;
    const close = new Date(T0 + 20_000).toISOString();
    let tick = 0;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const fetchImpl = async (url: string) => {
      const p = new URL(url);
      if (p.pathname.endsWith('/series/KXGOLD15M')) return json({ series: { fee_type: 'quadratic', fee_multiplier: 1 } });
      if (p.pathname.endsWith('/markets/trades')) {
        tick++;
        return json({
          trades:
            tick === 2
              ? [
                  {
                    trade_id: 'x1',
                    created_time: new Date(clock).toISOString(),
                    yes_price_dollars: '0.8800',
                    count_fp: '3.00',
                    taker_side: 'no',
                  },
                ]
              : [],
        });
      }
      if (p.pathname.endsWith('/orderbook'))
        return json({ orderbook_fp: { yes_dollars: [['0.9000', '2.00']], no_dollars: [['0.0500', '10.00']] } });
      if (p.pathname.endsWith('/markets')) return json({ markets: [{ ticker: 'KXGOLD15M-A', close_time: close, status: 'active' }] });
      if (p.pathname.endsWith('/markets/KXGOLD15M-A'))
        return json({ market: { result: clock > T0 + 20_000 ? 'yes' : '', status: 'finalized' } });
      return new Response('{}', { status: 404 });
    };
    const cfg = cfgOf({ recordingDir: dir, pollMs: 1000 });
    const r = await runKalshiLive({
      cfg,
      durationMs: 10_000,
      fetchImpl: fetchImpl as never,
      now: () => (clock += 500),
      sessionId: 'ks-test',
    });
    const s = r.engine.summary();
    expect(s.fills).toBe(1);
    expect(s.settledMarkets).toBe(1);
    expect(s.realizedPnlUsd).toBeCloseTo(1.0, 10); // 10 contracts bought at 0.90, won
    const replayed = replayKalshi(cfg, r.dir);
    expect(replayed.hash()).toBe(r.engine.hash());
    const { report } = reportKalshi(cfg, 'ks-test', join(dir, 'out'));
    expect(report.replay.matched).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
