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
