import { describe, expect, it } from 'vitest';
import { RiskEngine, type EntryContext } from '../src/risk/engine';
import { HARD_LIMITS } from '../src/risk/limits';
import { memStore, T0, trade } from './helpers';

function ctx(over: Partial<EntryContext> = {}): EntryContext {
  return {
    now: T0 + 3_600_000,
    symbol: 'BTC/USD',
    side: 'buy',
    orderValueUsd: 9.8,
    exchangeMinValueUsd: 4.7,
    worstCaseLossUsd: 0.17,
    dataAgeMs: 500,
    stateCertain: true,
    hasOpenPosition: false,
    openOrderCount: 0,
    ...over,
  };
}

function setup() {
  const store = memStore();
  return { store, risk: new RiskEngine(store) };
}

function addTrade(store: ReturnType<typeof memStore>, risk: RiskEngine, netPnl: number, closedAt: number) {
  const t = trade({ netPnl, closedAt });
  store.closePositionWithTrade(t);
  risk.onTradeClosed(t, closedAt);
}

describe('hard limits', () => {
  it('are the values the owner specified and cannot be mutated', () => {
    expect(HARD_LIMITS).toMatchObject({
      symbol: 'BTC/USD',
      maxPositions: 1,
      maxOrderValueUsd: 10,
      maxDailyLossUsd: 1,
      maxConsecutiveLosses: 3,
      maxTradesPerDay: 10,
      cooldownMs: 300_000,
    });
    expect(Object.isFrozen(HARD_LIMITS)).toBe(true);
    expect(() => {
      (HARD_LIMITS as { maxOrderValueUsd: number }).maxOrderValueUsd = 1000;
    }).toThrow();
  });
});

