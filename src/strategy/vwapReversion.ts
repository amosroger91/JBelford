import type { Candle, Fees } from '../core/types';
import type { VwapReversionParams } from '../config/schema';
import { rollingVwap, rsi, sma } from './indicators';
import { commonFilters, type ExecutionParams, type Signal, type Strategy } from './types';

interface Prepared {
  candles: Candle[];
  vwap: number[];
  rsi: number[];
  volSma: number[];
}

/**
 * Intraday VWAP mean reversion (long only).
 *
 * Idea: sharp, high-volume sell-offs that stretch price well below the rolling
 * VWAP tend to partially revert within minutes to hours. The take-profit is
 * sized to the stretch, so targets are large enough to clear fees.
 *
 * Entry on a 1m close when:
 *  - close is at least minDevPct below the rolling VWAP(vwapBars)
 *  - RSI(rsiPeriod) was <= rsiMax on this or the previous bar (oversold)
 *  - this bar closed up (first sign of reversal, not catching the falling bar)
 *  - one of the last 3 bars had volume >= volMult x prior average (capitulation)
 *  - crash guard: price fell no more than maxCrashPct over crashLookbackBars
 *  - common filters: hours, spread, net target after fees
 * Exits: take profit = clamp(revertFraction x deviation, min, max), fixed stop.
 */
export class VwapReversionStrategy implements Strategy {
  readonly name = 'vwapReversion' as const;
  readonly execution: ExecutionParams;

  constructor(
    readonly params: VwapReversionParams,
    readonly fees: Fees,
  ) {
    this.execution = params;
  }

  warmupBars(): number {
    const p = this.params;
    return Math.max(p.vwapBars, p.crashLookbackBars, p.volLookback + 4, p.rsiPeriod + 2) + 1;
  }

  prepare(candles: Candle[]): Prepared {
    const p = this.params;
    return {
      candles,
      vwap: rollingVwap(candles, p.vwapBars),
      rsi: rsi(
        candles.map((c) => c.close),
        p.rsiPeriod,
      ),
      volSma: sma(
        candles.map((c) => c.volume),
        p.volLookback,
      ),
    };
  }

  signalAt(prepared: object, i: number, spreadBps: number): Signal {
    const s = prepared as Prepared;
    const p = this.params;
    const c = s.candles[i];
    const fallbackExits = { takeProfitPct: p.minTakeProfitPct, stopLossPct: p.stopLossPct };
    if (!c || i < this.warmupBars()) return { enter: false, reasons: ['warming up'], metrics: {}, exits: fallbackExits };

    const vwap = s.vwap[i]!;
    const devPct = ((c.close - vwap) / vwap) * 100;
    const exits = {
      takeProfitPct: Math.min(p.maxTakeProfitPct, Math.max(p.minTakeProfitPct, p.revertFraction * Math.abs(devPct))),
      stopLossPct: p.stopLossPct,
    };
    const volBase = s.volSma[i - 3]!; // average before the capitulation window
    let maxVol = 0;
    for (let k = i - 2; k <= i; k++) maxVol = Math.max(maxVol, s.candles[k]!.volume);
    const past = s.candles[i - p.crashLookbackBars]!.close;
    const metrics = {
      close: c.close,
      vwap,
      devPct,
      rsi: s.rsi[i]!,
      rsiPrev: s.rsi[i - 1]!,
      volRatio: maxVol / volBase,
      crashPct: ((c.close - past) / past) * 100,
      spreadBps,
      takeProfitPct: exits.takeProfitPct,
    };
    if ([vwap, metrics.rsi, metrics.rsiPrev, volBase].some((v) => !Number.isFinite(v))) {
      return { enter: false, reasons: ['warming up'], metrics, exits };
    }
    const reasons: string[] = [];
    if (devPct > -p.minDevPct) reasons.push('not stretched below VWAP');
    if (Math.min(metrics.rsi, metrics.rsiPrev) > p.rsiMax) reasons.push('not oversold');
    if (c.close <= c.open) reasons.push('no reversal bar');
    if (!(metrics.volRatio >= p.volMult)) reasons.push('no capitulation volume');
    if (metrics.crashPct < -p.maxCrashPct) reasons.push('crash guard');
    reasons.push(...commonFilters(c.ts, spreadBps, exits, this.execution, this.fees));
    return { enter: reasons.length === 0, reasons, metrics, exits };
  }
}
