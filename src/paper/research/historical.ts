import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PaperConfig } from '../config';
import { canonicalJson, sha256 } from '../config';
import type { Candle } from '../domain';
import { fetchCandles } from '../market/coinbase';
import { RULES, type Params } from '../strategies/rules';
import { openDb } from '../../persistence/db';
import { Store } from '../../persistence/store';
import { TradingStore } from '../store';
import { deflatedSharpe, probabilityOfBacktestOverfitting } from '../../backtest/overfitting';
import { resolveFromRoot } from '../service';
import { escapeHtml } from '../export';

/**
 * HISTORICAL SCREENING (plan workflow 1): chronological candle research with
 * explicitly SIMPLIFIED execution. Useful for rejecting weak ideas; NOT
 * evidence about exact fills. Decisions use the same rule code and the same
 * bar window as the forward runtime; sizing mirrors the risk engine.
 *
 * Execution model (labelled in every report): a decision at the close of bar t
 * executes at the OPEN of bar t+1, paying half the assumed spread, extra
 * slippage, and the taker fee. No depth, latency or queue effects.
 */
export interface CostModel {
  takerRate: number;
  halfSpreadBps: number;
  slippageBps: number;
}

export interface TrialResult {
  id: string;
  strategy: string;
  params: Params;
  period: string;
  netReturn: number;
  finalEquity: number;
  fees: number;
  trades: number;
  roundTrips: number;
  winRate: number | null;
  maxDrawdown: number;
  timeInMarket: number;
  daily: number[];
}

const BAR = 300_000;

function windowFor(strategy: string, params: Params): number {
  const r = RULES[strategy]!;
  return Math.max(r.warmup({ ...r.defaults, ...params }) + 10, 300); // identical to the forward runtime
}

/** Simulate one strategy over bars[from, to) with simplified execution. */
export function simulate(
  bars: Candle[],
  from: number,
  to: number,
  strategy: string,
  params: Params,
  cfg: PaperConfig,
  cost: CostModel,
): Omit<TrialResult, 'id' | 'period'> {
  const rule = RULES[strategy]!;
  const p = { ...rule.defaults, ...params };
  const win = windowFor(strategy, p);
  const maxExp = Number(cfg.risk.maxExposure);
  const orderCap = Number(cfg.risk.maxOrderPctEquity);
  const minReb = Number(cfg.risk.minRebalancePctEquity);
  const dayLossPause = Number(cfg.risk.dailyLossPausePct);
  const ddPause = Number(cfg.risk.drawdownPausePct);
  const perHour = cfg.risk.maxOrdersPerHour;
  let usd = Number(cfg.initialBalances.usd);
  let btc = 0;
  let fees = 0;
  let trades = 0;
  let positionSince: number | null = null;
  let peak = usd;
  let maxDd = 0;
  let inMkt = 0;
  let steps = 0;
  let dayKey = '';
  let dayStart = usd;
  let hwm = usd;
  const orderTimes: number[] = [];
  const dailyEq = new Map<string, number>();
  const trips: number[] = [];
  let tripPnl = 0;
  const start = Math.max(from, rule.warmup(p) + 1);
  for (let t = start; t < to - 1; t++) {
    const bar = bars[t]!;
    const next = bars[t + 1]!;
    const mark = Number(bar.close);
    const equity = usd + btc * mark;
    const day = new Date(bar.start + BAR).toISOString().slice(0, 10);
    if (day !== dayKey) {
      dayKey = day;
      dayStart = equity;
    }
    hwm = Math.max(hwm, equity);
    const weight = equity > 0 ? (btc * mark) / equity : 0;
    const out = rule.rule(bars.slice(Math.max(0, t + 1 - win), t + 1), { positionSince, weight }, p);
    const target = Math.min(maxExp, Math.max(0, out.target));
    let delta = (target - weight) * equity;
    const recent = orderTimes.filter((x) => x > bar.start - 3_600_000).length;
    if (Math.abs(delta) >= minReb * equity && recent < perHour && next.start - bar.start === BAR) {
      const buying = delta > 0;
      const paused = (dayStart - equity) / dayStart >= dayLossPause || (hwm - equity) / hwm >= ddPause;
      if (!(buying && paused)) {
        delta = Math.sign(delta) * Math.min(Math.abs(delta), orderCap * equity);
        const open = Number(next.open);
        const px = open * (1 + ((buying ? 1 : -1) * (cost.halfSpreadBps + cost.slippageBps)) / 10_000);
        let qty = Math.abs(delta) / px;
        if (!buying) qty = Math.min(qty, btc);
        const notional = qty * px;
        const fee = notional * cost.takerRate;
        if (buying && notional + fee > usd) qty = usd / (px * (1 + cost.takerRate));
        if (qty * px >= 1) {
          const n = qty * px;
          const f = n * cost.takerRate;
          if (buying) {
            usd -= n + f;
            btc += qty;
            tripPnl -= n + f;
            positionSince ??= next.start;
          } else {
            usd += n - f;
            btc -= qty;
            tripPnl += n - f;
            if (btc * open < 1) {
              // round trip complete (dust treated as flat)
              tripPnl += btc * open * (1 - cost.takerRate);
              usd += btc * open * (1 - cost.takerRate);
              fees += btc * open * cost.takerRate;
              btc = 0;
              trips.push(tripPnl);
              tripPnl = 0;
              positionSince = null;
            }
          }
          fees += f;
          trades++;
          orderTimes.push(next.start);
        }
      }
    }
    const eq = usd + btc * Number(next.close);
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, (peak - eq) / peak);
    if (btc > 0) inMkt++;
    steps++;
    dailyEq.set(new Date(next.start + BAR).toISOString().slice(0, 10), eq);
  }
  // Liquidate at the end at the last close, paying costs (same convention for every trial).
  const last = bars[to - 1] ?? bars[bars.length - 1]!;
  if (btc > 0) {
    const px = Number(last.close) * (1 - (cost.halfSpreadBps + cost.slippageBps) / 10_000);
    const n = btc * px;
    usd += n - n * cost.takerRate;
    fees += n * cost.takerRate;
    trips.push(tripPnl + n - n * cost.takerRate);
  }
  const initial = Number(cfg.initialBalances.usd);
  const eqs = [...dailyEq.values()];
  const daily = eqs.map((e, i) => (i === 0 ? e / initial - 1 : e / eqs[i - 1]! - 1));
  return {
    strategy,
    params: p,
    netReturn: usd / initial - 1,
    finalEquity: usd,
    fees,
    trades,
    roundTrips: trips.length,
    winRate: trips.length ? trips.filter((x) => x > 0).length / trips.length : null,
    maxDrawdown: maxDd,
    timeInMarket: steps ? inMkt / steps : 0,
    daily,
  };
}

