import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { setQuiet } from '../core/log';
import { appContext, backtestOpts, openHistoryStore, parseStrategyName, pct } from './common';
import { loadStrategyConfig } from '../config/load';
import { runBacktest } from '../backtest/backtester';
import { summarize } from '../backtest/optimize';
import { createStrategy } from '../strategy/registry';

/**
 * Backtest a strategy from config/strategy.json on cached 1m history.
 *   npm run backtest                          active strategy
 *   npm run backtest -- --strategy vwapReversion --days 14
 */
const { values } = parseArgs({ options: { days: { type: 'string' }, exchange: { type: 'string' }, strategy: { type: 'string' } } });

setQuiet(true); // simulated halts would otherwise flood the console
const { cfg, dataDir, reportsDir } = appContext();
const sc = loadStrategyConfig();
const name = parseStrategyName(values.strategy, sc.active);
const strategy = createStrategy(name, sc[name], cfg.exchange.fees);
const store = openHistoryStore(dataDir);
const exchangeId = values.exchange ?? cfg.backtest.dataExchange;
const from = values.days ? Date.now() - Number(values.days) * 86_400_000 : 0;
const candles = store.loadCandles(exchangeId, cfg.exchange.symbol, '1m', from);
if (candles.length < 1000) {
  console.error(`Only ${candles.length} cached bars. Run: npm run history:fetch -- --days 30`);
  process.exit(1);
}
const opts = backtestOpts(cfg);
const res = runBacktest(candles, { ...opts, strategy });
const s = summarize(res);
const holdMin = res.trades.length ? res.trades.reduce((a, t) => a + (t.closedAt - t.openedAt), 0) / res.trades.length / 60_000 : 0;
console.log(`Strategy: ${name}`);
console.log(`Data: ${exchangeId} ${candles.length} bars ${new Date(res.startTs).toISOString()} .. ${new Date(res.endTs).toISOString()}`);
console.log(`Fees: maker ${pct(opts.fees.maker * 100)} taker ${pct(opts.fees.taker * 100)}, spread ${opts.spreadBps}bps, taker slippage ${opts.takerSlippageBps}bps`);
console.table({
  signals: res.signals,
  entriesPlaced: res.entriesPlaced,
  entriesFilled: res.entriesFilled,
  fillRate: Number(s.fillRate.toFixed(3)),
  blockedByRisk: res.entriesBlocked,
  trades: s.trades,
  avgHoldMinutes: Number(holdMin.toFixed(1)),
  winRate: Number(s.winRate.toFixed(3)),
  netPnlUsd: Number(s.netPnl.toFixed(4)),
  grossPnlUsd: Number(res.grossPnl.toFixed(4)),
  feesUsd: Number(s.fees.toFixed(4)),
  avgNetPerTradeUsd: Number(res.avgNetPerTrade.toFixed(4)),
  profitFactor: Number(s.profitFactor.toFixed(3)),
  maxDrawdownUsd: Number(s.maxDrawdownUsd.toFixed(4)),
  lossStreakShutdowns: s.shutdowns,
  finalEquity: Number(res.finalEquity.toFixed(4)),
});
console.log('Exit reasons:', res.exitReasons);
console.log('Reminder: a profitable backtest does NOT imply live profitability. Use `npm run gate` for the full validation.');
const path = join(reportsDir, `backtest-${name}-${Date.now()}.json`);
writeFileSync(path, JSON.stringify({ strategy: name, params: sc[name], opts, summary: s, result: { ...res, trades: res.trades.slice(-200) } }, null, 2));
console.log(`Saved ${path}`);
store.db.close();
