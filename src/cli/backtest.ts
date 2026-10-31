import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { setQuiet } from '../core/log';
import { appContext, backtestCosts, openHistoryStore, pct } from './common';
import { loadStrategyParams } from '../config/load';
import { runBacktest } from '../backtest/backtester';
import { summarize } from '../backtest/optimize';
import { roundTripEconomics } from '../economics/costs';

/**
 * Backtest the current config/strategy.json on cached 1m history.
 *   npm run backtest
 *   npm run backtest -- --days 14
 */
const { values } = parseArgs({ options: { days: { type: 'string' }, exchange: { type: 'string' } } });

setQuiet(true); // simulated halts would otherwise flood the console
const { cfg, dataDir, reportsDir } = appContext();
const params = loadStrategyParams();
const store = openHistoryStore(dataDir);
const exchangeId = values.exchange ?? cfg.backtest.dataExchange;
const from = values.days ? Date.now() - Number(values.days) * 86_400_000 : 0;
const candles = store.loadCandles(exchangeId, cfg.exchange.symbol, '1m', from);
if (candles.length < 1000) {
  console.error(`Only ${candles.length} cached bars. Run: npm run history:fetch -- --days 30`);
  process.exit(1);
}
const costs = backtestCosts(cfg);
const res = runBacktest(candles, {
  params,
  fees: costs.fees,
  spreadBps: costs.spreadBps,
  takerSlippageBps: costs.takerSlippageBps,
  startingUsd: cfg.backtest.startingUsd,
  market: { symbol: cfg.exchange.symbol, ...cfg.exchange.fallback },
});
const s = summarize(res);
const econ = roundTripEconomics(params.takeProfitPct, params.stopLossPct, costs);
console.log(`Data: ${exchangeId} ${candles.length} bars ${new Date(res.startTs).toISOString()} .. ${new Date(res.endTs).toISOString()}`);
console.log(`Fees: maker ${pct(costs.fees.maker * 100)} taker ${pct(costs.fees.taker * 100)}, spread ${costs.spreadBps}bps, taker slippage ${costs.takerSlippageBps}bps`);
console.log(`Per-trade after costs: win ${pct(econ.winNetPct, 3)} / loss ${pct(econ.lossNetPct, 3)}; breakeven win rate ${pct(econ.breakevenWinRate * 100, 1)}`);
console.table({
  signals: res.signals,
  entriesPlaced: res.entriesPlaced,
  entriesFilled: res.entriesFilled,
  fillRate: Number(s.fillRate.toFixed(3)),
  blockedByRisk: res.entriesBlocked,
  trades: s.trades,
  winRate: Number(s.winRate.toFixed(3)),
  netPnlUsd: Number(s.netPnl.toFixed(4)),
  grossPnlUsd: Number(res.grossPnl.toFixed(4)),
  feesUsd: Number(s.fees.toFixed(4)),
  profitFactor: Number(s.profitFactor.toFixed(3)),
  maxDrawdownUsd: Number(s.maxDrawdownUsd.toFixed(4)),
  lossStreakShutdowns: s.shutdowns,
  finalEquity: Number(res.finalEquity.toFixed(4)),
});
console.log('Exit reasons:', res.exitReasons);
console.log('Reminder: a profitable backtest does NOT imply live profitability.');
const path = join(reportsDir, `backtest-${Date.now()}.json`);
writeFileSync(path, JSON.stringify({ params, costs, summary: s, result: { ...res, trades: res.trades.slice(-200) } }, null, 2));
console.log(`Saved ${path}`);
store.db.close();
