import type { Candle } from '../core/types';
import { makeRng } from '../core/util';
import type { Strategy } from '../strategy/types';
import { runBacktest, type BacktestOptions } from './backtester';

export interface NullTestResult {
  strategyTrades: number;
  /** Strategy's average net P&L per trade, USD. */
  strategyAvgNet: number;
  simulations: number;
  nullMeanAvgNet: number;
  nullP05: number;
  nullP95: number;
  /** P(random entries with the same exits do at least as well per trade). Want <= 0.05. */
  pValue: number;
}

/**
 * Random-entry null test. Re-runs the backtest many times with entries at
 * random bars (as many attempts as the strategy placed), the same exit sizing,
 * fill model and risk engine. The statistic is average net P&L per trade, so
 * runs with different trade counts (some random entries are blocked by
 * cooldowns or open positions) compare fairly. If the entry signal adds
 * nothing, the strategy looks like a typical random run.
 */
export function randomEntryTest(
  candles: Candle[],
  strategy: Strategy,
  opts: Omit<BacktestOptions, 'strategy' | 'prepared' | 'forcedEntries'>,
  sims = 100,
  seed = 1,
): NullTestResult {
  const prepared = strategy.prepare(candles);
  const real = runBacktest(candles, { ...opts, strategy, prepared });
  const k = Math.max(1, real.entriesPlaced);
  const lo = strategy.warmupBars();
  const span = candles.length - 2 - lo;
  if (span <= k) throw new Error('not enough bars for a random-entry test');
  const rng = makeRng(seed);
  const nulls: number[] = [];
  for (let s = 0; s < sims; s++) {
    const picks = new Set<number>();
    while (picks.size < k) picks.add(lo + Math.floor(rng() * span));
    const r = runBacktest(candles, { ...opts, strategy, prepared, forcedEntries: picks });
    if (r.trades.length > 0) nulls.push(r.avgNetPerTrade);
  }
  nulls.sort((a, b) => a - b);
  const atLeast = nulls.filter((v) => v >= real.avgNetPerTrade).length;
  return {
    strategyTrades: real.trades.length,
    strategyAvgNet: real.avgNetPerTrade,
    simulations: nulls.length,
    nullMeanAvgNet: nulls.reduce((a, b) => a + b, 0) / Math.max(1, nulls.length),
    nullP05: nulls[Math.floor(0.05 * (nulls.length - 1))] ?? 0,
    nullP95: nulls[Math.floor(0.95 * (nulls.length - 1))] ?? 0,
    pValue: real.trades.length === 0 ? 1 : (1 + atLeast) / (1 + nulls.length),
  };
}
