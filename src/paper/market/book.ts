import { ZERO, dec, mul, str, type Dec } from '../money';
import type { Level } from '../domain';

interface PL {
  price: Dec;
  qty: Dec;
}

/**
 * Level 2 order book. Coinbase `new_quantity` is the ABSOLUTE size at a price
 * level (not a delta); zero removes the level. Bids and asks are kept in
 * independent sorted arrays (bids descending, asks ascending).
 */
export class OrderBook {
  private bids: PL[] = [];
  private asks: PL[] = [];
  /** Bumped on every applied change; used for liquidity-consumption bookkeeping. */
  version = 0;
  synced = false;

  reset(): void {
    this.bids = [];
    this.asks = [];
    this.synced = false;
    this.version++;
  }

  loadSnapshot(bids: Level[], asks: Level[]): void {
    const parse = (ls: Level[]) => ls.map((l) => ({ price: dec(l.price), qty: dec(l.qty) })).filter((l) => l.qty > ZERO);
    this.bids = parse(bids).sort((a, b) => (a.price > b.price ? -1 : a.price < b.price ? 1 : 0));
    this.asks = parse(asks).sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
    this.synced = true;
    this.version++;
  }

  /** Apply an absolute-quantity change. Returns the previous quantity at that level. */
  set(side: 'bid' | 'ask', price: Dec, qty: Dec): Dec {
    const arr = side === 'bid' ? this.bids : this.asks;
    const better = side === 'bid' ? (a: Dec, b: Dec) => a > b : (a: Dec, b: Dec) => a < b;
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (better(arr[m]!.price, price)) lo = m + 1;
      else hi = m;
    }
    const found = lo < arr.length && arr[lo]!.price === price;
    const prev = found ? arr[lo]!.qty : ZERO;
    if (qty === ZERO) {
      if (found) arr.splice(lo, 1);
    } else if (found) {
      arr[lo]!.qty = qty;
    } else {
      arr.splice(lo, 0, { price, qty });
    }
    this.version++;
    return prev;
  }

  bestBid(): PL | undefined {
    return this.bids[0];
  }
  bestAsk(): PL | undefined {
    return this.asks[0];
  }

  crossed(): boolean {
    const b = this.bids[0];
    const a = this.asks[0];
    return !!b && !!a && b.price >= a.price;
  }

  /** Top `n` levels of a side (best first). */
  levels(side: 'bid' | 'ask', n: number): PL[] {
    return (side === 'bid' ? this.bids : this.asks).slice(0, n);
  }

  depthCount(): { bids: number; asks: number } {
    return { bids: this.bids.length, asks: this.asks.length };
  }

  /** USD notional resting at the touch. */
  touchDepthUsd(side: 'bid' | 'ask'): Dec {
    const l = side === 'bid' ? this.bids[0] : this.asks[0];
    return l ? mul(l.price, l.qty) : ZERO;
  }

  midpoint(): Dec | null {
    const b = this.bids[0];
    const a = this.asks[0];
    return b && a ? (b.price + a.price) / 2n : null;
  }

  summary(): { bestBid: string | null; bestAsk: string | null; bidLevels: number; askLevels: number } {
    return {
      bestBid: this.bids[0] ? str(this.bids[0].price) : null,
      bestAsk: this.asks[0] ? str(this.asks[0].price) : null,
      bidLevels: this.bids.length,
      askLevels: this.asks.length,
    };
  }
}
