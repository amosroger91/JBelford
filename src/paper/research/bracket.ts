import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PaperConfig } from '../config';
import { canonicalJson, sha256 } from '../config';
import { deflatedSharpe, probabilityOfBacktestOverfitting } from '../../backtest/overfitting';
import { openDb } from '../../persistence/db';
import { Store } from '../../persistence/store';
import { TradingStore } from '../store';
import { resolveFromRoot } from '../service';

/**
 * BRACKET RESEARCH (historical screening, simplified candle execution).
 *
 * Entry signal at the close of bar t (completed bars only) -> either
 *   - maker: post-only limit buy at close * (1 - offset), valid for `entryValidBars`,
 *     filled only if a LATER bar trades strictly below it (trade-through; models non-fills
 *     and adverse selection), maker fee; or
 *   - taker: buy at the next bar's open + half spread + slippage, taker fee.
 * Once filled: a resting take-profit limit (maker fee, fills only if price trades strictly
 * above it), a stop (taker at the stop or the gap open, minus half spread and slippage) and a
 * max-hold exit (taker). If the stop and target are both touched in one bar, the stop wins.
 * On the fill bar only the stop is checked. One position at a time, sized at the session's
 * exposure budget (the same 20% cap as the live risk engine).
 *
 * PROTOCOL (declared before running; every trial is recorded):
 *   development = first 60%, validation = next 20%, held-out = last 20%.
 *   Parameters are chosen on development only. For each family the single best development
 *   trial that is ALSO positive on validation goes to the held-out period, once.
 *   "Profitable" requires positive net on development, validation AND held-out, >= 15 held-out
 *   trades, and still positive under stressed costs.
 */
export interface Venue {
  name: string;
  maker: number;
  taker: number;
  halfSpreadBps: number;
  slippageBps: number;
}

export interface Series {
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
}

export interface BracketParams {
  family: string;
  signal: Record<string, number>;
  tpPct: number;
  slPct: number;
  maxHoldBars: number;
  entry: 'maker' | 'taker';
  offsetBps: number;
  entryValidBars: number;
}

export interface BracketResult {
  trades: number;
  wins: number;
  netReturn: number;
  avgTradeNetPct: number;
  maxDrawdown: number;
  exits: Record<string, number>;
  entriesSignalled: number;
  entriesFilled: number;
  daily: Map<string, number>;
}

// ---------- indicators (float, causal) ----------

