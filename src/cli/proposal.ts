import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { setQuiet } from '../core/log';
import { appContext, backtestCosts, openHistoryStore, requireTypedConfirmation } from './common';
import { STRATEGY_CONFIG_PATH, loadStrategyParams } from '../config/load';
import { checkProposal } from '../supervisor/proposals';
import { runBacktest } from '../backtest/backtester';
import { summarize } from '../backtest/optimize';

/**
 * Strategy proposals written by Claude (or anyone) live in proposals/*.json.
 *   npm run proposal -- validate proposals/x.json   schema + bounds check, diff
 *   npm run proposal -- compare  proposals/x.json   backtest current vs proposed on cached history
 *   npm run proposal -- apply    proposals/x.json   HUMAN ONLY (interactive), writes config/strategy.json
 * Proposals can never change risk limits, mode, exchange or fees.
 */
const [cmd, file] = process.argv.slice(2);

async function main() {
  if (!cmd || !file) {
    console.error('usage: npm run proposal -- <validate|compare|apply> <file>');
    process.exit(2);
  }
  const current = loadStrategyParams();
  const raw = JSON.parse(readFileSync(resolve(file), 'utf8'));
  const check = checkProposal(raw, current);
  for (const d of check.diff) console.log(`  ${d.key}: ${d.from} -> ${d.to}`);
  if (!check.ok || !check.merged) {
    console.error('PROPOSAL INVALID:');
    for (const e of check.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log('Proposal is valid (strategy parameters only, within bounds).');

  if (cmd === 'compare') {
    const { cfg, dataDir } = appContext();
    setQuiet(true);
    const store = openHistoryStore(dataDir);
    const candles = store.loadCandles(cfg.backtest.dataExchange, cfg.exchange.symbol, '1m');
    if (candles.length < 2000) throw new Error('not enough cached history; run npm run history:fetch first');
    const costs = backtestCosts(cfg);
    const market = { symbol: cfg.exchange.symbol, ...cfg.exchange.fallback };
    const base = { fees: costs.fees, spreadBps: costs.spreadBps, takerSlippageBps: costs.takerSlippageBps, startingUsd: cfg.backtest.startingUsd, market };
    const a = summarize(runBacktest(candles, { ...base, params: current }));
    const b = summarize(runBacktest(candles, { ...base, params: check.merged }));
    console.table({ current: a, proposed: b });
    console.log('Note: this compares on ALL cached data (in-sample for any tuning done on it). Prefer npm run optimize for out-of-sample checks.');
  }

  if (cmd === 'apply') {
    const ok = await requireTypedConfirmation('Apply this proposal to config/strategy.json?', 'APPLY PROPOSAL');
    if (!ok) {
      console.error('Not applied.');
      process.exit(1);
    }
    writeFileSync(STRATEGY_CONFIG_PATH, JSON.stringify(check.merged, null, 2) + '\n');
    const archive = join(dirname(resolve(file)), 'applied');
    mkdirSync(archive, { recursive: true });
    renameSync(resolve(file), join(archive, `${Date.now()}-${basename(file)}`));
    console.log('Applied. Restart the runner to pick it up. (A live authorization, if any, is now invalid.)');
  }
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
