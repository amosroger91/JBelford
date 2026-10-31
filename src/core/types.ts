export type Side = 'buy' | 'sell';

export interface Candle {
  /** Bar open time, ms since epoch (UTC). */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TopOfBook {
  bid: number;
  ask: number;
  /** Time the quote was received or generated, ms. */
  ts: number;
}

export interface MarketInfo {
  symbol: string;
  minAmount: number;
  minCost: number;
  amountStep: number;
  priceTick: number;
}

export interface Fees {
  maker: number;
  taker: number;
}

/** Order state as reported by an adapter (paper or live exchange). */
export type AdapterOrderStatus = 'open' | 'closed' | 'canceled' | 'rejected';

export interface AdapterOrder {
  clientOrderId: string;
  exchangeOrderId: string;
  side: Side;
  type: 'limit' | 'market';
  status: AdapterOrderStatus;
  price?: number;
  amount: number;
  filled: number;
  avgPrice?: number;
  /** Fee paid in quote currency (USD). */
  fee: number;
  timestamp: number;
}

export interface Balance {
  usd: number;
  btc: number;
}

export type OrderPurpose = 'entry' | 'take_profit' | 'stop' | 'flatten';

/** Local, persisted view of an order. */
export type LocalOrderStatus =
  | 'pending_submit'
  | 'open'
  | 'filled'
  | 'canceled'
  | 'rejected'
  | 'unknown';

export interface OrderRecord {
  clientOrderId: string;
  exchangeOrderId: string | null;
  tradeId: string;
  symbol: string;
  side: Side;
  type: 'limit' | 'market';
  purpose: OrderPurpose;
  price: number | null;
  amount: number;
  filled: number;
  avgPrice: number | null;
  fee: number;
  status: LocalOrderStatus;
  postOnly: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PositionRecord {
  tradeId: string;
  symbol: string;
  amount: number;
  entryPrice: number;
  entryFee: number;
  openedAt: number;
  stopPrice: number;
  takeProfitPrice: number;
}

export type ExitReason = 'take_profit' | 'stop_loss' | 'max_hold' | 'risk_flatten' | 'kill_switch' | 'shutdown';

export interface TradeRecord {
  tradeId: string;
  symbol: string;
  amount: number;
  entryPrice: number;
  exitPrice: number;
  entryFee: number;
  exitFee: number;
  grossPnl: number;
  netPnl: number;
  openedAt: number;
  closedAt: number;
  exitReason: ExitReason;
  mode: 'paper' | 'live' | 'backtest';
}
