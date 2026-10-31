import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { appContext, openModeStore } from './common';
import { loadStrategyConfig } from '../config/load';
import { RiskEngine } from '../risk/engine';
import { HARD_LIMITS } from '../risk/limits';
import { roundTripEconomics } from '../economics/costs';
import { readKill } from '../safety/killSwitch';

/**
 * Machine-readable status report (JSON on stdout) for Claude, acting as
 * strategy supervisor, and for humans. Contains no credentials.
 *   npm run report -- --mode paper
 */
const { values } = parseArgs({ options: { mode: { type: 'string', default: 'paper' } } });
const mode = values.mode === 'live' ? 'live' : 'paper';
const { cfg, stateDir, reportsDir } = appContext();
const strategyConfig = loadStrategyConfig();
const now = Date.now();

const out: Record<string, unknown> = {
  generatedAt: new Date(now).toISOString(),
  mode,
  exchange: cfg.exchange.id,
  symbol: cfg.exchange.symbol,
  fees: cfg.exchange.fees,
  hardLimits: HARD_LIMITS,
  strategyConfig,
  referenceEconomics_1_5pct_target_1pct_stop: roundTripEconomics(1.5, 1.0, {
    fees: cfg.exchange.fees,
    spreadBps: cfg.backtest.spreadBps,
    takerSlippageBps: cfg.backtest.takerSlippageBps,
  }),
  killSwitch: readKill(stateDir),
  latestReports: existsSync(reportsDir) ? readdirSync(reportsDir).sort().slice(-5) : [],
};

if (existsSync(join(stateDir, `${mode}.db`))) {
  const store = openModeStore(stateDir, mode);
  const risk = new RiskEngine(store);
  out.halt = risk.activeHalt(now) ?? null;
  out.today = risk.dailyStats(now);
  out.totals = store.totals();
  out.balance = store.latestBalance() ?? null;
  out.openPosition = store.openPosition() ?? null;
  out.recentTrades = store.recentTrades(20);
  out.recentEvents = store.recentEvents(20);
  store.db.close();
}

console.log(JSON.stringify(out, null, 2));
