import type { PaperConfig } from '../config';
import { Ledger } from '../ledger';
import { ZERO, dec, mul, str, toNumber, type Dec } from '../money';
import type { TradingStore } from '../store';
import { makeRng } from '../../core/util';

export interface Valuation {
  time: number;
  markBid: number | null;
  markMid: number | null;
  equityMid: number | null;
  stale: boolean;
}

export interface SessionMetrics {
  initialEquity: number;
  startingCash: string;
  endingCash: string;
  endingBtc: string;
  realizedPnl: string;
  unrealizedPnl: string | null;
  fees: string;
  liquidationValue: string | null;
  netTradingPnl: number | null;
  allInOperatingPnl: number | null;
  operatingCosts: { knownUsd: string; unknownCalls: number; complete: boolean };
  netReturn: number | null;
  timeInMarket: number;
  avgExposure: number;
  turnover: number;
  roundTrips: {
    count: number;
    wins: number;
    losses: number;
    winRate: number | 'undefined';
    avgWin: number | 'undefined';
    avgLoss: number | 'undefined';
    profitFactor: number | 'infinite' | 'undefined';
  };
  openPosition: boolean;
  maxDrawdown: number;
  dailyReturns: { day: string; ret: number }[];
  counts: {
    decisions: number;
    orders: number;
    fills: number;
    rejections: number;
    partialFills: number;
    cancellations: number;
    expirations: number;
    timeouts: number;
    invalidOutputs: number;
    skippedDecisions: number;
  };
  feed: { gaps: number; gapMs: number; coveragePct: number; longestContinuousMs: number; reconnects: number; seqGaps: number };
  models: string[];
  reconciliation: string[];
  observedMs: number;
}

export interface Controls {
  cash: { ret: number };
  buyHold: { ret: number | null; note: string };
  matchedExposure: { ret: number | null; weight: number; note: string };
}

/** Load the equity/marks series. */
export function valuations(store: TradingStore, sessionId: string): Valuation[] {
  return store
    .all('SELECT time, mark_bid, mark_mid, equity_mid, stale FROM valuations WHERE session_id = ? ORDER BY id', sessionId)
    .map((r) => ({
      time: r.time as number,
      markBid: r.mark_bid === null ? null : Number(r.mark_bid),
      markMid: r.mark_mid === null ? null : Number(r.mark_mid),
      equityMid: r.equity_mid === null ? null : Number(r.equity_mid),
      stale: Boolean(r.stale),
    }));
}

