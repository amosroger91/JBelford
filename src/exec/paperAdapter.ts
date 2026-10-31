import type { AdapterOrder, Balance, Fees, MarketInfo, TopOfBook } from '../core/types';
import type { Store } from '../persistence/store';
import { makeRng } from '../core/util';
import { AmbiguousOrderError, OrderRejectedError, type ExchangeAdapter, type LimitOrderRequest, type MarketOrderRequest } from './adapter';

interface PaperOrder extends AdapterOrder {
  postOnly: boolean;
}

interface PaperState {
  balance: Balance;
  orders: Record<string, PaperOrder>;
  seq: number;
}

export interface PaperOptions {
  startingUsd: number;
  fees: Fees;
  takerSlippageBps: number;
  market: MarketInfo;
  faults?: { ambiguousCreateRate: number; rejectRate: number };
  seed?: number;
  /** Max quote age for market orders. */
  maxQuoteAgeMs?: number;
  now?: () => number;
}

const STATE_KEY = 'paper.state';

/**
 * Paper exchange. Never talks to a real exchange's private API.
 *
 * Fill model (conservative, models non-fills and adverse selection):
 *  - A resting limit BUY at P fills only when the market trades or offers
 *    strictly BELOW P (ask < P, or a print < P). Touching P is not enough,
 *    because our place in the queue is unknown. So a maker buy only fills when
 *    price has moved through it, i.e. against us.
 *  - A resting limit SELL at P fills only when bid > P or a print > P.
 *  - Post-only orders that would cross the book are rejected.
 *  - Market orders fill at the touch plus `takerSlippageBps`, with taker fee.
 * State is persisted so restarts and reconciliation behave like a real venue.
 */
export class PaperAdapter implements ExchangeAdapter {
  readonly mode = 'paper' as const;
  private state: PaperState;
  private book: TopOfBook | null = null;
  private readonly rng: () => number;
  private readonly now: () => number;

  constructor(
    private readonly store: Store,
    private readonly opts: PaperOptions,
  ) {
    this.rng = makeRng(opts.seed ?? 42);
    this.now = opts.now ?? Date.now;
    this.state = store.getKv<PaperState>(STATE_KEY) ?? {
      balance: { usd: opts.startingUsd, btc: 0 },
      orders: {},
      seq: 0,
    };
    this.save();
  }

  marketInfo(): MarketInfo {
    return this.opts.market;
  }

  private save(): void {
    this.store.setKv(STATE_KEY, this.state, this.now());
  }

  private reserved(): { usd: number; btc: number } {
    let usd = 0;
    let btc = 0;
    for (const o of Object.values(this.state.orders)) {
      if (o.status !== 'open') continue;
      const rem = o.amount - o.filled;
      if (o.side === 'buy') usd += rem * (o.price ?? 0) * (1 + this.opts.fees.maker);
      else btc += rem;
    }
    return { usd, btc };
  }

  private maybeFault(): 'none' | 'reject' | 'ambiguous_created' | 'ambiguous_lost' {
    const f = this.opts.faults;
    if (!f) return 'none';
    const r = this.rng();
    if (r < f.rejectRate) return 'reject';
    if (r < f.rejectRate + f.ambiguousCreateRate) return this.rng() < 0.5 ? 'ambiguous_created' : 'ambiguous_lost';
    return 'none';
  }

  async createLimitOrder(req: LimitOrderRequest): Promise<AdapterOrder> {
    if (this.state.orders[req.clientOrderId]) {
      throw new OrderRejectedError(`duplicate clientOrderId ${req.clientOrderId}`);
    }
    const fault = this.maybeFault();
    if (fault === 'reject') throw new OrderRejectedError('simulated rejection');
    if (fault === 'ambiguous_lost') throw new AmbiguousOrderError('simulated timeout (order not created)');

    const m = this.opts.market;
    if (req.amount < m.minAmount) throw new OrderRejectedError('amount below minimum');
    if (req.amount * req.price < m.minCost) throw new OrderRejectedError('cost below minimum');
    if (req.postOnly && this.book) {
      if (req.side === 'buy' && req.price >= this.book.ask) throw new OrderRejectedError('post-only buy would take liquidity');
      if (req.side === 'sell' && req.price <= this.book.bid) throw new OrderRejectedError('post-only sell would take liquidity');
    }
    const free = this.freeBalance();
    if (req.side === 'buy' && req.amount * req.price * (1 + this.opts.fees.maker) > free.usd + 1e-9) {
      throw new OrderRejectedError('insufficient USD');
    }
    if (req.side === 'sell' && req.amount > free.btc + 1e-12) throw new OrderRejectedError('insufficient BTC');

    const o: PaperOrder = {
      clientOrderId: req.clientOrderId,
      exchangeOrderId: `P${++this.state.seq}`,
      side: req.side,
      type: 'limit',
      status: 'open',
      price: req.price,
      amount: req.amount,
      filled: 0,
      fee: 0,
      timestamp: this.now(),
      postOnly: req.postOnly,
    };
    this.state.orders[o.clientOrderId] = o;
    this.save();
    if (fault === 'ambiguous_created') throw new AmbiguousOrderError('simulated timeout (order was created)');
    return { ...o };
  }

