import type { FillRecord, Side } from '../domain';
import type { OrderBook } from '../market/book';
import { FEE_STEP, ZERO, dec, min, mul, quantize, str, type Dec } from '../money';

export interface ExecParams {
  takerRate: Dec;
  participation: Dec;
  guardBps: number;
  baseIncrement: Dec;
  baseMinSize: Dec;
}

export interface ExecInput {
  orderId: string;
  sessionId: string;
  side: Side;
  /** Remaining quantity to fill. */
  qty: Dec;
  guardPrice: Dec;
  /** Fills already recorded for this order (for deterministic fill ids). */
  priorFills: number;
  time: number;
  ordinal: number;
}

export interface ExecResult {
  fills: FillRecord[];
  /** Why the unfilled remainder was cancelled or the order rejected. */
  remainder: { qty: Dec; reason: string } | null;
  rejected: string | null;
}

/**
 * Paper broker, fill model `ioc-depth-walk-v1` (plan section 6):
 *
 *  - Market orders are immediate-or-cancel, executed once, at the first
 *    healthy book state whose receipt time is at or after simulated arrival.
 *  - Buys walk asks, sells walk bids, level by level, consuming at most
 *    `participation` of each displayed level, never beyond the execution guard
 *    (the tighter of the order's guard price and `guardBps` from the touch at
 *    arrival). Buying at the ask / selling at the bid already includes spread;
 *    no extra spread is charged.
 *  - Liquidity our own simulated orders consumed is remembered per level so
 *    concurrent orders cannot refill against the same unchanged depth.
 *    Replenishment rule: when the venue publishes a new absolute quantity for a
 *    level, our consumption memory for that level is cleared. Counterfactual
 *    market impact is NOT modelled (disclosed in reports).
 *  - Taker fee on each fill's notional, in USD, rounded up to 0.00000001.
 *  - The unfilled remainder is cancelled (IOC); no fill at all is a rejection.
 */
export class PaperBroker {
  private consumed = new Map<string, Dec>();

  constructor(private readonly p: ExecParams) {}

  /** Call for every observed level change (book_update) and on snapshot/reset. */
  onLevelChange(side: 'bid' | 'ask', price: string): void {
    this.consumed.delete(`${side}:${price}`);
  }

  resetConsumption(): void {
    this.consumed.clear();
  }

  execute(book: OrderBook, o: ExecInput): ExecResult {
    const bookSide = o.side === 'buy' ? 'ask' : 'bid';
    const touch = o.side === 'buy' ? book.bestAsk() : book.bestBid();
    if (!touch) return { fills: [], remainder: null, rejected: 'no liquidity on book' };
    const g = dec(String(this.p.guardBps / 10_000));
    const touchGuard = o.side === 'buy' ? mul(touch.price, dec('1') + g, 'floor') : mul(touch.price, dec('1') - g, 'ceil');
    const limit = o.side === 'buy' ? min(touchGuard, o.guardPrice) : touchGuard > o.guardPrice ? touchGuard : o.guardPrice;

    let remaining = o.qty;
    const fills: FillRecord[] = [];
    for (const lvl of book.levels(bookSide, 500)) {
      if (remaining <= ZERO) break;
      if (o.side === 'buy' ? lvl.price > limit : lvl.price < limit) break;
      const key = `${bookSide}:${str(lvl.price)}`;
      const cap = quantize(mul(lvl.qty, this.p.participation, 'floor'), this.p.baseIncrement, 'floor');
      const avail = cap - (this.consumed.get(key) ?? ZERO);
      if (avail <= ZERO) continue;
      const take = quantize(min(remaining, avail), this.p.baseIncrement, 'floor');
      if (take < this.p.baseMinSize || take <= ZERO) continue;
      const notional = mul(lvl.price, take, 'halfEven');
      const fee = quantize(mul(notional, this.p.takerRate, 'ceil'), FEE_STEP, 'ceil');
      fills.push({
        fillId: `${o.orderId}:f${o.priorFills + fills.length + 1}`,
        orderId: o.orderId,
        sessionId: o.sessionId,
        side: o.side,
        price: str(lvl.price),
        qty: str(take),
        fee: str(fee),
        liquidity: 'taker',
        eventOrdinal: o.ordinal,
        time: o.time,
      });
      this.consumed.set(key, (this.consumed.get(key) ?? ZERO) + take);
      remaining -= take;
    }
    if (fills.length === 0) return { fills, remainder: null, rejected: 'insufficient depth within execution guard' };
    return {
      fills,
      remainder:
        remaining > ZERO ? { qty: remaining, reason: 'IOC remainder cancelled: depth within guard/participation exhausted' } : null,
      rejected: null,
    };
  }
}
