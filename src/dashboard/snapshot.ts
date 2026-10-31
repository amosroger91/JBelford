import type { Store } from '../persistence/store';
import type { RiskEngine, HaltState, DailyStats } from '../risk/engine';
import type { PositionRecord, TradeRecord } from '../core/types';

export interface Heartbeat {
  ts: number;
  phase: string;
  transport: string;
  dataAgeMs: number;
  stateCertain: boolean;
  bid: number | null;
  ask: number | null;
  pid: number;
}

export const HEARTBEAT_KEY = 'engine.heartbeat';

export interface DashboardSnapshot {
  mode: string;
  now: number;
  heartbeat: Heartbeat | undefined;
  halt: HaltState | undefined;
  kill: { at: string; reason: string } | null;
  balance: { usd: number; btc: number; markPrice: number; equity: number; ts: number } | undefined;
  startingEquity: number | undefined;
  position: PositionRecord | undefined;
  unrealizedUsd: number;
  daily: DailyStats;
  cooldownMs: number;
  totals: { trades: number; netPnl: number; grossPnl: number; fees: number; wins: number };
  recentTrades: TradeRecord[];
  recentEvents: { ts: number; level: string; msg: string }[];
  limits: RiskEngine['limits'];
}

export function buildSnapshot(
  store: Store,
  risk: RiskEngine,
  mode: string,
  kill: { at: string; reason: string } | null,
  takerFee: number,
  now = Date.now(),
): DashboardSnapshot {
  const heartbeat = store.getKv<Heartbeat>(HEARTBEAT_KEY);
  const position = store.openPosition();
  const mark = heartbeat?.bid ?? store.latestBalance()?.markPrice ?? 0;
  const unrealized =
    position && mark ? position.amount * mark * (1 - takerFee) - position.amount * position.entryPrice - position.entryFee : 0;
  return {
    mode,
    now,
    heartbeat,
    halt: risk.activeHalt(now),
    kill,
    balance: store.latestBalance(),
    startingEquity: store.firstBalance()?.equity,
    position,
    unrealizedUsd: unrealized,
    daily: risk.dailyStats(now),
    cooldownMs: risk.cooldownRemainingMs(now),
    totals: store.totals(),
    recentTrades: store.recentTrades(10),
    recentEvents: store.recentEvents(8),
    limits: risk.limits,
  };
}