function ema(x: Float64Array, n: number): Float64Array {
  const out = new Float64Array(x.length).fill(NaN);
  if (x.length < n) return out;
  let s = 0;
  for (let i = 0; i < n; i++) s += x[i]!;
  let e = s / n;
  out[n - 1] = e;
  const k = 2 / (n + 1);
  for (let i = n; i < x.length; i++) {
    e = x[i]! * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

function sma(x: Float64Array, n: number): Float64Array {
  const out = new Float64Array(x.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i]!;
    if (i >= n) s -= x[i - n]!;
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

function std(x: Float64Array, n: number): Float64Array {
  const out = new Float64Array(x.length).fill(NaN);
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i]!;
    s2 += x[i]! * x[i]!;
    if (i >= n) {
      s -= x[i - n]!;
      s2 -= x[i - n]! * x[i - n]!;
    }
    if (i >= n - 1) out[i] = Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
  }
  return out;
}

/** Highest high of the `n` bars BEFORE i (excludes bar i). */
function priorMax(x: Float64Array, n: number): Float64Array {
  const out = new Float64Array(x.length).fill(NaN);
  const dq: number[] = [];
  for (let i = 0; i < x.length; i++) {
    while (dq.length && dq[0]! < i - n) dq.shift();
    if (i >= n) out[i] = x[dq[0]!]!;
    while (dq.length && x[dq.at(-1)!]! <= x[i]!) dq.pop();
    dq.push(i);
  }
  return out;
}

// ---------- signal families (boolean entry arrays, computed once per parameter set) ----------

type SignalFn = (s: Series, p: Record<string, number>, cache: Map<string, Float64Array>) => Uint8Array;

function cached(cache: Map<string, Float64Array>, key: string, f: () => Float64Array): Float64Array {
  let v = cache.get(key);
  if (!v) cache.set(key, (v = f()));
  return v;
}

export const FAMILIES: Record<string, { signal: SignalFn; grid: Record<string, number>[] }> = {
  /** Buy a sharp drop inside an uptrend (trendBars = 0 disables the trend filter). */
  dipInUptrend: {
    grid: cross({ lookback: [12, 48, 144], dropPct: [1.5, 3, 5], trendBars: [0, 288, 864] }),
    signal: (s, p, cache) => {
      const out = new Uint8Array(s.c.length);
      const tr = p.trendBars! > 0 ? cached(cache, `ema${p.trendBars}`, () => ema(s.c, p.trendBars!)) : null;
      for (let i = p.lookback!; i < s.c.length; i++) {
        const ret = (s.c[i]! / s.c[i - p.lookback!]! - 1) * 100;
        if (ret <= -p.dropPct! && (!tr || s.c[i]! > tr[i]!)) out[i] = 1;
      }
      return out;
    },
  },
  /** Capitulation: a sharp drop on a volume spike, then a green reversal bar. */
  capitulation: {
    grid: cross({ lookback: [12, 48], dropPct: [2, 4], volMult: [2, 4] }),
    signal: (s, p, cache) => {
      const out = new Uint8Array(s.c.length);
      const va = cached(cache, 'vsma288', () => sma(s.v, 288));
      for (let i = Math.max(p.lookback!, 289); i < s.c.length; i++) {
        const ret = (s.c[i]! / s.c[i - p.lookback!]! - 1) * 100;
        let spike = 0;
        for (let k = i - 3; k <= i; k++) spike = Math.max(spike, s.v[k]!);
        if (ret <= -p.dropPct! && spike >= p.volMult! * va[i - 4]! && s.c[i]! > s.o[i]!) out[i] = 1;
      }
      return out;
    },
  },
  /** Statistical stretch: close more than z standard deviations below its mean. */
  zScoreReversion: {
    grid: cross({ window: [48, 144, 288], z: [2.5, 3.5] }),
    signal: (s, p, cache) => {
      const out = new Uint8Array(s.c.length);
      const m = cached(cache, `sma${p.window}`, () => sma(s.c, p.window!));
      const sd = cached(cache, `std${p.window}`, () => std(s.c, p.window!));
      for (let i = p.window!; i < s.c.length; i++) if (sd[i]! > 0 && (s.c[i]! - m[i]!) / sd[i]! <= -p.z!) out[i] = 1;
      return out;
    },
  },
  /** Breakout: close above the prior N-bar high, in an uptrend. */
  breakout: {
    grid: cross({ channel: [48, 144, 288], trendBars: [0, 864] }),
    signal: (s, p, cache) => {
      const out = new Uint8Array(s.c.length);
      const hi = cached(cache, `pmax${p.channel}`, () => priorMax(s.h, p.channel!));
      const tr = p.trendBars! > 0 ? cached(cache, `ema${p.trendBars}`, () => ema(s.c, p.trendBars!)) : null;
      for (let i = p.channel!; i < s.c.length; i++) if (s.c[i]! > hi[i]! && (!tr || s.c[i]! > tr[i]!)) out[i] = 1;
      return out;
    },
  },
  /** Trend regime: price above a RISING long EMA and breaking the recent high (stay long through uptrends in <=12h trades). */
  trendRegime: {
    grid: cross({ emaBars: [288, 864, 2016], breakBars: [12, 48] }),
    signal: (s, p, cache) => {
      const out = new Uint8Array(s.c.length);
      const e = cached(cache, `ema${p.emaBars}`, () => ema(s.c, p.emaBars!));
      const hi = cached(cache, `pmax${p.breakBars}`, () => priorMax(s.h, p.breakBars!));
      for (let i = p.emaBars! + 12; i < s.c.length; i++) if (s.c[i]! > e[i]! && e[i]! > e[i - 12]! && s.c[i]! > hi[i]!) out[i] = 1;
      return out;
    },
  },
  /** Seasonality: enter at a fixed UTC hour (tests for intraday drift). */
  hourOfDay: {
    grid: cross({ hour: [0, 4, 8, 12, 13, 14, 16, 20] }),
    signal: (s, p) => {
      const out = new Uint8Array(s.c.length);
      for (let i = 0; i < s.c.length; i++) {
        const d = new Date(s.t[i]! + 300_000);
        if (d.getUTCHours() === p.hour && d.getUTCMinutes() === 0) out[i] = 1;
      }
      return out;
    },
  },
};

export const EXITS = cross({ tpPct: [1.5, 2.5, 4], slPct: [1, 2, 3], maxHoldBars: [72, 144] });
export const ENTRIES: { entry: 'maker' | 'taker'; offsetBps: number }[] = [
  { entry: 'maker', offsetBps: 0 },
  { entry: 'maker', offsetBps: 25 },
  { entry: 'taker', offsetBps: 0 },
];

export interface BatchSpec {
  description: string;
  /** Candle source in data/history.db (default coinbase). */
  data?: 'coinbase' | 'binanceus';
  /** Base and stressed cost models (default: the session config's Coinbase fees). */
  venue?: Venue;
  stress?: Venue;
  families: { family: keyof typeof FAMILIES; grid: Record<string, number>[] }[];
  exits: Record<string, number>[];
  entries: { entry: 'maker' | 'taker'; offsetBps: number }[];
}

/**
 * Predeclared batches. A batch's definition is fixed before it is run and never
 * edited afterwards; new ideas become new batches so every trial stays on record.
 */
export const BATCHES: Record<string, BatchSpec> = {
  'batch-01': {
    description: 'Five families, moderate targets, maker/taker entries (first screen).',
    families: (['dipInUptrend', 'capitulation', 'zScoreReversion', 'breakout', 'hourOfDay'] as const).map((f) => ({
      family: f,
      grid: FAMILIES[f]!.grid,
    })),
    exits: EXITS,
    entries: ENTRIES,
  },
  'batch-02': {
    description:
      'Gross-edge diagnostic showed only capitulation had positive mean trades at zero cost. Test rarer, more extreme capitulations and deep dips with larger targets so wins can clear ~1-1.4% round-trip costs; 12h max hold.',
    families: [
      { family: 'capitulation', grid: cross({ lookback: [6, 12, 24, 48], dropPct: [3, 5, 8], volMult: [3, 5] }) },
      { family: 'dipInUptrend', grid: cross({ lookback: [12, 48, 144], dropPct: [5, 8], trendBars: [0, 864] }) },
    ],
    exits: cross({ tpPct: [2.5, 4, 6], slPct: [2, 3, 5], maxHoldBars: [144] }),
    entries: [
      { entry: 'maker', offsetBps: 0 },
      { entry: 'maker', offsetBps: 50 },
      { entry: 'taker', offsetBps: 0 },
    ],
  },
  'batch-03': {
    description:
      'Venue change: Binance.US publishes 0% maker / 0.02% taker on all spot pairs (2026-04-22). Re-test every family (batch-01 grids plus batch-02 extremes) on Binance.US BTC/USD candles at those costs, allowing smaller targets that only near-zero fees can support. 12h max hold.',
    data: 'binanceus',
    venue: { name: 'binanceus-published', maker: 0, taker: 0.0002, halfSpreadBps: 0.5, slippageBps: 3 },
    stress: { name: 'binanceus-stress', maker: 0.0005, taker: 0.001, halfSpreadBps: 1, slippageBps: 10 },
    families: [
      {
        family: 'dipInUptrend',
        grid: [...FAMILIES.dipInUptrend!.grid, ...cross({ lookback: [12, 48, 144], dropPct: [5, 8], trendBars: [0, 864] })],
      },
      {
        family: 'capitulation',
        grid: [...FAMILIES.capitulation!.grid, ...cross({ lookback: [6, 12, 24, 48], dropPct: [3, 5, 8], volMult: [3, 5] })],
      },
      { family: 'zScoreReversion', grid: FAMILIES.zScoreReversion!.grid },
      { family: 'breakout', grid: FAMILIES.breakout!.grid },
      { family: 'hourOfDay', grid: FAMILIES.hourOfDay!.grid },
    ],
    exits: cross({ tpPct: [0.5, 1, 1.5, 2.5, 4], slPct: [0.5, 1, 2, 3], maxHoldBars: [36, 72, 144] }),
    entries: [
      { entry: 'maker', offsetBps: 0 },
      { entry: 'maker', offsetBps: 25 },
      { entry: 'taker', offsetBps: 0 },
    ],
  },
  'batch-04': {
    description:
      'Batch-03 held-out was a strong uptrend that selective entries missed. Hypothesis: with near-zero fees, a trend-regime rule (price above a rising long EMA and breaking a recent high) captures uptrends in repeated <=12h trades and sits out downtrends. Binance.US costs, wide targets.',
    data: 'binanceus',
    venue: { name: 'binanceus-published', maker: 0, taker: 0.0002, halfSpreadBps: 0.5, slippageBps: 3 },
    stress: { name: 'binanceus-stress', maker: 0.0005, taker: 0.001, halfSpreadBps: 1, slippageBps: 10 },
    families: [{ family: 'trendRegime', grid: FAMILIES.trendRegime!.grid }],
    exits: cross({ tpPct: [4, 6, 10], slPct: [1, 2, 3, 5], maxHoldBars: [144] }),
    entries: [
      { entry: 'maker', offsetBps: 0 },
      { entry: 'taker', offsetBps: 0 },
    ],
  },
};

function cross(spec: Record<string, number[]>): Record<string, number>[] {
  let out: Record<string, number>[] = [{}];
  for (const [k, vs] of Object.entries(spec)) out = out.flatMap((o) => vs.map((v) => ({ ...o, [k]: v })));
  return out;
}

// ---------- simulator ----------

export function simulateBracket(
  s: Series,
  sig: Uint8Array,
  from: number,
  to: number,
  p: BracketParams,
  venue: Venue,
  exposure: number,
): BracketResult {
  const hs = venue.halfSpreadBps / 10_000;
  const slip = venue.slippageBps / 10_000;
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  let trades = 0;
  let wins = 0;
  let sumTrade = 0;
  let signalled = 0;
  let filled = 0;
  const exits: Record<string, number> = {};
  const daily = new Map<string, number>();
  const day = (i: number) => new Date(s.t[i]! + 300_000).toISOString().slice(0, 10);
  let i = from;
  while (i < to - 1) {
    daily.set(day(i), equity);
    if (!sig[i]) {
      i++;
      continue;
    }
    signalled++;
    // ---- entry ----
    let entry = NaN;
    let fillBar = -1;
    let entryFee: number;
    if (p.entry === 'maker') {
      const limit = s.c[i]! * (1 - p.offsetBps / 10_000);
      for (let k = i + 1; k <= Math.min(to - 1, i + p.entryValidBars); k++) {
        if (s.l[k]! < limit) {
          entry = Math.min(limit, s.o[k]!); // a gap down through the limit fills at the better open
          fillBar = k;
          break;
        }
      }
      entryFee = venue.maker;
    } else {
      fillBar = i + 1;
      entry = s.o[fillBar]! * (1 + hs + slip);
      entryFee = venue.taker;
    }
    if (fillBar < 0) {
      i = Math.min(to - 1, i + p.entryValidBars + 1);
      continue;
    }
    filled++;
    const tp = entry * (1 + p.tpPct / 100);
    const stop = entry * (1 - p.slPct / 100);
    let exitPx = NaN;
    let exitFee = venue.taker;
    let reason = '';
    let k = fillBar;
    if (s.l[k]! <= stop) {
      exitPx = stop * (1 - hs - slip);
      reason = 'stop';
    }
    while (!reason && k < to - 1) {
      k++;
      if (s.o[k]! <= stop) {
        exitPx = s.o[k]! * (1 - hs - slip);
        reason = 'stop_gap';
      } else if (s.l[k]! <= stop) {
        exitPx = stop * (1 - hs - slip);
        reason = 'stop';
      } else if (s.h[k]! > tp) {
        exitPx = tp;
        exitFee = venue.maker;
        reason = 'take_profit';
      } else if (k - fillBar >= p.maxHoldBars) {
        exitPx = s.c[k]! * (1 - hs - slip);
        reason = 'max_hold';
      }
    }
    if (!reason) {
      exitPx = s.c[to - 1]! * (1 - hs - slip);
      reason = 'end';
      k = to - 1;
    }
    const r = (exitPx * (1 - exitFee)) / (entry * (1 + entryFee)) - 1;
    equity *= 1 + exposure * r;
    trades++;
    if (r > 0) wins++;
    sumTrade += r;
    exits[reason] = (exits[reason] ?? 0) + 1;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (peak - equity) / peak);
    for (let j = fillBar; j <= k; j++) daily.set(day(j), equity);
    i = k + 1;
  }
  daily.set(day(Math.max(from, to - 1)), equity);
  return {
    trades,
    wins,
    netReturn: equity - 1,
    avgTradeNetPct: trades ? (sumTrade / trades) * 100 : 0,
    maxDrawdown: maxDd,
    exits,
    entriesSignalled: signalled,
    entriesFilled: filled,
    daily,
  };
}

