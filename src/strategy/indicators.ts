import type { Candle } from '../core/types';

/** EMA series; entries before the seed period are NaN. Seeded with an SMA. */
export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i]!;
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Rate of change in percent over `bars`. */
export function rocPct(values: number[], bars: number): number[] {
  return values.map((v, i) => (i >= bars ? ((v - values[i - bars]!) / values[i - bars]!) * 100 : NaN));
}

/**
 * Aggregate 1m candles into N-minute candles aligned to UTC boundaries.
 * A bucket is emitted once its last 1-minute bar arrives (or, across a data
 * gap, once a later bucket starts). The trailing in-progress bucket is never
 * emitted, so no look-ahead leaks into the higher timeframe.
 */
export function aggregate(candles1m: Candle[], minutes: number): Candle[] {
  const size = minutes * 60_000;
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let count = 0;
  for (const c of candles1m) {
    const bucket = Math.floor(c.ts / size) * size;
    if (!cur || cur.ts !== bucket) {
      if (cur && count > 0) out.push(cur);
      cur = { ts: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
      count = 1;
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
      count++;
    }
    const isLastMinute = c.ts + 60_000 === bucket + size;
    if (isLastMinute && cur) {
      out.push(cur);
      cur = null;
      count = 0;
    }
  }
  // A trailing partial bucket is intentionally dropped.
  return out;
}

/** Average true range (Wilder smoothing). */
export function atr(candles: Candle[], period: number): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  let prev = NaN;
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const pc = i > 0 ? candles[i - 1]!.close : c.close;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    if (i < period) {
      sum += tr;
      if (i === period - 1) out[i] = prev = sum / period;
    } else {
      prev = (prev * (period - 1) + tr) / period;
      out[i] = prev;
    }
  }
  return out;
}

/** Relative strength index (Wilder). */
export function rsi(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    const g = Math.max(0, d);
    const l = Math.max(0, -d);
    if (i <= period) {
      gain += g;
      loss += l;
      if (i === period) {
        gain /= period;
        loss /= period;
        out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      }
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

/** Rolling volume-weighted average of typical price over `period` bars. */
export function rollingVwap(candles: Candle[], period: number): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  let pv = 0;
  let v = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    pv += ((c.high + c.low + c.close) / 3) * c.volume;
    v += c.volume;
    if (i >= period) {
      const o = candles[i - period]!;
      pv -= ((o.high + o.low + o.close) / 3) * o.volume;
      v -= o.volume;
    }
    if (i >= period - 1) out[i] = v > 0 ? pv / v : c.close;
  }
  return out;
}

/** Rolling population standard deviation. */
export function rollingStd(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < values.length; i++) {
    s += values[i]!;
    s2 += values[i]! ** 2;
    if (i >= period) {
      s -= values[i - period]!;
      s2 -= values[i - period]! ** 2;
    }
    if (i >= period - 1) out[i] = Math.sqrt(Math.max(0, s2 / period - (s / period) ** 2));
  }
  return out;
}

/** Percentile rank (0-100) of values[i] within the `lookback` values before it. */
export function percentileRank(values: number[], i: number, lookback: number): number {
  const v = values[i]!;
  if (i < lookback || !Number.isFinite(v)) return NaN;
  let below = 0;
  let n = 0;
  for (let k = i - lookback; k < i; k++) {
    const x = values[k]!;
    if (!Number.isFinite(x)) continue;
    n++;
    if (x < v) below++;
  }
  return n ? (below / n) * 100 : NaN;
}

/** For each 1m index, the index of the latest COMPLETED higher-timeframe bar (or -1). */
export function mapToCompleted(candles1m: Candle[], htf: Candle[], minutes: number): Int32Array {
  const map = new Int32Array(candles1m.length).fill(-1);
  let j = -1;
  for (let i = 0; i < candles1m.length; i++) {
    const barEnd = candles1m[i]!.ts + 60_000;
    while (j + 1 < htf.length && htf[j + 1]!.ts + minutes * 60_000 <= barEnd) j++;
    map[i] = j;
  }
  return map;
}
