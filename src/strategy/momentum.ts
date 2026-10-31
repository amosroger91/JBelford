import type { Candle, Fees } from '../core/types';
import type { StrategyParams } from '../config/schema';
import { netTargetPct } from '../economics/costs';
import { aggregate, ema, rocPct, sma } from './indicators';

export interface PreparedSeries {
  candles: Candle[];
  close: number[];
  emaFast: number[];
  roc: number[];
  volSma: number[];
  emaExt: number[];
  c5: Candle[];
  ema5Fast: number[];
  ema5Slow: number[];
  /** For each 1m index, the index of the latest COMPLETED 5m bar, or -1. */
  map5: Int32Array;
}

export interface Signal {
  enter: boolean;
  reasons: string[];
  metrics: Record<string, number>;
}

/**
 * 1-minute momentum scalper with 5-minute trend confirmation.
 *
 * Entry (long only), evaluated on the close of a 1m bar:
 *  - 5m trend: EMA(fast) > EMA(slow) and 5m close above EMA(slow)
 *  - 1m momentum: ROC over `rocBars` >= minRocPct, close > EMA(emaFast1m), bar closed up
 *  - volume: bar volume >= volMult x SMA(volume, volLookback)
 *  - not over-extended: close no more than maxExtensionPct above EMA(20)
 *  - spread <= maxSpreadBps
 *  - net take-profit after maker fees >= minNetTargetPct
 * Exits are fixed: take profit, stop loss, max hold time.
 */
export class MomentumStrategy {
  constructor(
    readonly params: StrategyParams,
    readonly fees: Fees,
  ) {}

  /** Bars needed before signals are meaningful. */
  warmupBars(): number {
    const p = this.params;
    return Math.max(p.trendEmaSlow5m * 5 + 10, p.volLookback + 2, p.emaFast1m + 2, 25);
  }

  prepare(candles: Candle[]): PreparedSeries {
    const p = this.params;
    const close = candles.map((c) => c.close);
    const c5 = aggregate(candles, 5);
    const close5 = c5.map((c) => c.close);
    const map5 = new Int32Array(candles.length).fill(-1);
    let j = -1;
    for (let i = 0; i < candles.length; i++) {
      const barEnd = candles[i]!.ts + 60_000;
      while (j + 1 < c5.length && c5[j + 1]!.ts + 5 * 60_000 <= barEnd) j++;
      map5[i] = j;
    }
    return {
      candles,
      close,
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
      map5,
    };
  }

  /** Evaluate the entry rule using only data up to and including bar `i`. */
  signalAt(s: PreparedSeries, i: number, spreadBps: number): Signal {
    const p = this.params;
    const reasons: string[] = [];
    const c = s.candles[i];
    if (!c) return { enter: false, reasons: ['no bar'], metrics: {} };
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
      netTargetPct: netTargetPct(p.takeProfitPct, this.fees),
    };

    if ([metrics.roc, metrics.emaFast, volBase, s.emaExt[i]!, e5f, e5s].some((v) => !Number.isFinite(v))) {
      return { enter: false, reasons: ['warming up'], metrics };
    }
    if (!(e5f > e5s && c5close > e5s)) reasons.push('5m trend not up');
    if (metrics.roc < p.minRocPct) reasons.push('momentum below threshold');
    if (c.close <= metrics.emaFast) reasons.push('close below 1m EMA');
    if (c.close <= c.open) reasons.push('bar not bullish');
    if (!(metrics.volRatio >= p.volMult)) reasons.push('volume filter');
    if (metrics.extensionPct > p.maxExtensionPct) reasons.push('over-extended');
    if (!(spreadBps <= p.maxSpreadBps)) reasons.push('spread too wide');
    if (metrics.netTargetPct < p.minNetTargetPct) reasons.push('net target after fees too small');
    return { enter: reasons.length === 0, reasons, metrics };
  }

  exitLevels(entryPrice: number): { takeProfit: number; stop: number } {
    return {
      takeProfit: entryPrice * (1 + this.params.takeProfitPct / 100),
      stop: entryPrice * (1 - this.params.stopLossPct / 100),
    };
  }
}
