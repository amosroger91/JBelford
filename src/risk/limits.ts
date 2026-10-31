/**
 * HARD RISK LIMITS.
 *
 * These are compiled into the program. They are deliberately NOT loaded from
 * config files, environment variables, CLI flags, or strategy proposals, so
 * neither Claude (as strategy supervisor) nor a config edit can loosen them.
 *
 * The SHA-256 of this file is recorded in any live-trading authorization; if
 * the file changes, the authorization becomes invalid and live mode refuses
 * to start (see src/safety/liveGate.ts).
 */
export interface RiskLimits {
  readonly symbol: 'BTC/USD';
  readonly maxPositions: number;
  readonly maxOrderValueUsd: number;
  readonly maxDailyLossUsd: number;
  readonly maxConsecutiveLosses: number;
  readonly maxTradesPerDay: number;
  readonly cooldownMs: number;
  /** Market data older than this blocks new entries. */
  readonly staleDataMs: number;
  /** Market data stale for longer than this triggers a persistent halt. */
  readonly staleHaltMs: number;
  /** Tolerance applied to the order value cap on exit orders, where price may have moved. */
  readonly exitValueTolerance: number;
}

export const HARD_LIMITS: RiskLimits = Object.freeze({
  symbol: 'BTC/USD',
  maxPositions: 1,
  maxOrderValueUsd: 10,
  maxDailyLossUsd: 1,
  maxConsecutiveLosses: 3,
  maxTradesPerDay: 10,
  cooldownMs: 5 * 60_000,
  staleDataMs: 15_000,
  staleHaltMs: 5 * 60_000,
  exitValueTolerance: 1.25,
} as const);