/** Unconstrained BTC buy-and-hold over the same window and cost convention (context only). */
function buyHold(bars: Candle[], from: number, to: number, weight: number, cost: CostModel): number {
  const entry = Number(bars[from]!.open) * (1 + (cost.halfSpreadBps + cost.slippageBps) / 10_000);
  const exit = Number(bars[to - 1]!.close) * (1 - (cost.halfSpreadBps + cost.slippageBps) / 10_000);
  return weight * ((exit * (1 - cost.takerRate)) / (entry * (1 + cost.takerRate)) - 1);
}

function combos(spec: Record<string, (number | string)[]>): Params[] {
  let out: Params[] = [{}];
  for (const [k, vs] of Object.entries(spec)) out = out.flatMap((o) => vs.map((v) => ({ ...o, [k]: v })));
  return out;
}

/** Predeclared search space (registered before results are seen; every trial is retained). */
export const GRIDS: Record<string, Params[]> = {
  emaTrend: combos({ fast: [6, 12, 24], slow: [48, 96, 192], bufferBps: [0, 20], maxHoldBars: [72, 144] }).filter(
    (p) => (p.fast as number) < (p.slow as number),
  ),
  donchianBreakout: combos({ entryBars: [24, 48, 96], exitBars: [12, 24, 48], maxHoldBars: [72, 144] }),
  rsiReversion: combos({ period: [7, 14], entry: [20, 25, 30], exit: [50, 60], trendEma: [0, 288], maxHoldBars: [36, 72] }),
  sessionMomentum: combos({ startHour: [0, 8, 13], lookbackBars: [6, 12, 24], minReturnBps: [0, 20, 50], maxHoldBars: [48, 96] }).map(
    (p) => ({
      ...p,
      endHour: Math.min(24, (p.startHour as number) + 8),
    }),
  ),
};

