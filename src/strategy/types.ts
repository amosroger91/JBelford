import type { Candle, Fees } from '../core/types';
import type { StrategyName } from '../config/schema';
import { netTargetPct } from '../economics/costs';

/** Exit distances decided at signal time, in percent of the entry price. */
export interface Exits {
  takeProfitPct: number;
  stopLossPct: number;
}

export interface Signal {
  enter: boolean;
  reasons: string[];
  metrics: Record<string, number>;
  /**
   * Exits this strategy would use for an entry at this bar. Always populated,
   * even when `enter` is false, so the random-entry null test can apply the
   * strategy's own exit sizing at random bars.
   */
  exits: Exits;
}

export interface ExecutionParams {
  entryTimeoutSec: number;
  maxHoldMinutes: number;
  maxSpreadBps: number;
  minNetTargetPct: number;
  allowedHoursUtc: number[];
}

/**
 * An intraday (minutes to hours) long-only strategy on closed 1m candles.
 * Implementations must only read data at or before bar `i` in `signalAt`.
 */
export interface Strategy {
  readonly name: StrategyName;
  readonly execution: ExecutionParams;
  readonly fees: Fees;
  /** 1m bars needed before signals are meaningful. */
  warmupBars(): number;
  /** Precompute indicator series once for a candle window. */
  prepare(candles: Candle[]): object;
  signalAt(prepared: object, i: number, spreadBps: number): Signal;
}

export function exitLevels(entryPrice: number, exits: Exits): { takeProfit: number; stop: number } {
  return {
    takeProfit: entryPrice * (1 + exits.takeProfitPct / 100),
    stop: entryPrice * (1 - exits.stopLossPct / 100),
  };
}

/**
 * Filters every strategy applies: trading hours, spread, and whether the
 * take-profit still leaves `minNetTargetPct` after maker fees on both sides.
 * Hours are judged at the bar's CLOSE time, which is when the decision is made.
 */
export function commonFilters(barTs: number, spreadBps: number, exits: Exits, ex: ExecutionParams, fees: Fees): string[] {
  const reasons: string[] = [];
  const hour = new Date(barTs + 60_000).getUTCHours();
  if (!ex.allowedHoursUtc.includes(hour)) reasons.push('outside allowed hours');
  if (!(spreadBps <= ex.maxSpreadBps)) reasons.push('spread too wide');
  if (netTargetPct(exits.takeProfitPct, fees) < ex.minNetTargetPct) reasons.push('net target after fees too small');
  return reasons;
}
