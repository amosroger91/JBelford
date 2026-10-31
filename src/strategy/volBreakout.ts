import type { Candle, Fees } from '../core/types';
import type { VolBreakoutParams } from '../config/schema';
import { aggregate, atr, ema, mapToCompleted, percentileRank, rollingStd, sma } from './indicators';
import { commonFilters, type ExecutionParams, type Signal, type Strategy } from './types';

interface Prepared {
  candles: Candle[];
  htf: Candle[];
  map: Int32Array;
  bandwidth: number[];
  atr: number[];
  volSma: number[];
  trendEma: number[];
}

/**
 * Volatility-compression breakout on an intraday timeframe (5-60 min bars).
 *
 * Idea: quiet, tight ranges tend to end in directional expansion. Entering on
 * an upside break after a squeeze targets a multi-ATR move over a few hours,
 * large enough to clear round-trip fees.
 *
 * Evaluated only on the 1m bar that completes a higher-timeframe (HTF) bar:
 *  - squeeze: Bollinger bandwidth of the PREVIOUS HTF bar is in the lowest
 *    squeezePercentile of the last squeezeLookback bars
 *  - breakout: HTF close above the highest high of the prior breakoutBars bars
 *  - volume: HTF volume >= volMult x prior average
 *  - trend (optional): HTF close above EMA(trendEmaBars)
 *  - common filters: hours, spread, net target after fees
 * Exits: take profit = max(minTakeProfitPct, tpAtr x ATR%), stop = min(maxStopLossPct, slAtr x ATR%).
 */
export class VolBreakoutStrategy implements Strategy {
  readonly name = 'volBreakout' as const;
  readonly execution: ExecutionParams;

  constructor(
    readonly params: VolBreakoutParams,
    readonly fees: Fees,
  ) {
    this.execution = params;
  }

  warmupBars(): number {
    const p = this.params;
    const htfBars = Math.max(p.bbPeriod + p.squeezeLookback, p.breakoutBars, p.atrPeriod, p.volLookback, p.trendEmaBars) + 2;
    return htfBars * p.barMinutes + p.barMinutes;
  }

  prepare(candles: Candle[]): Prepared {
    const p = this.params;
    const htf = aggregate(candles, p.barMinutes);
    const close = htf.map((c) => c.close);
    const mid = sma(close, p.bbPeriod);
    const sd = rollingStd(close, p.bbPeriod);
    return {
      candles,
      htf,
      map: mapToCompleted(candles, htf, p.barMinutes),
      bandwidth: mid.map((m, k) => (4 * sd[k]!) / m),
      atr: atr(htf, p.atrPeriod),
      volSma: sma(
        htf.map((c) => c.volume),
        p.volLookback,
      ),
      trendEma: p.trendEmaBars > 0 ? ema(close, p.trendEmaBars) : [],
    };
  }

  signalAt(prepared: object, i: number, spreadBps: number): Signal {
    const s = prepared as Prepared;
    const p = this.params;
    const j = s.map[i] ?? -1;
    const bar = j >= 0 ? s.htf[j] : undefined;
    const atrPct = bar ? (s.atr[j]! / bar.close) * 100 : NaN;
    const exits = Number.isFinite(atrPct)
      ? {
          takeProfitPct: Math.max(p.minTakeProfitPct, p.tpAtr * atrPct),
          stopLossPct: Math.max(0.2, Math.min(p.maxStopLossPct, p.slAtr * atrPct)),
        }
      : { takeProfitPct: p.minTakeProfitPct, stopLossPct: p.maxStopLossPct };
    const c = s.candles[i];
    if (!c || !bar || j < 1) return { enter: false, reasons: ['warming up'], metrics: {}, exits };
    // Only act on the minute that completes a new HTF bar.
    if ((s.map[i - 1] ?? -1) === j) return { enter: false, reasons: ['mid-bar'], metrics: {}, exits };

    let priorHigh = -Infinity;
    for (let k = Math.max(0, j - p.breakoutBars); k < j; k++) priorHigh = Math.max(priorHigh, s.htf[k]!.high);
    const squeezeRank = percentileRank(s.bandwidth, j - 1, p.squeezeLookback);
    const volBase = s.volSma[j - 1]!;
    const trend = p.trendEmaBars > 0 ? s.trendEma[j]! : NaN;
    const metrics = {
      close: bar.close,
      priorHigh,
      squeezeRank,
      volRatio: bar.volume / volBase,
      atrPct,
      trendEma: trend,
      spreadBps,
      takeProfitPct: exits.takeProfitPct,
      stopLossPct: exits.stopLossPct,
    };
    if (!Number.isFinite(squeezeRank) || !Number.isFinite(volBase) || !Number.isFinite(atrPct) || j < p.breakoutBars || (p.trendEmaBars > 0 && !Number.isFinite(trend))) {
      return { enter: false, reasons: ['warming up'], metrics, exits };
    }
    const reasons: string[] = [];
    if (squeezeRank > p.squeezePercentile) reasons.push('no squeeze');
    if (!(bar.close > priorHigh)) reasons.push('no breakout');
    if (!(metrics.volRatio >= p.volMult)) reasons.push('volume filter');
    if (p.trendEmaBars > 0 && !(bar.close > trend)) reasons.push('below trend EMA');
    reasons.push(...commonFilters(c.ts, spreadBps, exits, this.execution, this.fees));
    return { enter: reasons.length === 0, reasons, metrics, exits };
  }
}
