import ccxt, { type Exchange, type Order } from 'ccxt';
import type { AdapterOrder, AdapterOrderStatus, Balance, MarketInfo } from '../core/types';
import { registerSecret } from '../core/log';
import { LiveAuthorization } from '../safety/liveGate';
import { AmbiguousOrderError, OrderRejectedError, type ExchangeAdapter, type LimitOrderRequest, type MarketOrderRequest } from './adapter';

/**
 * Live CCXT adapter. Construction requires a valid LiveAuthorization, which
 * only verifyLiveGate() can produce. Credentials are read from the
 * environment at construction, registered for log redaction, and never stored
 * or printed.
 *
 * Spot only: no leverage, margin or derivatives params are ever sent.
 */
export class LiveAdapter implements ExchangeAdapter {
  readonly mode = 'live' as const;
  private readonly ex: Exchange;
  private market!: MarketInfo;

  constructor(
    private readonly auth: LiveAuthorization,
    private readonly exchangeId: string,
    private readonly symbol: string,
  ) {
    if (!(auth instanceof LiveAuthorization) || !auth.isValid()) throw new Error('live trading not authorized');
    const apiKey = process.env.JB_API_KEY;
    const secret = process.env.JB_API_SECRET;
    registerSecret(apiKey);
    registerSecret(secret);
    const Ctor = (ccxt as unknown as Record<string, new (cfg: object) => Exchange>)[exchangeId];
    if (!Ctor) throw new Error(`unknown exchange ${exchangeId}`);
    this.ex = new Ctor({ apiKey, secret, enableRateLimit: true, timeout: 15_000, options: { defaultType: 'spot' } });
  }

  async init(): Promise<void> {
    await this.ex.loadMarkets();
    const m = this.ex.market(this.symbol);
    if (!m.spot) throw new Error(`${this.symbol} is not a spot market on ${this.exchangeId}`);
    this.market = {
      symbol: this.symbol,
      minAmount: m.limits.amount?.min ?? 0,
      minCost: m.limits.cost?.min ?? 0,
      amountStep: m.precision.amount ?? 1e-8,
      priceTick: m.precision.price ?? 0.01,
    };
  }

  marketInfo(): MarketInfo {
    return this.market;
  }

  private assertAuth(): void {
    if (!this.auth.isValid()) throw new OrderRejectedError('live authorization expired');
  }

  private mapError(e: unknown): never {
    if (
      e instanceof ccxt.InvalidOrder ||
      e instanceof ccxt.InsufficientFunds ||
      e instanceof ccxt.BadRequest ||
      e instanceof ccxt.PermissionDenied
    ) {
      throw new OrderRejectedError(String((e as Error).message));
    }
    // NetworkError, RequestTimeout, ExchangeNotAvailable, DDoSProtection and anything unexpected:
    // the order may or may not exist.
    throw new AmbiguousOrderError(String((e as Error)?.message ?? e));
  }

  private toAdapter(o: Order): AdapterOrder {
    const status: AdapterOrderStatus =
      o.status === 'open'
        ? 'open'
        : o.status === 'closed'
          ? 'closed'
          : o.status === 'canceled' || o.status === 'expired'
            ? 'canceled'
            : o.status === 'rejected'
              ? 'rejected'
              : 'open';
    let fee = 0;
    for (const f of o.fees ?? (o.fee ? [o.fee] : [])) {
      if (!f?.cost) continue;
      fee += f.currency === 'BTC' ? f.cost * (o.average ?? o.price ?? 0) : f.cost;
    }
    return {
      clientOrderId: o.clientOrderId ?? '',
      exchangeOrderId: o.id ?? '',
      side: o.side as 'buy' | 'sell',
      type: o.type === 'market' ? 'market' : 'limit',
      status,
      price: o.price ?? undefined,
      amount: o.amount ?? 0,
      filled: o.filled ?? 0,
      avgPrice: o.average ?? undefined,
      fee,
      timestamp: o.timestamp ?? Date.now(),
    };
  }

  async createLimitOrder(req: LimitOrderRequest): Promise<AdapterOrder> {
    this.assertAuth();
    try {
      const o = await this.ex.createOrder(this.symbol, 'limit', req.side, req.amount, req.price, {
        clientOrderId: req.clientOrderId,
        postOnly: req.postOnly,
      });
      return { ...this.toAdapter(o), clientOrderId: req.clientOrderId };
    } catch (e) {
      this.mapError(e);
    }
  }

  async createMarketOrder(req: MarketOrderRequest): Promise<AdapterOrder> {
    this.assertAuth();
    try {
      const o = await this.ex.createOrder(this.symbol, 'market', req.side, req.amount, undefined, { clientOrderId: req.clientOrderId });
      return { ...this.toAdapter(o), clientOrderId: req.clientOrderId };
    } catch (e) {
      this.mapError(e);
    }
  }

  async cancelOrder(_clientOrderId: string, exchangeOrderId?: string | null): Promise<void> {
    if (!exchangeOrderId) throw new OrderRejectedError('exchange order id unknown; reconcile first');
    await this.ex.cancelOrder(exchangeOrderId, this.symbol);
  }

  async fetchOrderByClientId(clientOrderId: string, sinceMs?: number): Promise<AdapterOrder | null> {
    const open = await this.ex.fetchOpenOrders(this.symbol);
    const hit = open.find((o) => o.clientOrderId === clientOrderId);
    if (hit) return { ...this.toAdapter(hit), clientOrderId };
    const closed = await this.ex.fetchClosedOrders(this.symbol, sinceMs);
    const c = closed.find((o) => o.clientOrderId === clientOrderId);
    return c ? { ...this.toAdapter(c), clientOrderId } : null;
  }

  async fetchOpenOrders(): Promise<AdapterOrder[]> {
    return (await this.ex.fetchOpenOrders(this.symbol)).map((o) => this.toAdapter(o));
  }

  async fetchBalance(): Promise<Balance> {
    const b = await this.ex.fetchBalance();
    const total = b.total as unknown as Record<string, number | undefined>;
    return { usd: total.USD ?? 0, btc: total.BTC ?? 0 };
  }
}
