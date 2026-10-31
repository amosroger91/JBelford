import type { Candle } from '../domain';
import { closes, emaLast, rsiLast } from '../features';

/**
 * Deterministic target-weight rules on COMPLETED five-minute bars. Pure
 * functions shared by the forward runtime and historical screening, so both
 * run identical decision logic. They return a desired BTC weight in [0, 1];
 * deterministic risk code clamps it to the session's exposure limit and sizes
 * the order. Intraday by construction: every rule exits after `maxHoldBars`
 * (default 144 bars = 12 hours).
 */
export interface RuleState {
  /** Time the current long exposure started (ms), or null when flat. */
  positionSince: number | null;
  /** Current BTC weight of equity. */
  weight: number;
}

export interface RuleOutput {
  target: number;
  reason: string;
}

export type Params = Record<string, number | string | boolean>;
export type Rule = (bars: Candle[], st: RuleState, p: Params) => RuleOutput;

const num = (p: Params, k: string, d: number): number => (typeof p[k] === 'number' ? (p[k] as number) : d);

function held(bars: Candle[], st: RuleState): number {
  if (st.positionSince === null || bars.length === 0) return 0;
  return Math.floor((bars.at(-1)!.start + 300_000 - st.positionSince) / 300_000);
}

function maxHoldExit(bars: Candle[], st: RuleState, p: Params): RuleOutput | null {
  const limit = num(p, 'maxHoldBars', 144);
  return held(bars, st) >= limit ? { target: 0, reason: `max hold ${limit} bars reached` } : null;
}