describe('RiskEngine.evaluateEntry', () => {
  it('allows a clean entry', () => {
    const { risk } = setup();
    expect(risk.evaluateEntry(ctx())).toEqual({ ok: true, reasons: [] });
  });

  it.each([
    ['order above $10', { orderValueUsd: 10.01 }, /order value/],
    ['wrong symbol', { symbol: 'ETH/USD' }, /symbol/],
    ['short side', { side: 'sell' as const }, /spot buys/],
    ['second position', { hasOpenPosition: true }, /max 1/],
    ['open orders', { openOrderCount: 1 }, /orders still open/],
    ['stale data', { dataAgeMs: HARD_LIMITS.staleDataMs + 1 }, /stale/],
    ['uncertain state', { stateCertain: false }, /uncertain/],
    ['below exchange minimum', { orderValueUsd: 3, exchangeMinValueUsd: 4.7 }, /minimum/],
    ['worst case exceeds budget', { worstCaseLossUsd: 1.5 }, /worst-case/],
  ])('blocks %s', (_name, over, re) => {
    const { risk } = setup();
    const d = risk.evaluateEntry(ctx(over));
    expect(d.ok).toBe(false);
    expect(d.reasons.join('; ')).toMatch(re);
  });

  it('enforces the five-minute cooldown after a trade', () => {
    const { store, risk } = setup();
    const closed = T0 + 3_000_000;
    addTrade(store, risk, 0.02, closed);
    expect(risk.evaluateEntry(ctx({ now: closed + 299_000 })).reasons.join()).toMatch(/cooldown/);
    expect(risk.evaluateEntry(ctx({ now: closed + 300_000 })).ok).toBe(true);
  });

  it('caps completed trades at 10 per UTC day and resets next day', () => {
    const { store, risk } = setup();
    for (let i = 0; i < 10; i++) addTrade(store, risk, 0.01, T0 + i * 600_000);
    const later = T0 + 10 * 600_000 + 400_000;
    const d = risk.evaluateEntry(ctx({ now: later }));
    expect(d.ok).toBe(false);
    expect(d.reasons.join()).toMatch(/daily trade limit/);
    expect(risk.evaluateEntry(ctx({ now: T0 + 86_400_000 + 1000 })).ok).toBe(true);
  });

  it('shuts down after three consecutive losses and requires a manual reset', () => {
    const { store, risk } = setup();
    addTrade(store, risk, -0.1, T0 + 1_000_000);
    addTrade(store, risk, -0.1, T0 + 2_000_000);
    expect(risk.activeHalt(T0 + 2_000_001)).toBeUndefined();
    addTrade(store, risk, -0.1, T0 + 3_000_000);
    const halt = risk.activeHalt(T0 + 3_000_001);
    expect(halt?.kind).toBe('manual_reset');
    // Still halted on following days.
    expect(risk.activeHalt(T0 + 5 * 86_400_000)?.kind).toBe('manual_reset');
    expect(risk.evaluateEntry(ctx({ now: T0 + 5 * 86_400_000 })).ok).toBe(false);
    risk.resetHalt(T0 + 5 * 86_400_000, 'test');
    expect(risk.evaluateEntry(ctx({ now: T0 + 5 * 86_400_000 + 1 })).ok).toBe(true);
  });

  it('a win breaks the loss streak', () => {
    const { store, risk } = setup();
    addTrade(store, risk, -0.1, T0 + 1_000_000);
    addTrade(store, risk, -0.1, T0 + 2_000_000);
    addTrade(store, risk, 0.05, T0 + 3_000_000);
    addTrade(store, risk, -0.1, T0 + 4_000_000);
    expect(risk.dailyStats(T0 + 4_000_001).consecutiveLosses).toBe(1);
    expect(risk.activeHalt(T0 + 4_000_001)).toBeUndefined();
  });

  it('halts for the day when realized loss reaches $1, resuming next UTC day', () => {
    const { store, risk } = setup();
    addTrade(store, risk, -0.6, T0 + 1_000_000);
    addTrade(store, risk, 0.01, T0 + 2_000_000);
    addTrade(store, risk, -0.45, T0 + 3_000_000);
    const h = risk.activeHalt(T0 + 3_000_001);
    expect(h?.kind).toBe('until_next_utc_day');
    expect(risk.evaluateEntry(ctx({ now: T0 + 4_000_000 })).ok).toBe(false);
    expect(risk.activeHalt(T0 + 86_400_000 + 1)).toBeUndefined();
  });

  it('limits the next trade to the remaining daily loss budget', () => {
    const { store, risk } = setup();
    addTrade(store, risk, -0.9, T0 + 1_000_000);
    const d = risk.evaluateEntry(ctx({ now: T0 + 2_000_000, worstCaseLossUsd: 0.17 }));
    expect(d.ok).toBe(false);
    expect(d.reasons.join()).toMatch(/remaining daily budget/);
  });
});

describe('RiskEngine.evaluateOpenPosition', () => {
  it('forces a flatten when realized + unrealized loss reaches $1', () => {
    const { store, risk } = setup();
    addTrade(store, risk, -0.7, T0 + 1_000_000);
    expect(risk.evaluateOpenPosition(T0 + 2_000_000, -0.29).mustFlatten).toBe(false);
    const r = risk.evaluateOpenPosition(T0 + 2_000_000, -0.31);
    expect(r.mustFlatten).toBe(true);
    expect(risk.activeHalt(T0 + 2_000_001)?.kind).toBe('until_next_utc_day');
  });

  it('flattens when a manual halt (e.g. kill) is active', () => {
    const { risk } = setup();
    risk.halt('kill switch', 'manual_reset', T0);
    expect(risk.evaluateOpenPosition(T0 + 1, 0).mustFlatten).toBe(true);
  });

  it('never downgrades a manual halt to a daily one', () => {
    const { risk } = setup();
    risk.halt('first', 'manual_reset', T0);
    risk.halt('second', 'until_next_utc_day', T0 + 1);
    expect(risk.activeHalt(T0 + 2)).toMatchObject({ kind: 'manual_reset', reason: 'first' });
  });
});
