import type { Store } from '../persistence/store';
import type { Side, TradeRecord } from '../core/types';
import { utcDayStart } from '../core/util';
import { log } from '../core/log';
import { HARD_LIMITS, type RiskLimits } from './limits';

export type HaltKind = 'manual_reset' | 'until_next_utc_day';

export interface HaltState {
  reason: string;
  kind: HaltKind;
  at: number;
}

export interface EntryContext {
  now: number;
  symbol: string;
  side: Side;
  orderValueUsd: number;
  /** Exchange minimum notional for this order (after amount rounding). */
  exchangeMinValueUsd: number;
  /** Loss if the stop is hit, including both fees and slippage. Positive number. */
  worstCaseLossUsd: number;
  dataAgeMs: number;
  stateCertain: boolean;
  hasOpenPosition: boolean;
  openOrderCount: number;
}

export interface Decision {
  ok: boolean;
  reasons: string[];
}

export interface DailyStats {
  dayStart: number;
  tradesToday: number;
  realizedTodayUsd: number;
  consecutiveLosses: number;
  lastCloseAt: number | null;
}

const HALT_KEY = 'risk.halt';
const STREAK_RESET_KEY = 'risk.lossStreakResetAt';

/**
 * Independent risk engine. All limits come from HARD_LIMITS; nothing here can
 * be changed by strategy params or Claude proposals. State is derived from the
 * persistent store so it survives restarts.
 */
export class RiskEngine {
  constructor(
    private readonly store: Store,
    readonly limits: RiskLimits = HARD_LIMITS,
  ) {}

  // ---------- halts ----------

  activeHalt(now: number): HaltState | undefined {
    const h = this.store.getKv<HaltState>(HALT_KEY);
    if (!h) return undefined;
    if (h.kind === 'until_next_utc_day' && utcDayStart(now) > utcDayStart(h.at)) {
      this.store.deleteKv(HALT_KEY);
      this.store.insertEvent(now, 'info', `daily halt expired: ${h.reason}`);
      return undefined;
    }
    return h;
  }

  halt(reason: string, kind: HaltKind, now: number): void {
    const existing = this.activeHalt(now);
    // Keep the first halt reason; only upgrade a daily halt to a manual-reset one.
    if (existing && (existing.kind === 'manual_reset' || kind === 'until_next_utc_day')) return;
    const h: HaltState = { reason, kind, at: now };
    this.store.setKv(HALT_KEY, h, now);
    this.store.insertEvent(now, 'warn', `HALT (${kind}): ${reason}`);
    log.warn('risk halt', { reason, kind });
  }

  /** Human-only: clears a halt and the consecutive-loss streak. Not reachable from proposals. */
  resetHalt(now: number, by: string): void {
    this.store.deleteKv(HALT_KEY);
    this.store.setKv(STREAK_RESET_KEY, now, now);
    this.store.insertEvent(now, 'warn', `halt manually reset by ${by}`);
  }

  // ---------- stats ----------

  dailyStats(now: number): DailyStats {
    const dayStart = utcDayStart(now);
    const today = this.store.tradesSince(dayStart);
    const realized = today.reduce((s, t) => s + t.netPnl, 0);
    const streakFrom = this.store.getKv<number>(STREAK_RESET_KEY) ?? 0;
    const recent = this.store.recentTrades(this.limits.maxConsecutiveLosses + 5);
    let streak = 0;
    for (const t of recent) {
      if (t.closedAt <= streakFrom) break;
      if (t.netPnl < 0) streak++;
      else break;
    }
    return {
      dayStart,
      tradesToday: today.length,
      realizedTodayUsd: realized,
      consecutiveLosses: streak,
      lastCloseAt: recent[0]?.closedAt ?? null,
    };
  }

  cooldownRemainingMs(now: number): number {
    const last = this.store.lastTrade();
    if (!last) return 0;
    return Math.max(0, last.closedAt + this.limits.cooldownMs - now);
  }

  // ---------- decisions ----------

  evaluateEntry(ctx: EntryContext): Decision {
    const L = this.limits;
    const reasons: string[] = [];
    const halt = this.activeHalt(ctx.now);
    if (halt) reasons.push(`halted: ${halt.reason}`);
    if (ctx.symbol !== L.symbol) reasons.push(`symbol ${ctx.symbol} not allowed`);
    if (ctx.side !== 'buy') reasons.push('entries must be spot buys (no shorting)');
    if (ctx.hasOpenPosition) reasons.push('position already open (max 1)');
    if (ctx.openOrderCount > 0) reasons.push('orders still open');
    if (!(ctx.orderValueUsd > 0)) reasons.push('order value must be positive');
    if (ctx.orderValueUsd > L.maxOrderValueUsd + 1e-9) reasons.push(`order value ${ctx.orderValueUsd.toFixed(2)} > $${L.maxOrderValueUsd}`);
    if (ctx.orderValueUsd < ctx.exchangeMinValueUsd) reasons.push('order below exchange minimum');
    if (!ctx.stateCertain) reasons.push('exchange/account state uncertain');
    if (!(ctx.dataAgeMs <= L.staleDataMs)) reasons.push(`market data stale (${Math.round(ctx.dataAgeMs)}ms)`);

    const s = this.dailyStats(ctx.now);
    if (s.tradesToday >= L.maxTradesPerDay) reasons.push(`daily trade limit ${L.maxTradesPerDay} reached`);
    if (s.consecutiveLosses >= L.maxConsecutiveLosses) reasons.push(`${s.consecutiveLosses} consecutive losses`);
    const cooldown = this.cooldownRemainingMs(ctx.now);
    if (cooldown > 0) reasons.push(`cooldown ${Math.ceil(cooldown / 1000)}s`);
    const remaining = L.maxDailyLossUsd + s.realizedTodayUsd; // realized is negative when losing
    if (remaining <= 0) reasons.push('daily loss limit reached');
    else if (ctx.worstCaseLossUsd > remaining) {
      reasons.push(`worst-case loss $${ctx.worstCaseLossUsd.toFixed(3)} exceeds remaining daily budget $${remaining.toFixed(3)}`);
    }
    return { ok: reasons.length === 0, reasons };
  }

  /**
   * Called on every tick while a position is open. Realized-plus-unrealized
   * loss at or beyond the daily limit forces a flatten and a daily halt.
   */
  evaluateOpenPosition(now: number, unrealizedUsd: number): { mustFlatten: boolean; reason?: string } {
    const s = this.dailyStats(now);
    if (s.realizedTodayUsd + unrealizedUsd <= -this.limits.maxDailyLossUsd) {
      this.halt('daily loss limit (realized + unrealized) reached', 'until_next_utc_day', now);
      return { mustFlatten: true, reason: 'daily_loss_limit' };
    }
    const halt = this.activeHalt(now);
    if (halt?.kind === 'manual_reset') return { mustFlatten: true, reason: `halted: ${halt.reason}` };
    return { mustFlatten: false };
  }

  /** Apply post-trade limits. Must be called after the trade is persisted. */
  onTradeClosed(_trade: TradeRecord, now: number): void {
    const s = this.dailyStats(now);
    if (s.consecutiveLosses >= this.limits.maxConsecutiveLosses) {
      this.halt(`${s.consecutiveLosses} consecutive losses: shutdown`, 'manual_reset', now);
    }
    if (s.realizedTodayUsd <= -this.limits.maxDailyLossUsd) {
      this.halt('daily realized loss limit reached', 'until_next_utc_day', now);
    }
    if (s.tradesToday >= this.limits.maxTradesPerDay) {
      this.halt('daily trade count reached', 'until_next_utc_day', now);
    }
  }
}
