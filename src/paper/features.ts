import type { Candle } from './domain';
import { dec, max, min, str, type Dec } from './money';

interface Building {
  start: number;
  open: Dec;
  high: Dec;
  low: Dec;
  close: Dec;
  volume: Dec;
}

/**
 * Causal five-minute bars built from venue trades, bucketed by exchange trade
 * time. A bar is COMPLETE only once the event clock (receipt time) passes its
 * end plus `graceMs`. Completed bars are immutable: trades arriving later for
 * an already-completed bucket are counted as late and never revise it, so no
 * future or revised value can enter an earlier decision snapshot.
 */
export class BarBuilder {
  private bars: Candle[] = [];
  private building = new Map<number, Building>();
  private seenTrades = new Set<string>();
  private seenOrder: string[] = [];
  lateTrades = 0;
  duplicateTrades = 0;

  constructor(
    readonly barMs = 300_000,
    readonly graceMs = 2_000,
    private readonly keep = 2_000,
  ) {}

  /** Seed with completed historical candles (warmup). Never overwrites completed bars. */
  seed(candles: Candle[]): void {
    const last = this.bars.at(-1)?.start ?? -Infinity;
    for (const c of candles) if (c.start > last) this.bars.push(c);
    this.bars.sort((a, b) => a.start - b.start);
    this.trim();
  }

  lastCompletedStart(): number | null {
    return this.bars.at(-1)?.start ?? null;
  }

  onTrade(tradeId: string, price: string, size: string, exchangeTime: number): void {
    if (this.seenTrades.has(tradeId)) {
      this.duplicateTrades++;
      return;
    }
    this.seenTrades.add(tradeId);
    this.seenOrder.push(tradeId);
    if (this.seenOrder.length > 20_000) this.seenTrades.delete(this.seenOrder.shift()!);
    const start = Math.floor(exchangeTime / this.barMs) * this.barMs;
    const lastDone = this.bars.at(-1)?.start ?? -Infinity;
    if (start <= lastDone) {
      this.lateTrades++;
      return;
    }
    const p = dec(price);
    const q = dec(size);
    const b = this.building.get(start);
    if (!b) this.building.set(start, { start, open: p, high: p, low: p, close: p, volume: q });
    else {
      b.high = max(b.high, p);
      b.low = min(b.low, p);
      b.close = p;
      b.volume += q;
    }
  }

  /** Advance the event clock. Returns bars that completed at this instant (oldest first). */
  advance(nowReceipt: number): Candle[] {
    const done: Candle[] = [];
    for (const start of [...this.building.keys()].sort((a, b) => a - b)) {
      if (nowReceipt < start + this.barMs + this.graceMs) break;
      const b = this.building.get(start)!;
      this.building.delete(start);
      const lastDone = this.bars.at(-1)?.start ?? -Infinity;
      if (start <= lastDone) continue;
      const c: Candle = { start, open: str(b.open), high: str(b.high), low: str(b.low), close: str(b.close), volume: str(b.volume) };
      this.bars.push(c);
      done.push(c);
    }
    this.trim();
    return done;
  }

  /** Completed bars only, oldest first (a copy: callers cannot mutate history). */
  completed(n?: number): Candle[] {
    return (n === undefined ? this.bars : this.bars.slice(-n)).map((c) => ({ ...c }));
  }

  private trim(): void {
    if (this.bars.length > this.keep) this.bars.splice(0, this.bars.length - this.keep);
  }
}

// ---------- float indicators on completed bars (statistics only) ----------

export function closes(bars: Candle[]): number[] {
  return bars.map((b) => Number(b.close));
}

export function emaLast(values: number[], period: number): number {
  if (values.length < period) return NaN;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i]! * k + e * (1 - k);
  return e;
}

export function rsiLast(values: number[], period: number): number {
  if (values.length <= period) return NaN;
  let g = 0;
  let l = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i]! - values[i - 1]!;
    g += Math.max(0, d);
    l += Math.max(0, -d);
  }
  g /= period;
  l /= period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    g = (g * (period - 1) + Math.max(0, d)) / period;
    l = (l * (period - 1) + Math.max(0, -d)) / period;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
