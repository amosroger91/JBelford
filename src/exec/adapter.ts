import type { AdapterOrder, Balance, MarketInfo, Side } from '../core/types';

/** The request definitely did not create an order (validation, funds, post-only cross...). */
export class OrderRejectedError extends Error {
  override name = 'OrderRejectedError';
}

/**
 * The outcome is unknown: the order may or may not exist (timeout, dropped
 * connection, 5xx). The engine must reconcile by client order id before doing
 * anything else.
 */
export class AmbiguousOrderError extends Error {
  override name = 'AmbiguousOrderError';
}

/** Blocked by the order guard before reaching the exchange. */
export class RiskViolationError extends Error {
  override name = 'RiskViolationError';
}

export interface LimitOrderRequest {
  clientOrderId: string;
  side: Side;
  amount: number;
  price: number;
  postOnly: boolean;
}

export interface MarketOrderRequest {
  clientOrderId: string;
  side: Side;
  amount: number;
}

/**
 * Everything the execution engine may do to an exchange. Implemented by the
 * paper simulator (default) and the live CCXT adapter (gated).
 */
export interface ExchangeAdapter {
  readonly mode: 'paper' | 'live';
  marketInfo(): MarketInfo;
  createLimitOrder(req: LimitOrderRequest): Promise<AdapterOrder>;
  createMarketOrder(req: MarketOrderRequest): Promise<AdapterOrder>;
  cancelOrder(clientOrderId: string, exchangeOrderId?: string | null): Promise<void>;
  /** Returns null only when the exchange positively has no record of the order. */
  fetchOrderByClientId(clientOrderId: string, sinceMs?: number): Promise<AdapterOrder | null>;
  fetchOpenOrders(): Promise<AdapterOrder[]>;
  fetchBalance(): Promise<Balance>;
}