export const RULES: Record<string, { rule: Rule; warmup: (p: Params) => number; description: string; defaults: Params }> = {
  cash: {
    description: 'Control: always flat.',
    defaults: {},
    warmup: () => 0,
    rule: () => ({ target: 0, reason: 'cash control' }),
  },
  buyHold: {
    description: 'Control: always long at the maximum permitted exposure.',
    defaults: {},
    warmup: () => 0,
    rule: () => ({ target: 1, reason: 'buy-and-hold control (clamped to max exposure)' }),
  },
  matchedExposure: {
    description: 'Control: constant exposure equal to the candidate budget (target = maxExposure).',
    defaults: {},
    warmup: () => 0,
    rule: () => ({ target: 1, reason: 'matched-exposure control' }),
  },
  smokeProbe: {
    description: 'Infrastructure check, not a candidate: alternates between a small long and flat every bar.',
    defaults: { weight: 0.05 },
    warmup: () => 0,
    rule: (bars, st, p) => {
      const w = num(p, 'weight', 0.05);
      const odd = Math.floor((bars.at(-1)?.start ?? 0) / 300_000) % 2 === 1;
      return { target: odd ? w : 0, reason: `smoke probe ${odd ? 'long' : 'flat'} phase` };
    },
  },
  emaTrend: {
    description: 'Trend: long when EMA(fast) > EMA(slow) and close > EMA(slow), with an entry buffer; exits on cross-down or max hold.',
    defaults: { fast: 12, slow: 48, bufferBps: 10, maxHoldBars: 144 },
    warmup: (p) => num(p, 'slow', 48) + 2,
    rule: (bars, st, p) => {
      const exit = maxHoldExit(bars, st, p);
      if (exit) return exit;
      const c = closes(bars);
      const f = emaLast(c, num(p, 'fast', 12));
      const s = emaLast(c, num(p, 'slow', 48));
      if (!Number.isFinite(s)) return { target: 0, reason: 'warming up' };
      const last = c.at(-1)!;
      const buf = num(p, 'bufferBps', 10) / 10_000;
      if (st.weight > 0) return f > s && last > s ? { target: 1, reason: 'trend intact' } : { target: 0, reason: 'trend lost' };
      return f > s * (1 + buf) && last > s ? { target: 1, reason: 'trend entry' } : { target: 0, reason: 'no trend' };
    },
  },
  donchianBreakout: {
    description: 'Breakout: long on a close above the prior N-bar high; exit below the prior M-bar low or at max hold.',
    defaults: { entryBars: 48, exitBars: 24, maxHoldBars: 144 },
    warmup: (p) => Math.max(num(p, 'entryBars', 48), num(p, 'exitBars', 24)) + 2,
    rule: (bars, st, p) => {
      const exit = maxHoldExit(bars, st, p);
      if (exit) return exit;
      const n = num(p, 'entryBars', 48);
      const m = num(p, 'exitBars', 24);
      if (bars.length < Math.max(n, m) + 1) return { target: 0, reason: 'warming up' };
      const last = Number(bars.at(-1)!.close);
      const prior = bars.slice(0, -1);
      const hi = Math.max(...prior.slice(-n).map((b) => Number(b.high)));
      const lo = Math.min(...prior.slice(-m).map((b) => Number(b.low)));
      if (st.weight > 0) return last < lo ? { target: 0, reason: 'broke exit channel' } : { target: 1, reason: 'in breakout' };
      return last > hi ? { target: 1, reason: 'channel breakout' } : { target: 0, reason: 'inside channel' };
    },
  },
  rsiReversion: {
    description: 'Mean reversion: long when RSI is oversold and price is above a long EMA; exit on RSI recovery or max hold.',
    defaults: { period: 14, entry: 25, exit: 55, trendEma: 288, maxHoldBars: 72 },
    warmup: (p) => Math.max(num(p, 'period', 14), num(p, 'trendEma', 288)) + 2,
    rule: (bars, st, p) => {
      const exit = maxHoldExit(bars, st, p);
      if (exit) return exit;
      const c = closes(bars);
      const r = rsiLast(c, num(p, 'period', 14));
      const t = num(p, 'trendEma', 288);
      const trend = t > 0 ? emaLast(c, t) : -Infinity;
      if (!Number.isFinite(r) || (t > 0 && !Number.isFinite(trend))) return { target: 0, reason: 'warming up' };
      if (st.weight > 0)
        return r >= num(p, 'exit', 55) ? { target: 0, reason: 'RSI recovered' } : { target: 1, reason: 'holding reversion' };
      return r <= num(p, 'entry', 25) && c.at(-1)! > trend
        ? { target: 1, reason: 'oversold in uptrend' }
        : { target: 0, reason: 'no setup' };
    },
  },
  sessionMomentum: {
    description: 'Time-of-day: during configured UTC hours, long if the prior hour rose; flat outside the window.',
    defaults: { startHour: 13, endHour: 21, lookbackBars: 12, minReturnBps: 10, maxHoldBars: 96 },
    warmup: (p) => num(p, 'lookbackBars', 12) + 2,
    rule: (bars, st, p) => {
      const exit = maxHoldExit(bars, st, p);
      if (exit) return exit;
      const k = num(p, 'lookbackBars', 12);
      if (bars.length <= k) return { target: 0, reason: 'warming up' };
      const hour = new Date(bars.at(-1)!.start + 300_000).getUTCHours();
      const inWindow = hour >= num(p, 'startHour', 13) && hour < num(p, 'endHour', 21);
      if (!inWindow) return { target: 0, reason: 'outside session window' };
      const ret = (Number(bars.at(-1)!.close) / Number(bars.at(-1 - k)!.close) - 1) * 10_000;
      if (st.weight > 0) return ret > 0 ? { target: 1, reason: 'session momentum intact' } : { target: 0, reason: 'momentum faded' };
      return ret >= num(p, 'minReturnBps', 10) ? { target: 1, reason: 'session momentum entry' } : { target: 0, reason: 'no momentum' };
    },
  },
};

export function ruleFor(id: string) {
  const r = RULES[id];
  if (!r) throw new Error(`unknown deterministic strategy ${id}`);
  return r;
}