export function dailyReturns(daily: Map<string, number>): number[] {
  const eq = [...daily.values()];
  return eq.map((e, i) => (i === 0 ? 0 : e / eq[i - 1]! - 1)).slice(1);
}

function loadSeries(exchange: 'coinbase' | 'binanceus' = 'coinbase'): Series {
  const store = new Store(openDb(resolveFromRoot('data/history.db')));
  const rows = store.loadCandles(exchange, 'BTC-USD', '5m');
  store.db.close();
  const n = rows.length;
  const s: Series = {
    t: new Float64Array(n),
    o: new Float64Array(n),
    h: new Float64Array(n),
    l: new Float64Array(n),
    c: new Float64Array(n),
    v: new Float64Array(n),
  };
  rows.forEach((r, i) => {
    s.t[i] = r.ts;
    s.o[i] = r.open;
    s.h[i] = r.high;
    s.l[i] = r.low;
    s.c[i] = r.close;
    s.v[i] = r.volume;
  });
  return s;
}

export interface BatchOptions {
  batch: string;
  outDir: string;
}

/** Run one predeclared batch under the protocol and register every trial. */
export function runBracketBatch(cfg: PaperConfig, o: BatchOptions) {
  const spec = BATCHES[o.batch];
  if (!spec) throw new Error(`unknown batch ${o.batch}; predeclared batches: ${Object.keys(BATCHES).join(', ')}`);
  const s = loadSeries(spec.data ?? 'coinbase');
  const n = s.c.length;
  if (n < 50_000) throw new Error(`need >= 50k 5m candles (have ${n}); run paper research --days 360 first`);
  const devEnd = Math.floor(n * 0.6);
  const valEnd = Math.floor(n * 0.8);
  const iso = (i: number) => new Date(s.t[Math.min(i, n - 1)]!).toISOString().slice(0, 10);
  const cbDefault: Venue = {
    name: 'coinbase-intro',
    maker: Number(cfg.fees.makerRate),
    taker: Number(cfg.fees.takerRate),
    halfSpreadBps: 0.5,
    slippageBps: 2,
  };
  const coinbase: Venue = spec.venue ?? cbDefault; // base cost model for this batch
  const stress: Venue = spec.stress ?? {
    ...cbDefault,
    name: 'coinbase-stress',
    maker: cbDefault.maker * 1.2,
    taker: cbDefault.taker * 1.33,
    slippageBps: 10,
  };
  const kraken: Venue = { name: 'kraken-tier1', maker: 0.004, taker: 0.008, halfSpreadBps: 0.5, slippageBps: 2 };
  const exposure = Number(cfg.risk.maxExposure);
  const store = new TradingStore(resolveFromRoot(cfg.storage.db));
  const cache = new Map<string, Float64Array>();
  const families = spec.families.map((f) => f.family as string);
  type Row = { id: string; p: BracketParams; sig: Uint8Array; dev: BracketResult };
  const all: Row[] = [];
  const t0 = Date.now();
  for (const { family: fam, grid } of spec.families) {
    const F = FAMILIES[fam]!;
    for (const sp of grid) {
      const sig = F.signal(s, sp, cache);
      for (const ex of spec.exits) {
        for (const en of spec.entries) {
          const p: BracketParams = {
            family: fam,
            signal: sp,
            tpPct: ex.tpPct!,
            slPct: ex.slPct!,
            maxHoldBars: ex.maxHoldBars!,
            entry: en.entry,
            offsetBps: en.offsetBps,
            entryValidBars: 6,
          };
          const dev = simulateBracket(s, sig, 0, devEnd, p, coinbase, exposure);
          const id = `${fam}:${sha256(canonicalJson(p)).slice(0, 10)}`;
          all.push({ id, p, sig, dev });
        }
      }
    }
  }
  const ins = store.db.prepare(
    "INSERT OR REPLACE INTO experiments (id, kind, strategy_version, session_id, config_hash, status, created_at, summary_json) VALUES (?, 'historical-bracket', ?, NULL, ?, 'completed', ?, ?)",
  );
  store.tx(() => {
    for (const r of all) {
      ins.run(
        `${o.batch}:${r.id}`,
        sha256(canonicalJson(r.p)),
        sha256(canonicalJson({ fees: cfg.fees, risk: cfg.risk })),
        Date.now(),
        JSON.stringify({ period: 'development', net: r.dev.netReturn, trades: r.dev.trades }),
      );
    }
  });

  // Selection: per family, best development trial (>= 20 trades) that is ALSO positive on validation.
  const perFamily = families.map((fam) => {
    const cands = all
      .filter((r) => r.p.family === fam && r.dev.trades >= 20 && r.dev.netReturn > 0)
      .sort((a, b) => b.dev.netReturn - a.dev.netReturn);
    const validated = cands.slice(0, 15).map((r) => ({ ...r, val: simulateBracket(s, r.sig, devEnd, valEnd, r.p, coinbase, exposure) }));
    const pick = validated.find((r) => r.val.netReturn > 0 && r.val.trades >= 8) ?? null;
    const held = pick ? simulateBracket(s, pick.sig, valEnd, n, pick.p, coinbase, exposure) : null;
    const heldStress = pick ? simulateBracket(s, pick.sig, valEnd, n, pick.p, stress, exposure) : null;
    const heldKraken = pick ? simulateBracket(s, pick.sig, valEnd, n, pick.p, kraken, exposure) : null;
    return {
      family: fam,
      trials: all.filter((r) => r.p.family === fam).length,
      devPositive: all.filter((r) => r.p.family === fam && r.dev.trades >= 20 && r.dev.netReturn > 0).length,
      validatedTop: validated.map((r) => ({
        id: r.id,
        devNet: r.dev.netReturn,
        devTrades: r.dev.trades,
        valNet: r.val.netReturn,
        valTrades: r.val.trades,
      })),
      pick: pick ? { id: pick.id, params: pick.p, dev: strip(pick.dev), val: strip(pick.val) } : null,
      heldOut: held ? strip(held) : null,
      heldOutStress: heldStress ? strip(heldStress) : null,
      heldOutKraken: heldKraken ? strip(heldKraken) : null,
      passes: !!(
        held &&
        heldStress &&
        pick &&
        pick.dev.netReturn > 0 &&
        pick.val.netReturn > 0 &&
        held.netReturn > 0 &&
        held.trades >= 15 &&
        heldStress.netReturn > 0
      ),
    };
  });

  // Multiple-testing diagnostics over every active development trial.
  const active = all.filter((r) => r.dev.trades >= 20);
  let dsr: ReturnType<typeof deflatedSharpe> | null = null;
  let pbo: ReturnType<typeof probabilityOfBacktestOverfitting> | null = null;
  if (active.length >= 2) {
    const cols = active.map((r) => dailyReturns(r.dev.daily));
    const len = Math.min(...cols.map((c) => c.length));
    const matrix = Array.from({ length: len }, (_, i) => cols.map((c) => c[c.length - len + i]!));
    try {
      dsr = deflatedSharpe(matrix);
      pbo = probabilityOfBacktestOverfitting(matrix, 8);
    } catch {
      /* reported as not computed */
    }
  }
  const btcHeld = s.c[n - 1]! / s.c[valEnd]! - 1;
  const out = {
    label: 'HISTORICAL SCREENING (bracket) — simplified candle execution; not forward evidence',
    batch: o.batch,
    description: spec.description,
    data: { candles: n, from: iso(0), to: iso(n - 1) },
    splits: {
      development: `${iso(0)}..${iso(devEnd)}`,
      validation: `${iso(devEnd)}..${iso(valEnd)}`,
      heldOut: `${iso(valEnd)}..${iso(n - 1)}`,
    },
    dataSource: spec.data ?? 'coinbase',
    venues: { base: coinbase, stress, kraken },
    exposure,
    trials: all.length,
    activeTrials: active.length,
    devPositiveTrials: all.filter((r) => r.dev.trades >= 20 && r.dev.netReturn > 0).length,
    perFamily,
    controls: { heldOutBtcBuyHold: btcHeld, heldOutMatchedExposure: exposure * btcHeld },
    multipleTesting: {
      dsr: dsr
        ? {
            bestSharpePerDay: dsr.sharpe,
            luckBenchmark: dsr.benchmarkSharpe,
            deflatedSharpe: dsr.dsr,
            bestTrial: active[dsr.bestTrial]!.id,
          }
        : 'not computed',
      pbo: pbo ? { pbo: pbo.pbo, isWinnerLostOos: pbo.probOosLoss } : 'not computed',
    },
    anyPass: perFamily.some((f) => f.passes),
    seconds: Math.round((Date.now() - t0) / 1000),
  };
  const dir = join(o.outDir, o.batch);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bracket.json'), JSON.stringify(out, null, 2));
  writeFileSync(
    join(dir, 'trials.csv'),
    'id,family,signal,tp,sl,hold,entry,offset,devNet,devTrades,devWins,devAvgTradePct\n' +
      all
        .map((r) =>
          [
            r.id,
            r.p.family,
            JSON.stringify(r.p.signal).replace(/,/g, ';'),
            r.p.tpPct,
            r.p.slPct,
            r.p.maxHoldBars,
            r.p.entry,
            r.p.offsetBps,
            r.dev.netReturn.toFixed(6),
            r.dev.trades,
            r.dev.wins,
            r.dev.avgTradeNetPct.toFixed(4),
          ].join(','),
        )
        .join('\n') +
      '\n',
  );
  store.close();
  return { out, dir };
}

function strip(r: BracketResult) {
  return {
    netReturn: r.netReturn,
    trades: r.trades,
    winRate: r.trades ? r.wins / r.trades : null,
    avgTradeNetPct: r.avgTradeNetPct,
    maxDrawdown: r.maxDrawdown,
    exits: r.exits,
    fillRate: r.entriesSignalled ? r.entriesFilled / r.entriesSignalled : null,
  };
}