  async createMarketOrder(req: MarketOrderRequest): Promise<AdapterOrder> {
    if (this.state.orders[req.clientOrderId]) throw new OrderRejectedError(`duplicate clientOrderId ${req.clientOrderId}`);
    const fault = this.maybeFault();
    if (fault === 'reject') throw new OrderRejectedError('simulated rejection');
    if (fault === 'ambiguous_lost') throw new AmbiguousOrderError('simulated timeout (order not created)');
    const b = this.book;
    if (!b || this.now() - b.ts > (this.opts.maxQuoteAgeMs ?? 30_000)) throw new OrderRejectedError('no fresh quote for market order');
    const slip = this.opts.takerSlippageBps / 10_000;
    const px = req.side === 'buy' ? b.ask * (1 + slip) : b.bid * (1 - slip);
    const free = this.freeBalance();
    if (req.side === 'sell' && req.amount > free.btc + 1e-12) throw new OrderRejectedError('insufficient BTC');
    if (req.side === 'buy' && req.amount * px * (1 + this.opts.fees.taker) > free.usd + 1e-9)
      throw new OrderRejectedError('insufficient USD');
    const o: PaperOrder = {
      clientOrderId: req.clientOrderId,
      exchangeOrderId: `P${++this.state.seq}`,
      side: req.side,
      type: 'market',
      status: 'open',
      amount: req.amount,
      filled: 0,
      fee: 0,
      timestamp: this.now(),
      postOnly: false,
    };
    this.state.orders[o.clientOrderId] = o;
    this.applyFill(o, req.amount, px, this.opts.fees.taker);
    this.save();
    if (fault === 'ambiguous_created') throw new AmbiguousOrderError('simulated timeout (order was created)');
    return { ...o };
  }

  async cancelOrder(clientOrderId: string): Promise<void> {
    const o = this.state.orders[clientOrderId];
    if (!o) throw new OrderRejectedError('order not found');
    if (o.status === 'open') {
      o.status = 'canceled';
      this.save();
    }
  }

  async fetchOrderByClientId(clientOrderId: string): Promise<AdapterOrder | null> {
    const o = this.state.orders[clientOrderId];
    return o ? { ...o } : null;
  }

  async fetchOpenOrders(): Promise<AdapterOrder[]> {
    return Object.values(this.state.orders)
      .filter((o) => o.status === 'open')
      .map((o) => ({ ...o }));
  }

  async fetchBalance(): Promise<Balance> {
    return { ...this.state.balance };
  }

  freeBalance(): Balance {
    const r = this.reserved();
    return { usd: this.state.balance.usd - r.usd, btc: this.state.balance.btc - r.btc };
  }

  // ---------- market simulation hooks ----------

  /** Feed the latest top of book. Crossing quotes fill resting orders. */
  onBook(book: TopOfBook): void {
    this.book = book;
    let changed = false;
    for (const o of Object.values(this.state.orders)) {
      if (o.status !== 'open' || o.type !== 'limit' || o.price === undefined) continue;
      if ((o.side === 'buy' && book.ask < o.price) || (o.side === 'sell' && book.bid > o.price)) {
        this.applyFill(o, o.amount - o.filled, o.price, this.opts.fees.maker);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /** Feed a trade print (or a candle low/high) that occurred at `ts`. */
  onPrint(price: number, ts: number): void {
    let changed = false;
    for (const o of Object.values(this.state.orders)) {
      if (o.status !== 'open' || o.type !== 'limit' || o.price === undefined || ts < o.timestamp) continue;
      if ((o.side === 'buy' && price < o.price) || (o.side === 'sell' && price > o.price)) {
        this.applyFill(o, o.amount - o.filled, o.price, this.opts.fees.maker);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private applyFill(o: PaperOrder, qty: number, price: number, feeRate: number): void {
    if (qty <= 0) return;
    const fee = qty * price * feeRate;
    const prevCost = (o.avgPrice ?? 0) * o.filled;
    o.filled += qty;
    o.avgPrice = (prevCost + qty * price) / o.filled;
    o.fee += fee;
    if (o.side === 'buy') {
      this.state.balance.usd -= qty * price + fee;
      this.state.balance.btc += qty;
    } else {
      this.state.balance.usd += qty * price - fee;
      this.state.balance.btc -= qty;
    }
    if (o.filled >= o.amount - 1e-12) o.status = 'closed';
  }
}