/** Binance.US public 5m klines (1000 per request), completed buckets only, stored as exchange 'binanceus'. */
export async function loadBinanceUsCandles(days: number, symbol = 'BTCUSD'): Promise<number> {
  const { guardedGet } = await import('../market/netguard');
  const store = new Store(openDb(resolveFromRoot('data/history.db')));
  const now = Date.now();
  const range = store.candleRange('binanceus', 'BTC-USD', '5m');
  let start =
    range.max !== null && range.min !== null && range.min <= now - days * 86_400_000 + 300_000
      ? range.max + 300_000
      : now - days * 86_400_000;
  let n = 0;
  while (start < now - 300_000) {
    const rows = (await guardedGet(`https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=5m&startTime=${start}&limit=1000`)) as (
      string | number
    )[][];
    if (!rows.length) break;
    const done = rows.filter((r) => (r[6] as number) < now);
    store.upsertCandles(
      'binanceus',
      'BTC-USD',
      '5m',
      done.map((r) => ({
        ts: r[0] as number,
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5]),
      })),
    );
    n += done.length;
    start = (rows.at(-1)![0] as number) + 300_000;
    process.stdout.write(`\r  binance.us: ${n} candles up to ${new Date(start).toISOString().slice(0, 10)}   `);
  }
  process.stdout.write('\n');
  store.db.close();
  return n;
}

export async function loadCandles(days: number, refresh: boolean): Promise<Candle[]> {
  const store = new Store(openDb(resolveFromRoot('data/history.db')));
  const now = Math.floor(Date.now() / 1000);
  const startSec = now - days * 86_400;
  const range = store.candleRange('coinbase', 'BTC-USD', '5m');
  let from = startSec;
  if (!refresh && range.min !== null && range.max !== null && range.min <= (startSec + 300) * 1000)
    from = Math.floor(range.max / 1000) + 300;
  const chunk = 350 * 300;
  let fetched = 0;
  for (let s = from; s < now - 300; s += chunk * 20) {
    const e = Math.min(now, s + chunk * 20);
    const c = await fetchCandles(s, e, 300);
    store.upsertCandles(
      'coinbase',
      'BTC-USD',
      '5m',
      c.map((x) => ({
        ts: x.start,
        open: Number(x.open),
        high: Number(x.high),
        low: Number(x.low),
        close: Number(x.close),
        volume: Number(x.volume),
      })),
    );
    fetched += c.length;
    process.stdout.write(`\r  downloaded ${fetched} candles up to ${new Date(e * 1000).toISOString().slice(0, 10)}   `);
  }
  if (fetched) process.stdout.write('\n');
  const rows = store.loadCandles('coinbase', 'BTC-USD', '5m', startSec * 1000);
  store.db.close();
  // Back to exact decimal strings via the cached numbers (candle research uses floats by design).
  return rows.map((r) => ({
    start: r.ts,
    open: String(r.open),
    high: String(r.high),
    low: String(r.low),
    close: String(r.close),
    volume: String(r.volume),
  }));
}