export function sessionMetrics(store: TradingStore, sessionId: string, _cfg: PaperConfig): SessionMetrics {
  const ledger = new Ledger(store);
  const b = ledger.balances(sessionId);
  const vals = valuations(store, sessionId);
  const s = store.get('SELECT * FROM sessions WHERE id = ?', sessionId)!;
  const firstMark = vals.find((v) => v.markMid !== null)?.markMid ?? null;
  const lastFresh = [...vals].reverse().find((v) => v.markMid !== null && !v.stale) ?? null;
  const initialEquity = Number(s.initial_usd) + Number(s.initial_btc) * (firstMark ?? 0);
  const btc = b.btcAvailable + b.btcReserved;
  const usd = b.usdAvailable + b.usdReserved;
  const unrealized: Dec | null = btc === ZERO ? ZERO : lastFresh ? mul(btc, dec(String(lastFresh.markMid))) - b.btcCostBasis : null;
  const liq = store.get(
    'SELECT liquidation_value FROM valuations WHERE session_id = ? AND liquidation_value IS NOT NULL ORDER BY id DESC LIMIT 1',
    sessionId,
  );
  const netTrading = unrealized === null ? null : toNumber(b.realizedPnl + unrealized);

  let known = ZERO;
  let unknownCalls = 0;
  for (const r of store.all('SELECT cost_usd FROM model_calls WHERE session_id = ?', sessionId)) {
    if (r.cost_usd === null) unknownCalls++;
    else known += dec(r.cost_usd as string);
  }
  const costsComplete = unknownCalls === 0;

  // Equity series, exposure, drawdown, time in market.
  let peak = -Infinity;
  let maxDd = 0;
  let inMarket = 0;
  let expoSum = 0;
  let fresh = 0;
  for (const v of vals) {
    if (v.equityMid === null) continue;
    peak = Math.max(peak, v.equityMid);
    maxDd = Math.max(maxDd, peak > 0 ? (peak - v.equityMid) / peak : 0);
  }
  const fills = store.all('SELECT side, price, qty, fee, time FROM fills WHERE session_id = ? ORDER BY event_ordinal, fill_id', sessionId);
  let pos = 0;
  const posAt: { time: number; pos: number }[] = [];
  for (const f of fills) {
    pos += (f.side === 'buy' ? 1 : -1) * Number(f.qty);
    posAt.push({ time: f.time as number, pos });
  }
  for (const v of vals) {
    if (v.equityMid === null || v.markMid === null) continue;
    const p = [...posAt].reverse().find((x) => x.time <= v.time)?.pos ?? Number(s.initial_btc);
    fresh++;
    if (p > 1e-12) inMarket++;
    expoSum += (p * v.markMid) / v.equityMid;
  }
  const turnoverUsd = fills.reduce((a, f) => a + Number(f.price) * Number(f.qty), 0);

  // Round trips: flat -> long -> flat, P&L from fills (net of fees).
  const trips: number[] = [];
  let cur = 0;
  let curPnl = 0;
  for (const f of fills) {
    const notional = Number(f.price) * Number(f.qty);
    curPnl += f.side === 'buy' ? -notional - Number(f.fee) : notional - Number(f.fee);
    cur += (f.side === 'buy' ? 1 : -1) * Number(f.qty);
    if (Math.abs(cur) < 1e-12 && f.side === 'sell') {
      trips.push(curPnl);
      curPnl = 0;
      cur = 0;
    }
  }
  const wins = trips.filter((t) => t > 0);
  const losses = trips.filter((t) => t <= 0);
  const sumW = wins.reduce((a, b) => a + b, 0);
  const sumL = -losses.reduce((a, b) => a + b, 0);

  // Daily returns on fresh UTC-day closing equity.
  const byDay = new Map<string, number>();
  for (const v of vals) if (v.equityMid !== null) byDay.set(new Date(v.time).toISOString().slice(0, 10), v.equityMid);
  const days = [...byDay.entries()];
  const daily = days.map(([day, eq], i) => ({ day, ret: i === 0 ? eq / initialEquity - 1 : eq / days[i - 1]![1] - 1 }));

  // Feed coverage.
  const gaps = store.all('SELECT start_time, end_time FROM observation_gaps WHERE session_id = ? ORDER BY start_time', sessionId);
  const firstT = (s.started_at as number | null) ?? vals[0]?.time ?? 0;
  const lastT = (s.last_event_time as number | null) ?? firstT;
  const observedMs = Math.max(0, lastT - firstT);
  let gapMs = 0;
  let longest = 0;
  let cursor = firstT;
  for (const g of gaps) {
    const st = g.start_time as number;
    const en = (g.end_time as number | null) ?? lastT;
    longest = Math.max(longest, st - cursor);
    gapMs += Math.max(0, en - st);
    cursor = Math.max(cursor, en);
  }
  longest = Math.max(longest, lastT - cursor);
  const cnt = (sql: string) => (store.get(sql, sessionId)!.n as number) ?? 0;

  return {
    initialEquity,
    startingCash: s.initial_usd as string,
    endingCash: str(usd),
    endingBtc: str(btc),
    realizedPnl: str(b.realizedPnl),
    unrealizedPnl: unrealized === null ? null : str(unrealized),
    fees: str(b.feesPaid),
    liquidationValue: (liq?.liquidation_value as string | undefined) ?? null,
    netTradingPnl: netTrading,
    allInOperatingPnl: netTrading === null || !costsComplete ? null : netTrading - toNumber(known),
    operatingCosts: { knownUsd: str(known), unknownCalls, complete: costsComplete },
    netReturn: netTrading === null || initialEquity === 0 ? null : netTrading / initialEquity,
    timeInMarket: fresh ? inMarket / fresh : 0,
    avgExposure: fresh ? expoSum / fresh : 0,
    turnover: initialEquity ? turnoverUsd / initialEquity : 0,
    roundTrips: {
      count: trips.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trips.length ? wins.length / trips.length : 'undefined',
      avgWin: wins.length ? sumW / wins.length : 'undefined',
      avgLoss: losses.length ? -sumL / losses.length : 'undefined',
      profitFactor: trips.length === 0 ? 'undefined' : sumL === 0 ? (sumW > 0 ? 'infinite' : 'undefined') : sumW / sumL,
    },
    openPosition: btc > ZERO,
    maxDrawdown: maxDd,
    dailyReturns: daily,
    counts: {
      decisions: cnt('SELECT COUNT(*) AS n FROM decisions WHERE session_id = ?'),
      orders: cnt('SELECT COUNT(*) AS n FROM orders WHERE session_id = ?'),
      fills: cnt('SELECT COUNT(*) AS n FROM fills WHERE session_id = ?'),
      rejections: cnt("SELECT COUNT(*) AS n FROM orders WHERE session_id = ? AND status = 'rejected'"),
      partialFills: cnt("SELECT COUNT(*) AS n FROM orders WHERE session_id = ? AND status = 'cancelled' AND filled_qty <> '0'"),
      cancellations: cnt("SELECT COUNT(*) AS n FROM orders WHERE session_id = ? AND status = 'cancelled'"),
      expirations: cnt("SELECT COUNT(*) AS n FROM orders WHERE session_id = ? AND status = 'expired'"),
      timeouts: cnt("SELECT COUNT(*) AS n FROM decisions WHERE session_id = ? AND outcome = 'timeout'"),
      invalidOutputs: cnt("SELECT COUNT(*) AS n FROM decisions WHERE session_id = ? AND outcome IN ('invalid','error')"),
      skippedDecisions: cnt("SELECT COUNT(*) AS n FROM audit WHERE session_id = ? AND kind = 'decision_skipped'"),
    },
    feed: {
      gaps: gaps.length,
      gapMs,
      coveragePct: observedMs ? Math.max(0, 100 * (1 - gapMs / observedMs)) : 0,
      longestContinuousMs: longest,
      reconnects: cnt("SELECT COUNT(*) AS n FROM audit WHERE session_id = ? AND kind = 'reconnect'"),
      seqGaps: cnt("SELECT COUNT(*) AS n FROM audit WHERE session_id = ? AND kind = 'seq_gap'"),
    },
    models: store.all('SELECT DISTINCT model FROM model_calls WHERE session_id = ?', sessionId).map((r) => r.model as string),
    reconciliation: ledger.verify(sessionId),
    observedMs,
  };
}

