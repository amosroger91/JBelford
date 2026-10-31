import type { Candle } from '../core/types';
import { StrategyParamsSchema, type StrategyParams } from '../config/schema';
import { MomentumStrategy } from '../strategy/momentum';
import { runBacktest, type BacktestOptions, type BacktestResult } from './backtester';
import { deflatedSharpe, periodReturns, probabilityOfBacktestOverfitting, type DsrResult, type PboResult } from './overfitting';

export type GridSpec = Partial<Record<keyof StrategyParams, number[]>>;

export function gridCombos(base: StrategyParams, spec: GridSpec): StrategyParams[] {
  let combos: StrategyParams[] = [{ ...base }];
  for (const [k, values] of Object.entries(spec) as [keyof StrategyParams, number[]][]) {
    const next: StrategyParams[] = [];
    for (const c of combos) for (const v of values) next.push({ ...c, [k]: v });
    combos = next;
  }
  return combos.filter((c) => StrategyParamsSchema.safeParse(c).success);
}

export interface Summary {
  trades: number;
  netPnl: number;
  fees: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownUsd: number;
  fillRate: number;
  shutdowns: number;
}

export function summarize(r: BacktestResult): Summary {
  return {
    trades: r.trades.length,
    netPnl: r.netPnl,
    fees: r.fees,
    winRate: r.winRate,
    profitFactor: r.profitFactor,
    maxDrawdownUsd: r.maxDrawdownUsd,
    fillRate: r.entriesPlaced ? r.entriesFilled / r.entriesPlaced : 0,
    shutdowns: r.shutdowns,
  };
}

type BaseOpts = Omit<BacktestOptions, 'params'>;

/** Slice for testing with enough preceding bars to warm up indicators (no trades occur in warmup). */
function withWarmup(candles: Candle[], from: number, to: number, params: StrategyParams, fees: BaseOpts['fees']): Candle[] {
  const warm = new MomentumStrategy(params, fees).warmupBars();
  return candles.slice(Math.max(0, from - warm), to);
}

/** Objective: net P&L, penalizing combos with too few trades to mean anything. */
function score(s: Summary, minTrades: number): number {
  return s.trades < minTrades ? -Infinity : s.netPnl;
}

export interface OptimizeResult {
  splitTs: number;
  combos: number;
  ranked: { params: StrategyParams; inSample: Summary; outOfSample: Summary }[];
  baseline: { inSample: Summary; outOfSample: Summary };
  walkForward: { folds: { trainEnd: number; testEnd: number; chosen: StrategyParams | null; test: Summary | null }[]; totalNet: number; totalTrades: number };
  overfitting: {
    periodHours: number;
    trialsUsed: number;
    trialsExcluded: number;
    pbo: PboResult | null;
    dsr: (DsrResult & { params: StrategyParams }) | null;
    error?: string;
  };
}

/**
 * Chronological in-sample / out-of-sample validation plus anchored
 * walk-forward re-optimization. Parameters are chosen ONLY on in-sample data;
 * the out-of-sample numbers are what matter, and even those are no guarantee
 * of live results.
 */
export function optimize(
  candles: Candle[],
  base: StrategyParams,
  spec: GridSpec,
  opts: BaseOpts & { inSampleFraction: number; minTrades: number; topK: number; folds: number; periodHours?: number; pboBlocks?: number },
): OptimizeResult {
  const combos = gridCombos(base, spec);
  const split = Math.floor(candles.length * opts.inSampleFraction);
  const is = candles.slice(0, split);
  const run = (p: StrategyParams, data: Candle[]) => summarize(runBacktest(data, { ...opts, params: p }));

  const scored = combos.map((p) => ({ params: p, inSample: run(p, is) }));
  scored.sort((a, b) => score(b.inSample, opts.minTrades) - score(a.inSample, opts.minTrades));
  const ranked = scored.slice(0, opts.topK).map((r) => ({
    ...r,
    outOfSample: run(r.params, withWarmup(candles, split, candles.length, r.params, opts.fees)),
  }));

  const baseline = {
    inSample: run(base, is),
    outOfSample: run(base, withWarmup(candles, split, candles.length, base, opts.fees)),
  };

  // Anchored walk-forward: train on [0, t_k), test on [t_k, t_k+1).
  const folds: OptimizeResult['walkForward']['folds'] = [];
  const firstTrain = Math.floor(candles.length * 0.4);
  const step = Math.floor((candles.length - firstTrain) / Math.max(1, opts.folds));
  let totalNet = 0;
  let totalTrades = 0;
  for (let k = 0; k < opts.folds; k++) {
    const trainEnd = firstTrain + k * step;
    const testEnd = k === opts.folds - 1 ? candles.length : trainEnd + step;
    const train = candles.slice(0, trainEnd);
    let best: { p: StrategyParams; s: number } | null = null;
    for (const p of combos) {
      const s = score(run(p, train), opts.minTrades);
      if (s > -Infinity && (!best || s > best.s)) best = { p, s };
    }
    const test = best ? run(best.p, withWarmup(candles, trainEnd, testEnd, best.p, opts.fees)) : null;
    if (test) {
      totalNet += test.netPnl;
      totalTrades += test.trades;
    }
    folds.push({ trainEnd: candles[trainEnd - 1]?.ts ?? 0, testEnd: candles[testEnd - 1]?.ts ?? 0, chosen: best?.p ?? null, test });
  }

  // Overfitting diagnostics over the whole grid, on per-period net P&L.
  const periodHours = opts.periodHours ?? 24;
  const overfitting: OptimizeResult['overfitting'] = { periodHours, trialsUsed: 0, trialsExcluded: 0, pbo: null, dsr: null };
  try {
    const startTs = candles[0]!.ts;
    const endTs = candles.at(-1)!.ts + 60_000;
    // Trials that (almost) never trade are excluded: a do-nothing column earns 0, beats every loser,
    // and would make selection look perfectly stable (PBO 0%) while measuring nothing.
    const trials = combos
      .map((p) => ({ p, trades: runBacktest(candles, { ...opts, params: p }).trades }))
      .filter((t) => t.trades.length >= opts.minTrades);
    overfitting.trialsUsed = trials.length;
    overfitting.trialsExcluded = combos.length - trials.length;
    const columns = trials.map((t) => periodReturns(t.trades, startTs, endTs, periodHours * 3_600_000));
    if (columns.length < 2) throw new Error(`only ${columns.length} trial(s) with >= ${opts.minTrades} trades`);
    const matrix = columns[0]!.map((_, t) => columns.map((c) => c[t]!));
    overfitting.pbo = probabilityOfBacktestOverfitting(matrix, opts.pboBlocks ?? 8);
    const d = deflatedSharpe(matrix);
    overfitting.dsr = { ...d, params: trials[d.bestTrial]!.p };
  } catch (e) {
    overfitting.error = String(e);
  }

  return { splitTs: candles[split]?.ts ?? 0, combos: combos.length, ranked, baseline, walkForward: { folds, totalNet, totalTrades }, overfitting };
}
