import type { Candle, Fees } from '../core/types';
import type { MomentumParams } from '../config/schema';
import { aggregate, ema, mapToCompleted, rocPct, sma } from './indicators';
import { commonFilters, type ExecutionParams, type Signal, type Strategy } from './types';

interface Prepared {
  candles: Candle[];
  emaFast: number[];
  roc: number[];
  volSma: number[];
  emaExt: number[];
  c5: Candle[];
  ema5Fast: number[];
  ema5Slow: number[];
  map5: Int32Array;
}

/**
 * 1-minute momentum scalper with 5-minute trend confirmation.
 *
 * Entry (long only), evaluated on the close of a 1m bar:
 *  - 5m trend: EMA(fast) > EMA(slow) and 5m close above EMA(slow)
 *  - 1m momentum: ROC over `rocBars` >= minRocPct, close > EMA(emaFast1m), bar closed up
 *  - volume: bar volume >= volMult x SMA(volume, volLookback) of prior bars
 *  - not over-extended: close no more than maxExtensionPct above EMA(20)
 *  - common filters: hours, spread, net target after fees
 * Exits are fixed percentages.
 */
export class MomentumStrategy implements Strategy {
  readonly name = 'momentum' as const;
  readonly execution: ExecutionParams;

  constructor(
    readonly params: MomentumParams,
    readonly fees: Fees,
  ) {
    this.execution = params;
  }

  warmupBars(): number {
    const p = this.params;
    return Math.max(p.trendEmaSlow5m * 5 + 10, p.volLookback + 2, p.emaFast1m + 2, 25);
  }

  prepare(candles: Candle[]): Prepared {
    const p = this.params;
    const close = candles.map((c) => c.close);
    const c5 = aggregate(candles, 5);
    const close5 = c5.map((c) => c.close);
    return {
      candles,
      emaFast: ema(close, p.emaFast1m),
      roc: rocPct(close, p.rocBars),
      volSma: sma(
        candles.map((c) => c.volume),
        p.volLookback,
      ),
      emaExt: ema(close, 20),
      c5,
      ema5Fast: ema(close5, p.trendEmaFast5m),
      ema5Slow: ema(close5, p.trendEmaSlow5m),
      map5: mapToCompleted(candles, c5, 5),
    };
  }

  signalAt(prepared: object, i: number, spreadBps: number): Signal {
    const s = prepared as Prepared;
    const p = this.params;
    const exits = { takeProfitPct: p.takeProfitPct, stopLossPct: p.stopLossPct };
    const c = s.candles[i];
    if (!c) return { enter: false, reasons: ['no bar'], metrics: {}, exits };
    const j = s.map5[i] ?? -1;
    const e5f = j >= 0 ? s.ema5Fast[j]! : NaN;
    const e5s = j >= 0 ? s.ema5Slow[j]! : NaN;
    const c5close = j >= 0 ? s.c5[j]!.close : NaN;
    // Volume baseline excludes the current bar so a spike is compared with prior activity.
    const volBase = i >= 1 ? s.volSma[i - 1]! : NaN;
    const metrics = {
      close: c.close,
      roc: s.roc[i]!,
      emaFast: s.emaFast[i]!,
      volRatio: c.volume / volBase,
      extensionPct: ((c.close - s.emaExt[i]!) / s.emaExt[i]!) * 100,
      ema5Fast: e5f,
      ema5Slow: e5s,
      spreadBps,
    };
    if ([metrics.roc, metrics.emaFast, volBase, s.emaExt[i]!, e5f, e5s].some((v) => !Number.isFinite(v))) {
      return { enter: false, reasons: ['warming up'], metrics, exits };
    }
    const reasons: string[] = [];
    if (!(e5f > e5s && c5close > e5s)) reasons.push('5m trend not up');
    if (metrics.roc < p.minRocPct) reasons.push('momentum below threshold');
    if (c.close <= metrics.emaFast) reasons.push('close below 1m EMA');
    if (c.close <= c.open) reasons.push('bar not bullish');
    if (!(metrics.volRatio >= p.volMult)) reasons.push('volume filter');
    if (metrics.extensionPct > p.maxExtensionPct) reasons.push('over-extended');
    reasons.push(...commonFilters(c.ts, spreadBps, exits, this.execution, this.fees));
    return { enter: reasons.length === 0, reasons, metrics, exits };
  }
}