/**
 * Controls with identical valuation/cost conventions: entry at the ask
 * (2*mid - bid) plus taker fee, exit at the bid minus taker fee, over the same
 * fresh-mark window as the session.
 */
export function controls(store: TradingStore, sessionId: string, cfg: PaperConfig): Controls {
  const vals = valuations(store, sessionId).filter((v) => v.markMid !== null && v.markBid !== null && !v.stale);
  const fee = Number(cfg.fees.takerRate);
  const w = Number(cfg.risk.maxExposure);
  if (vals.length < 2) {
    const note = 'insufficient fresh marks';
    return { cash: { ret: 0 }, buyHold: { ret: null, note }, matchedExposure: { ret: null, weight: w, note } };
  }
  const first = vals[0]!;
  const last = vals.at(-1)!;
  const entryAsk = 2 * first.markMid! - first.markBid!;
  const exitBid = last.markBid!;
  const bh = (exitBid * (1 - fee)) / (entryAsk * (1 + fee)) - 1;
  return {
    cash: { ret: 0 },
    buyHold: { ret: bh, note: '100% BTC: buy at first ask + taker fee, liquidate at last bid - taker fee' },
    matchedExposure: { ret: w * bh, weight: w, note: `${w * 100}% BTC held throughout with the same entry/exit costs` },
  };
}

/**
 * Stationary block bootstrap of the mean of daily excess returns; returns the
 * one-sided lower confidence bound. Not computed when there are too few days.
 */
export function blockBootstrapLowerBound(
  excess: number[],
  blockDays: number,
  samples: number,
  confidence: number,
  seed = 7,
): { lowerBound: number | null; reason?: string; mean?: number } {
  if (excess.length < Math.max(2 * blockDays, 10)) {
    return { lowerBound: null, reason: `needs >= ${Math.max(2 * blockDays, 10)} daily observations, have ${excess.length}` };
  }
  const rng = makeRng(seed);
  const n = excess.length;
  const means: number[] = [];
  for (let s = 0; s < samples; s++) {
    let sum = 0;
    let k = 0;
    while (k < n) {
      const start = Math.floor(rng() * n);
      for (let j = 0; j < blockDays && k < n; j++, k++) sum += excess[(start + j) % n]!;
    }
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  return { lowerBound: means[Math.floor((1 - confidence) * (samples - 1))]!, mean: excess.reduce((a, b) => a + b, 0) / n };
}

/** Re-cost the session's fills under stress (worse fees, extra slippage) and report net PnL. */
export function sensitivity(store: TradingStore, sessionId: string, cfg: PaperConfig, finalMark: number | null) {
  const fills = store.all('SELECT side, price, qty FROM fills WHERE session_id = ? ORDER BY event_ordinal, fill_id', sessionId);
  const base = Number(cfg.fees.takerRate);
  const run = (feeRate: number, slipBps: number) => {
    let usd = 0;
    let btc = 0;
    for (const f of fills) {
      const px = Number(f.price) * (1 + ((f.side === 'buy' ? 1 : -1) * slipBps) / 10_000);
      const n = px * Number(f.qty);
      usd += f.side === 'buy' ? -n - n * feeRate : n - n * feeRate;
      btc += (f.side === 'buy' ? 1 : -1) * Number(f.qty);
    }
    return finalMark === null && Math.abs(btc) > 1e-12 ? null : usd + btc * (finalMark ?? 0);
  };
  return {
    baseline: run(base, 0),
    fees1_5x: run(base * 1.5, 0),
    fees2x: run(base * 2, 0),
    slippage5bps: run(base, 5),
    slippage20bps: run(base, 20),
    note: 'Re-costs recorded fills only; thinner-liquidity and dropped-segment effects are reported via partial-fill counts and feed coverage.',
  };
}