export async function runResearch(cfg: PaperConfig, o: { days: number; refresh: boolean; outDir: string }): Promise<void> {
  console.log(`HISTORICAL SCREENING (simplified execution: next-bar open + spread + slippage + taker fee). Not evidence of exact fills.`);
  const bars = await loadCandles(o.days, o.refresh);
  if (bars.length < 10_000) throw new Error(`only ${bars.length} candles available`);
  const missing = Math.round((bars.at(-1)!.start - bars[0]!.start) / BAR) + 1 - bars.length;
  const n = bars.length;
  const devEnd = Math.floor(n * 0.6);
  const valEnd = Math.floor(n * 0.8);
  const periods = { development: [0, devEnd], validation: [devEnd, valEnd], heldOut: [valEnd, n] } as const;
  const base: CostModel = { takerRate: Number(cfg.fees.takerRate), halfSpreadBps: 0.5, slippageBps: 2 };
  const stress: CostModel = { takerRate: Number(cfg.fees.takerRate) * (4 / 3), halfSpreadBps: 1, slippageBps: 10 };
  const iso = (i: number) => new Date(bars[Math.min(i, n - 1)]!.start).toISOString().slice(0, 10);
  console.log(`${n} completed 5m candles ${iso(0)} .. ${iso(n - 1)} (${missing} missing buckets left missing, never invented)`);
  console.log(
    `splits: development ${iso(0)}..${iso(devEnd)} | validation ${iso(devEnd)}..${iso(valEnd)} | held-out ${iso(valEnd)}..${iso(n - 1)}`,
  );

  const store = new TradingStore(resolveFromRoot(cfg.storage.db));
  const runId = `research-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const trials: TrialResult[] = [];
  const t0 = Date.now();
  for (const [strategy, grid] of Object.entries(GRIDS)) {
    for (const params of grid) {
      const r = simulate(bars, 0, valEnd, strategy, params, cfg, base); // development + validation only
      const id = `${strategy}:${sha256(canonicalJson(params)).slice(0, 10)}`;
      trials.push({ ...r, id, period: 'dev+validation' });
      store.run(
        "INSERT OR REPLACE INTO experiments (id, kind, strategy_version, session_id, config_hash, status, created_at, summary_json) VALUES (?, 'historical', ?, NULL, ?, 'completed', ?, ?)",
        `${runId}:${id}`,
        sha256(canonicalJson({ strategy, params, cost: base })),
        sha256(canonicalJson(cfg)),
        Date.now(),
        JSON.stringify({ netReturn: r.netReturn, trades: r.trades, fees: r.fees, maxDrawdown: r.maxDrawdown }),
      );
    }
    process.stdout.write(`\r  screened ${trials.length} trials (${((Date.now() - t0) / 1000).toFixed(0)}s)   `);
  }
  process.stdout.write('\n');

  // Selection on development only, confirmation on validation, ONE look at held-out.
  const families = Object.keys(GRIDS);
  const selected = families.map((f) => {
    const cands = GRIDS[f]!.map((params) => ({
      params,
      dev: simulate(bars, periods.development[0], periods.development[1], f, params, cfg, base),
    }));
    const eligible = cands.filter((c) => c.dev.roundTrips >= 10);
    const best = (eligible.length ? eligible : cands).sort((a, b) => b.dev.netReturn - a.dev.netReturn)[0]!;
    const val = simulate(bars, periods.validation[0], periods.validation[1], f, best.params, cfg, base);
    return { family: f, params: best.params, dev: best.dev, val };
  });
  const champion = [...selected].sort((a, b) => b.val.netReturn - a.val.netReturn)[0]!;
  const held = simulate(bars, periods.heldOut[0], periods.heldOut[1], champion.family, champion.params, cfg, base);
  const heldStress = simulate(bars, periods.heldOut[0], periods.heldOut[1], champion.family, champion.params, cfg, stress);
  const full = simulate(bars, 0, n, champion.family, champion.params, cfg, base);

  // Multiple-testing diagnostics over ALL trials (dev+validation daily returns).
  const len = Math.min(...trials.map((t) => t.daily.length));
  const active = trials.filter((t) => t.trades >= 20);
  const matrix = Array.from({ length: len }, (_, i) => active.map((t) => t.daily[i]!));
  let dsr: ReturnType<typeof deflatedSharpe> | null = null;
  let pbo: ReturnType<typeof probabilityOfBacktestOverfitting> | null = null;
  try {
    if (active.length >= 2) {
      dsr = deflatedSharpe(matrix);
      pbo = probabilityOfBacktestOverfitting(matrix, 8);
    }
  } catch {
    /* insufficient inputs: reported as not computed */
  }

  const controls = Object.fromEntries(
    Object.entries(periods).map(([k, [a, b]]) => [
      k,
      { cash: 0, buyHold100: buyHold(bars, a, b, 1, base), matchedExposure: buyHold(bars, a, b, Number(cfg.risk.maxExposure), base) },
    ]),
  );
  const profitable = trials.filter((t) => t.netReturn > 0).length;
  const out = {
    label: 'HISTORICAL SCREENING — simplified candle execution; not forward evidence',
    runId,
    data: { venue: 'coinbase', product: 'BTC-USD', granularity: '5m', candles: n, missingBuckets: missing, from: iso(0), to: iso(n - 1) },
    costs: { base, stress, feeSource: cfg.fees.source, feeVerified: cfg.fees.verified },
    sizing: {
      maxExposure: cfg.risk.maxExposure,
      maxOrderPctEquity: cfg.risk.maxOrderPctEquity,
      minRebalancePctEquity: cfg.risk.minRebalancePctEquity,
    },
    splits: Object.fromEntries(Object.entries(periods).map(([k, [a, b]]) => [k, `${iso(a)}..${iso(b - 1)}`])),
    trialsRegistered: trials.length,
    trialsProfitableDevVal: profitable,
    selected: selected.map((s) => ({
      family: s.family,
      params: s.params,
      devNet: s.dev.netReturn,
      devTrips: s.dev.roundTrips,
      valNet: s.val.netReturn,
      valTrips: s.val.roundTrips,
      valFees: s.val.fees,
    })),
    champion: {
      family: champion.family,
      params: champion.params,
      heldOut: summarize(held),
      heldOutStress: summarize(heldStress),
      fullPeriod: summarize(full),
    },
    controls,
    multipleTesting: {
      activeTrials: active.length,
      deflatedSharpe: dsr ? { bestSharpePerDay: dsr.sharpe, luckBenchmark: dsr.benchmarkSharpe, dsr: dsr.dsr } : 'not computed',
      pbo: pbo ? { pbo: pbo.pbo, inSampleWinnerLostOutOfSample: pbo.probOosLoss } : 'not computed',
    },
    verdict:
      held.netReturn > 0 && (dsr?.dsr ?? 0) >= 0.95
        ? 'promising in screening: confirm with forward paper observation'
        : 'no strategy demonstrated an edge after costs in screening; forward observation would be exploratory only',
  };
  mkdirSync(o.outDir, { recursive: true });
  const dir = join(o.outDir, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'research.json'), JSON.stringify(out, null, 2));
  writeFileSync(
    join(dir, 'trials.csv'),
    'id,strategy,params,netReturn,trades,roundTrips,winRate,fees,maxDrawdown,timeInMarket\n' +
      trials
        .map((t) =>
          [
            t.id,
            t.strategy,
            JSON.stringify(t.params).replace(/,/g, ';'),
            t.netReturn.toFixed(6),
            t.trades,
            t.roundTrips,
            t.winRate ?? '',
            t.fees.toFixed(2),
            t.maxDrawdown.toFixed(5),
            t.timeInMarket.toFixed(4),
          ].join(','),
        )
        .join('\n') +
      '\n',
  );
  writeFileSync(join(dir, 'report.html'), researchHtml(out));
  console.table(
    out.selected.map((s) => ({
      family: s.family,
      devNetPct: +(s.devNet * 100).toFixed(3),
      devTrips: s.devTrips,
      valNetPct: +(s.valNet * 100).toFixed(3),
      valTrips: s.valTrips,
    })),
  );
  console.log(`champion ${champion.family} ${JSON.stringify(champion.params)}`);
  console.log(
    `held-out net ${(held.netReturn * 100).toFixed(3)}% (stress ${(heldStress.netReturn * 100).toFixed(3)}%) vs matched exposure ${(controls.heldOut!.matchedExposure * 100).toFixed(3)}% / BTC ${(controls.heldOut!.buyHold100 * 100).toFixed(3)}%`,
  );
  console.log(
    `trials profitable on dev+validation: ${profitable}/${trials.length}; DSR ${dsr ? dsr.dsr.toFixed(3) : 'n/a'}; PBO ${pbo ? pbo.pbo.toFixed(3) : 'n/a'}`,
  );
  console.log(`verdict: ${out.verdict}`);
  console.log(`report: ${join(dir, 'report.html')}`);
  store.close();
}

function summarize(r: Omit<TrialResult, 'id' | 'period'>) {
  return {
    netReturn: r.netReturn,
    trades: r.trades,
    roundTrips: r.roundTrips,
    winRate: r.winRate,
    fees: r.fees,
    maxDrawdown: r.maxDrawdown,
    timeInMarket: r.timeInMarket,
  };
}

function researchHtml(o: Record<string, unknown> & { selected: Record<string, unknown>[] }): string {
  const pct = (v: unknown) => (typeof v === 'number' ? `${(v * 100).toFixed(3)}%` : escapeHtml(v));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Historical screening</title>
<style>:root{--bg:#fff;--fg:#14171a;--line:#dde2e6;--band:#fff4d6}@media (prefers-color-scheme:dark){:root{--bg:#121416;--fg:#e8eaed;--line:#2c3237;--band:#3a3000}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;max-width:1100px;margin:0 auto;padding:16px}.band{background:var(--band);padding:8px;font-weight:700}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:6px;text-align:left}pre{white-space:pre-wrap;word-break:break-all}</style></head><body>
<div class="band">HISTORICAL SCREENING — simplified candle execution; not forward evidence; PAPER only</div>
<h1>Historical screening</h1>
<table><tr><th>Family</th><th>Selected params (dev)</th><th>Dev net</th><th>Validation net</th></tr>
${o.selected.map((s) => `<tr><td>${escapeHtml(s.family)}</td><td><code>${escapeHtml(JSON.stringify(s.params))}</code></td><td>${pct(s.devNet)}</td><td>${pct(s.valNet)}</td></tr>`).join('')}</table>
<h2>Full output</h2><pre>${escapeHtml(JSON.stringify({ ...o, selected: undefined }, null, 2))}</pre></body></html>`;
}
