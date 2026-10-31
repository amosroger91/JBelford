import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { ensureDir, loadAppConfig } from '../config/load';
import type { AppConfig } from '../config/schema';
import { openDb } from '../persistence/db';
import { Store } from '../persistence/store';
import type { CostModel } from '../economics/costs';
import type { BaseOpts } from '../backtest/optimize';
import { STRATEGY_NAMES, type StrategyName } from '../config/schema';

export function appContext(): { cfg: AppConfig; stateDir: string; dataDir: string; reportsDir: string } {
  const cfg = loadAppConfig();
  return {
    cfg,
    stateDir: ensureDir(cfg.paths.stateDir),
    dataDir: ensureDir(cfg.paths.dataDir),
    reportsDir: ensureDir(cfg.paths.reportsDir),
  };
}

/** Separate databases per mode so paper results can never be confused with live ones. */
export function openModeStore(stateDir: string, mode: 'paper' | 'live'): Store {
  return new Store(openDb(join(stateDir, `${mode}.db`)));
}

export function openHistoryStore(dataDir: string): Store {
  return new Store(openDb(join(dataDir, 'history.db')));
}

export function backtestCosts(cfg: AppConfig): CostModel {
  return { fees: cfg.exchange.fees, spreadBps: cfg.backtest.spreadBps, takerSlippageBps: cfg.backtest.takerSlippageBps };
}

/** Backtest settings: configured costs, simulated on the live exchange's market rules. */
export function backtestOpts(cfg: AppConfig): BaseOpts {
  const c = backtestCosts(cfg);
  return {
    fees: c.fees,
    spreadBps: c.spreadBps,
    takerSlippageBps: c.takerSlippageBps,
    startingUsd: cfg.backtest.startingUsd,
    market: { symbol: cfg.exchange.symbol, ...cfg.exchange.fallback },
  };
}

export function parseStrategyName(v: string | undefined, fallback: StrategyName): StrategyName {
  if (v === undefined) return fallback;
  if (!(STRATEGY_NAMES as readonly string[]).includes(v)) throw new Error(`--strategy must be one of ${STRATEGY_NAMES.join(', ')}`);
  return v as StrategyName;
}

/** Ask for an exact typed phrase. Refuses when stdin is not an interactive terminal. */
export async function requireTypedConfirmation(prompt: string, expected: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error('Refusing: this step must be run by a human in an interactive terminal.');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${prompt}\nType exactly:\n  ${expected}\n> `);
    return answer.trim() === expected;
  } finally {
    rl.close();
  }
}

export function pct(v: number, d = 2): string {
  return `${v.toFixed(d)}%`;
}
