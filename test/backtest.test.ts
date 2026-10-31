import { describe, expect, it } from 'vitest';
import { runBacktest } from '../src/backtest/backtester';
import { gridCombos, optimize } from '../src/backtest/optimize';
import { MomentumStrategy } from '../src/strategy/momentum';
import { makeRng } from '../src/core/util';
import type { Candle } from '../src/core/types';
import { FEES, MARKET, PARAMS, T0 } from './helpers';

/** Random-walk 1m candles with occasional momentum bursts and volume spikes. */
function synthetic(n: number, seed: number): Candle[] {
  const rng = makeRng(seed);
  const out: Candle[] = [];
  let px = 77000;
  let drift = 0;
  for (let i = 0; i < n; i++) {
    if (i % 240 === 0) drift = (rng() - 0.45) * 0.0004;
    const burst = rng() < 0.01 ? 0.003 : 0;
    const ret = drift + (rng() - 0.5) * 0.0015 + burst;
    const open = px;
    px = px * (1 + ret);
    const hi = Math.max(open, px) * (1 + rng() * 0.0008);
    const lo = Math.min(open, px) * (1 - rng() * 0.0008);
    out.push({ ts: T0 + i * 60_000, open, high: hi, low: lo, close: px, volume: burst ? 6 : 0.5 + rng() });
  }
  return out;
}

const base = { fees: FEES, spreadBps: 1, takerSlippageBps: 5, startingUsd: 50, market: MARKET };

describe('backtester', () => {
  const candles = synthetic(20_000, 7);

  it('is deterministic', () => {
    const a = runBacktest(candles, { ...base, strategy: new MomentumStrategy(PARAMS, FEES) });
    const b = runBacktest(candles, { ...base, strategy: new MomentumStrategy(PARAMS, FEES) });
    expect(a.netPnl).toBe(b.netPnl);
    expect(a.trades.length).toBe(b.trades.length);
  });

  it('respects the hard limits in simulation', () => {
    const r = runBacktest(candles, { ...base, strategy: new MomentumStrategy({ ...PARAMS, minRocPct: 0.05, volMult: 0.8 }, FEES) });
    expect(r.trades.length).toBeGreaterThan(0);
    const perDay = new Map<number, number>();
    let lastClose = 0;
    for (const t of r.trades) {
      expect(t.amount * t.entryPrice).toBeLessThanOrEqual(10);
      const d = Math.floor(t.closedAt / 86_400_000);
      perDay.set(d, (perDay.get(d) ?? 0) + 1);
      // entry is placed >= 5 min after the previous close
      if (lastClose) expect(t.openedAt - lastClose).toBeGreaterThanOrEqual(5 * 60_000);
      lastClose = t.closedAt;
    }
    for (const n of perDay.values()) expect(n).toBeLessThanOrEqual(10);
  });

  it('accounts for fees: net = gross - fees', () => {
    const r = runBacktest(candles, { ...base, strategy: new MomentumStrategy({ ...PARAMS, minRocPct: 0.05, volMult: 0.8 }, FEES) });
    expect(r.netPnl).toBeCloseTo(r.grossPnl - r.fees, 9);
    expect(r.finalEquity).toBeCloseTo(50 + r.netPnl, 6);
  });

  it('zero-fee runs are never worse than fee runs', () => {
    const p = { ...PARAMS, minRocPct: 0.05, volMult: 0.8, minNetTargetPct: 0 };
    const withFees = runBacktest(candles, { ...base, strategy: new MomentumStrategy(p, FEES) });
    const noFees = runBacktest(candles, { ...base, fees: { maker: 0, taker: 0 }, strategy: new MomentumStrategy(p, { maker: 0, taker: 0 }) });
    expect(noFees.grossPnl).toBeGreaterThanOrEqual(withFees.grossPnl - 1e-9);
  });

  it('models non-fills: not every placed entry fills', () => {
    const r = runBacktest(candles, { ...base, strategy: new MomentumStrategy({ ...PARAMS, minRocPct: 0.05, volMult: 0.8 }, FEES) });
    expect(r.entriesPlaced).toBeGreaterThan(0);
    expect(r.entriesFilled).toBeLessThan(r.entriesPlaced);
  });
});

describe('optimizer', () => {
  it('filters invalid combos and reports out-of-sample + walk-forward', () => {
    expect(gridCombos('momentum', PARAMS, { trendEmaFast5m: [9, 30], trendEmaSlow5m: [21] })).toHaveLength(1);
    const res = optimize(synthetic(15_000, 3), 'momentum', PARAMS, { minRocPct: [0.05, 0.15], volMult: [0.8, 1.5] }, {
      ...base,
      inSampleFraction: 0.7,
      minTrades: 1,
      topK: 2,
      folds: 2,
    });
    expect(res.combos).toBe(4);
    expect(res.ranked.length).toBeLessThanOrEqual(2);
    expect(res.walkForward.folds).toHaveLength(2);
    for (const r of res.ranked) expect(r.outOfSample).toHaveProperty('netPnl');
  });
});
