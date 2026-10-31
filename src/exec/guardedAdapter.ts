import type { AdapterOrder, Balance, MarketInfo } from '../core/types';
import type { RiskEngine } from '../risk/engine';
import type { Store } from '../persistence/store';
import {
  RiskViolationError,
  type ExchangeAdapter,
  type LimitOrderRequest,
  type MarketOrderRequest,
} from './adapter';

/**
 * Last line of defense: every order passes through here before it reaches any
 * adapter, whatever the engine or strategy decided. Enforces invariants that
 * must hold for EVERY order, including exits:
 *  - BTC/USD only, spot only (adapters never set leverage/margin params)
 *  - buys: post-only limit entries only, <= max order value, never while halted,
 *    never with a position already open
 *  - sells: never more than the tracked position or the BTC balance (no shorting)
 */
export class GuardedAdapter implements ExchangeAdapter {
  constructor(
    private readonly inner: ExchangeAdapter,
    private readonly risk: RiskEngine,
    private readonly store: Store,
    private readonly refPrice: () => number,
    private readonly now: () => number = Date.now,
  ) {}

  get mode() {
    return this.inner.mode;
  }

  marketInfo(): MarketInfo {
    return this.inner.marketInfo();
  }

  private async checkSell(amount: number, price: number): Promise<void> {
    const pos = this.store.openPosition();
    const L = this.risk.limits;
    if (!pos) throw new RiskViolationError('sell without an open position (no shorting)');
    if (amount > pos.amount + 1e-12) throw new RiskViolationError(`sell ${amount} exceeds position ${pos.amount}`);
    const bal = await this.inner.fetchBalance();
    if (amount > bal.btc + 1e-12) throw new RiskViolationError(`sell ${amount} exceeds BTC balance ${bal.btc}`);
    if (amount * price > L.maxOrderValueUsd * L.exitValueTolerance) {
      throw new RiskViolationError('exit order value exceeds cap with tolerance');
    }
  }

  private checkBuy(clientOrderId: string, amount: number, price: number): void {
    const L = this.risk.limits;
    const now = this.now();
    const halt = this.risk.activeHalt(now);
    if (halt) throw new RiskViolationError(`buy blocked, halted: ${halt.reason}`);
    if (this.store.openPosition()) throw new RiskViolationError('buy blocked: position already open');
    if (this.store.openOrders().some((o) => o.side === 'buy' && o.clientOrderId !== clientOrderId)) throw new RiskViolationError('buy blocked: entry already working');
    if (!(price > 0) || amount * price > L.maxOrderValueUsd + 1e-9) {
      throw new RiskViolationError(`buy value ${(amount * price).toFixed(2)} exceeds $${L.maxOrderValueUsd}`);
    }
  }

  async createLimitOrder(req: LimitOrderRequest): Promise<AdapterOrder> {
    if (this.marketInfo().symbol !== this.risk.limits.symbol) throw new RiskViolationError('symbol not allowed');
    if (req.side === 'buy') {
      if (!req.postOnly) throw new RiskViolationError('entries must be post-only limit orders');
      this.checkBuy(req.clientOrderId, req.amount, req.price);
    } else {
      await this.checkSell(req.amount, req.price);
    }
    return this.inner.createLimitOrder(req);
  }

  async createMarketOrder(req: MarketOrderRequest): Promise<AdapterOrder> {
    if (this.marketInfo().symbol !== this.risk.limits.symbol) throw new RiskViolationError('symbol not allowed');
    if (req.side === 'buy') throw new RiskViolationError('market buys are not allowed');
    await this.checkSell(req.amount, this.refPrice());
    return this.inner.createMarketOrder(req);
  }

  cancelOrder(clientOrderId: string, exchangeOrderId?: string | null): Promise<void> {
    return this.inner.cancelOrder(clientOrderId, exchangeOrderId);
  }

  fetchOrderByClientId(clientOrderId: string, sinceMs?: number): Promise<AdapterOrder | null> {
    return this.inner.fetchOrderByClientId(clientOrderId, sinceMs);
  }

  fetchOpenOrders(): Promise<AdapterOrder[]> {
    return this.inner.fetchOpenOrders();
  }

  fetchBalance(): Promise<Balance> {
    return this.inner.fetchBalance();
  }
}
