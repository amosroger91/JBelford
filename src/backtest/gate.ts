import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Candle } from '../core/types';
import type { StrategyConfig, StrategyName } from '../config/schema';
import { runBacktest } from './backtester';
import { makeStrategy, optimize, summarize, type BaseOpts, type GridSpec, type OptimizeResult, type Summary } from './optimize';
import { randomEntryTest, type NullTestResult } from './nullTest';

/**
 * Promotion criteria a strategy must meet before live trading can even be
 * authorized. Compiled constants, like the risk limits: not configurable and
 * not proposable.
 */
export const GATE_CRITERIA = Object.freeze({
  minWalkForwardTrades: 30,
  minDeflatedSharpe: 0.95,
  maxPbo: 0.5,
  maxNullPValue: 0.05,
  minProfitFactor: 1.1,
  maxAgeDays: 14,
});

export interface GateCheck {
  name: string;
  pass: boolean;
  value: number | null;
  threshold: string;
}

export interface GateResult {
  pass: boolean;
  strategy: StrategyName;
  strategyConfigSha256: string;
  createdAt: string;
  data: { bars: number; from: string; to: string };
  checks: GateCheck[];
  full: Summary;
  optimize: Pick<OptimizeResult, 'baseline' | 'walkForward' | 'overfitting' | 'combos'>;
  nullTest: NullTestResult | null;
}

export function runGate(
  candles: Candle[],
  cfg: StrategyConfig,
  name: StrategyName,
  grid: GridSpec,
  opts: BaseOpts & { inSampleFraction: number },
  strategyConfigSha256: string,
  nullSims = 100,
): GateResult {
  const C = GATE_CRITERIA;
  const params = cfg[name] as unknown as Record<string, unknown>;
  const strategy = makeStrategy(name, params, opts.fees);
  const full = summarize(runBacktest(candles, { ...opts, strategy }));
  const opt = optimize(candles, name, params, grid, { ...opts, minTrades: 8, topK: 3, folds: 3 });
  let nullTest: NullTestResult | null = null;
  try {
    nullTest = randomEntryTest(candles, strategy, opts, nullSims);
  } catch {
    nullTest = null;
  }
  const wf = opt.walkForward;
  const avgNet = full.trades ? full.netPnl / full.trades : 0;
  const checks: GateCheck[] = [
    { name: 'walk-forward net P&L > 0', pass: wf.totalNet > 0, value: wf.totalNet, threshold: '> 0' },
    { name: 'walk-forward trades', pass: wf.totalTrades >= C.minWalkForwardTrades, value: wf.totalTrades, threshold: `>= ${C.minWalkForwardTrades}` },
    { name: 'out-of-sample net (current params)', pass: opt.baseline.outOfSample.netPnl > 0, value: opt.baseline.outOfSample.netPnl, threshold: '> 0' },
    { name: 'full-sample avg net per trade', pass: avgNet > 0, value: avgNet, threshold: '> 0' },
    { name: 'full-sample profit factor', pass: full.profitFactor >= C.minProfitFactor, value: full.profitFactor, threshold: `>= ${C.minProfitFactor}` },
    {
      name: 'deflated Sharpe (grid)',
      pass: (opt.overfitting.dsr?.dsr ?? 0) >= C.minDeflatedSharpe,
      value: opt.overfitting.dsr?.dsr ?? null,
      threshold: `>= ${C.minDeflatedSharpe}`,
    },
    {
      name: 'probability of backtest overfitting',
      pass: opt.overfitting.pbo !== null && opt.overfitting.pbo.pbo <= C.maxPbo,
      value: opt.overfitting.pbo?.pbo ?? null,
      threshold: `<= ${C.maxPbo}`,
    },
    {
      name: 'random-entry p-value (signal beats random entries)',
      pass: nullTest !== null && nullTest.pValue <= C.maxNullPValue,
      value: nullTest?.pValue ?? null,
      threshold: `<= ${C.maxNullPValue}`,
    },
  ];
  return {
    pass: checks.every((c) => c.pass),
    strategy: name,
    strategyConfigSha256,
    createdAt: new Date().toISOString(),
    data: { bars: candles.length, from: new Date(candles[0]?.ts ?? 0).toISOString(), to: new Date(candles.at(-1)?.ts ?? 0).toISOString() },
    checks,
    full,
    optimize: { baseline: opt.baseline, walkForward: opt.walkForward, overfitting: opt.overfitting, combos: opt.combos },
    nullTest,
  };
}

export function gateResultPath(stateDir: string): string {
  return join(stateDir, 'gate-latest.json');
}

export function saveGateResult(stateDir: string, r: GateResult): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(gateResultPath(stateDir), JSON.stringify(r, null, 2));
}

/** Reasons the stored gate result does NOT authorize the current config (empty = OK). */
export function gateBlockers(stateDir: string, activeStrategy: StrategyName, currentSha: string, now = Date.now()): string[] {
  const path = gateResultPath(stateDir);
  if (!existsSync(path)) return ['no promotion gate result (run `npm run gate`)'];
  try {
    const r = JSON.parse(readFileSync(path, 'utf8')) as GateResult;
    const out: string[] = [];
    if (!r.pass) out.push('promotion gate FAILED: ' + r.checks.filter((c) => !c.pass).map((c) => c.name).join(', '));
    if (r.strategy !== activeStrategy) out.push(`gate result is for ${r.strategy}, active strategy is ${activeStrategy}`);
    if (r.strategyConfigSha256 !== currentSha) out.push('config/strategy.json changed since the gate ran');
    if (now - Date.parse(r.createdAt) > GATE_CRITERIA.maxAgeDays * 86_400_000) out.push(`gate result older than ${GATE_CRITERIA.maxAgeDays} days`);
    return out;
  } catch (e) {
    return [`gate result unreadable: ${String(e)}`];
  }
}
