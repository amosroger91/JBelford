/**
 * Paper-trading domain contracts (plan sections 4 and 6).
 * Money/quantity fields are canonical decimal strings at boundaries; internal
 * computation uses `Dec` (bigint fixed point) from ./money.
 */

export type SessionStatus = 'created' | 'running' | 'paused' | 'stopped' | 'failed' | 'completed';
export type FeedHealth = 'connecting' | 'synchronizing' | 'healthy' | 'stale' | 'gap' | 'disconnected';
export type OrderStatus =
  'submitted' | 'accepted' | 'partially_filled' | 'filled' | 'cancel_pending' | 'cancelled' | 'rejected' | 'expired';
export type EvidenceClass = 'not_ready' | 'insufficient_evidence' | 'eligible_for_human_review';

export const SESSION_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  created: ['running', 'stopped', 'failed'],
  running: ['paused', 'stopped', 'failed', 'completed'],
  paused: ['running', 'stopped', 'failed'],
  stopped: [],
  failed: [],
  completed: [],
};

export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  submitted: ['accepted', 'rejected', 'expired', 'cancelled'],
  accepted: ['partially_filled', 'filled', 'cancel_pending', 'cancelled', 'expired', 'rejected'],
  // A resting limit's unfilled remainder can expire (good-till-date); the filled part stands.
  partially_filled: ['partially_filled', 'filled', 'cancel_pending', 'cancelled', 'expired'],
  cancel_pending: ['cancelled', 'filled', 'partially_filled'],
  filled: [],
  cancelled: [],
  rejected: [],
  expired: [],
};

export function assertTransition<S extends string>(table: Record<S, S[]>, from: S, to: S, what: string): void {
  if (!table[from].includes(to)) throw new Error(`illegal ${what} transition ${from} -> ${to}`);
}

export type Side = 'buy' | 'sell';

/** A price level as exact decimal strings. */
export interface Level {
  price: string;
  qty: string;
}

/**
 * Normalized market events. `ordinal` is the processing order within a
 * session/dataset; `receiptTime` is local receipt time (ms) and serves as the
 * deterministic clock for both live and replay.
 */
export type MarketEvent =
  | {
      kind: 'book_snapshot';
      ordinal: number;
      epoch: number;
      seq: number;
      exchangeTime: number;
      receiptTime: number;
      bids: Level[];
      asks: Level[];
    }
  | {
      kind: 'book_update';
      ordinal: number;
      epoch: number;
      seq: number;
      exchangeTime: number;
      receiptTime: number;
      changes: { side: 'bid' | 'ask'; price: string; qty: string }[];
    }
  | {
      kind: 'trade';
      ordinal: number;
      epoch: number;
      seq: number;
      exchangeTime: number;
      receiptTime: number;
      tradeId: string;
      price: string;
      size: string;
      /** Venue-reported side; NOT interpreted as aggressor direction (plan 5.6). */
      venueSide: string;
    }
  | { kind: 'heartbeat'; ordinal: number; epoch: number; seq: number; exchangeTime: number; receiptTime: number; counter: number }
  | {
      kind: 'connection';
      ordinal: number;
      epoch: number;
      receiptTime: number;
      state: 'open' | 'subscribed' | 'closed' | 'error';
      detail?: string;
    }
  | { kind: 'seq_gap'; ordinal: number; epoch: number; receiptTime: number; expected: number; got: number }
  | { kind: 'tick'; ordinal: number; receiptTime: number }
  /** A completed bar published by the venue itself (e.g. a closed 5m kline). */
  | { kind: 'bar'; ordinal: number; receiptTime: number; candle: Candle }
  | { kind: 'warmup_candles'; ordinal: number; receiptTime: number; granularitySec: number; candles: Candle[] }
  | { kind: 'decision_ready'; ordinal: number; receiptTime: number; decision: RecordedDecision }
  | { kind: 'control'; ordinal: number; receiptTime: number; action: ControlAction; requestId: string }
  | { kind: 'drill'; ordinal: number; receiptTime: number; name: string; detail?: string }
  | { kind: 'lifecycle'; ordinal: number; receiptTime: number; state: 'started' | 'restarted' | 'stopping'; detail?: string };

export type MarketEventKind = MarketEvent['kind'];
export type ControlAction = 'pause' | 'resume' | 'stop' | 'flatten';

/** Completed OHLCV bar; decimal strings. `start` is the bucket start (ms UTC). */
export interface Candle {
  start: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

/** Bracket exits requested by a strategy; deterministic code sizes and places every order. */
export interface BracketSpec {
  /** Post-only limit entry this many bps below the best bid. */
  entryOffsetBps: number;
  /** Unfilled entry remainder expires after this long. */
  entryValidMs: number;
  /** Take-profit and stop distances in percent of the average entry price (decimal strings). */
  tpPct: string;
  slPct: string;
  maxHoldMs: number;
}

export interface TradeIntent {
  decisionId: string;
  snapshotId: string;
  /** 'hold' or target BTC weight of total equity, in [0, 1] as a decimal string. */
  action: 'hold' | 'target';
  targetWeight?: string;
  validUntil: number;
  rationale: string;
  /** Optional bracket: limit entry + take-profit/stop/max-hold managed by deterministic code. */
  bracket?: BracketSpec;
}

/** A decision as recorded in the event stream; replay applies these verbatim. */
export interface RecordedDecision {
  decisionId: string;
  snapshotId: string;
  generation: number;
  strategy: string;
  requestedAt: number;
  completedAt: number;
  intent: TradeIntent | null;
  outcome: 'ok' | 'timeout' | 'invalid' | 'error' | 'stale';
  detail?: string;
  model?: {
    provider: string;
    model: string;
    requestHash: string;
    responseHash: string;
    latencyMs: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface DecisionSnapshot {
  snapshotId: string;
  sessionId: string;
  generation: number;
  asOf: number;
  /** Completed bars only, oldest first. */
  bars: Candle[];
  bestBid: string | null;
  bestAsk: string | null;
  feedHealth: FeedHealth;
  balances: BalanceView;
  exposureWeight: string;
  openOrders: number;
  limits: { maxExposure: string; maxOrderPctEquity: string };
  fees: { takerRate: string };
}

export interface BalanceView {
  usdAvailable: string;
  usdReserved: string;
  btcAvailable: string;
  btcReserved: string;
}

export interface ApprovedOrder {
  orderId: string;
  clientOrderId: string;
  sessionId: string;
  decisionId: string;
  side: Side;
  /** Requested base quantity (BTC). */
  qty: string;
  /** Worst acceptable price (execution guard). */
  guardPrice: string;
  /** USD reserved for a buy (notional at guard + fee), BTC reserved for a sell. */
  reserved: string;
  submittedAt: number;
  arrivalAt: number;
  validUntil: number;
  policyVersion: string;
  snapshotId: string;
  purpose: 'strategy' | 'flatten' | 'take_profit' | 'stop' | 'max_hold';
  /** Market IOC (default) or a resting post-only limit order. */
  orderType?: 'market' | 'limit';
  limitPrice?: string;
  postOnly?: boolean;
}

export interface FillRecord {
  fillId: string;
  orderId: string;
  sessionId: string;
  side: Side;
  price: string;
  qty: string;
  /** USD fee. */
  fee: string;
  liquidity: 'taker' | 'maker';
  eventOrdinal: number;
  time: number;
}

export class PaperOnlyError extends Error {
  override name = 'PaperOnlyError';
}
