import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { setQuiet } from '../core/log';
import { appContext, backtestCosts, openHistoryStore } from './common';
import { loadStrategyParams } from '../config/load';
import { optimize, type GridSpec, type Summary } from '../backtest/optimize';

/**
 * Parameter search with chronological out-of-sample validation and anchored
 * walk-forward re-optimization.
 *   npm run optimize
 *   npm run optimize -- --days 30 --folds 3
 */
const { values } = parseArgs({
  options: {
    days: { type: 'string' },
    folds: { type: 'string', default: '3' },
    'min-trades': { type: 'string', default: '8' },
  },
});

const GRID: GridSpec = {
  minRocPct: [0.1, 0.15, 0.25],
  volMult: [1.2, 1.5, 2.5],
  takeProfitPct: [0.6, 1.0, 1.5],
  stopLossPct: [0.35, 0.5, 0.8],
  maxHoldMinutes: [60, 180],
};

setQuiet(true); // simulated halts would otherwise flood the console
const { cfg, dataDir, reportsDir } = appContext();
const base = loadStrategyParams();
const store = openHistoryStore(dataDir);
const from = values.days ? Date.now() - Number(values.days) * 86_400_000 : 0;
const candles = store.loadCandles(cfg.backtest.dataExchange, cfg.exchange.symbol, '1m', from);
if (candles.length < 5000) {
  console.error(`Only ${candles.length} cached bars. Run: npm run history:fetch -- --days 30`);
  process.exit(1);
}
const costs = backtestCosts(cfg);
const t0 = Date.now();
const res = optimize(candles, base, GRID, {
  fees: costs.fees,
  spreadBps: costs.spreadBps,
  takerSlippageBps: costs.takerSlippageBps,
  startingUsd: cfg.backtest.startingUsd,
  market: { symbol: cfg.exchange.symbol, ...cfg.exchange.fallback },
  inSampleFraction: cfg.backtest.inSampleFraction,
  minTrades: Number(values['min-trades']),
  topK: 5,
  folds: Number(values.folds),
});

const fmt = (s: Summary) => ({
  trades: s.trades,
  net: Number(s.netPnl.toFixed(4)),
  fees: Number(s.fees.toFixed(4)),
  win: Number(s.winRate.toFixed(2)),
  pf: Number(s.profitFactor.toFixed(2)),
  dd: Number(s.maxDrawdownUsd.toFixed(3)),
  fill: Number(s.fillRate.toFixed(2)),
});
console.log(`${candles.length} bars, ${res.combos} combos, split at ${new Date(res.splitTs).toISOString()} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
console.log('\nBaseline (config/strategy.json):');
console.table({ inSample: fmt(res.baseline.inSample), outOfSample: fmt(res.baseline.outOfSample) });
console.log('\nTop in-sample combos and their OUT-OF-SAMPLE results:');
console.table(
  res.ranked.map((r) => ({
    roc: r.params.minRocPct,
    vol: r.params.volMult,
    tp: r.params.takeProfitPct,
    sl: r.params.stopLossPct,
    hold: r.params.maxHoldMinutes,
    isNet: Number(r.inSample.netPnl.toFixed(4)),
    isTrades: r.inSample.trades,
    oosNet: Number(r.outOfSample.netPnl.toFixed(4)),
    oosTrades: r.outOfSample.trades,
    oosWin: Number(r.outOfSample.winRate.toFixed(2)),
  })),
);
console.log('\nWalk-forward (re-optimized each fold, tested on the next unseen window):');
console.table(
  res.walkForward.folds.map((f) => ({
    trainEnd: new Date(f.trainEnd).toISOString().slice(0, 16),
    testEnd: new Date(f.testEnd).toISOString().slice(0, 16),
    chosen: f.chosen ? `roc${f.chosen.minRocPct} vol${f.chosen.volMult} tp${f.chosen.takeProfitPct} sl${f.chosen.stopLossPct} h${f.chosen.maxHoldMinutes}` : 'none (too few trades)',
    testNet: f.test ? Number(f.test.netPnl.toFixed(4)) : null,
    testTrades: f.test?.trades ?? 0,
  })),
);
console.log(`Walk-forward total: net ${res.walkForward.totalNet.toFixed(4)} USD over ${res.walkForward.totalTrades} trades`);
console.log('\nIn-sample rank is NOT evidence of an edge. Judge by out-of-sample and walk-forward results, and even those do not guarantee live profitability.');
const path = join(reportsDir, `optimize-${Date.now()}.json`);
writeFileSync(path, JSON.stringify({ grid: GRID, costs, ...res }, null, 2));
console.log(`Saved ${path}`);
store.db.close();
