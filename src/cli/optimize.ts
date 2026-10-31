import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { setQuiet } from '../core/log';
import { appContext, backtestOpts, openHistoryStore, parseStrategyName } from './common';
import { loadStrategyConfig } from '../config/load';
import { DEFAULT_GRIDS } from '../strategy/registry';
import { optimize, type GridSpec, type Summary } from '../backtest/optimize';

/**
 * Parameter search with chronological out-of-sample validation and anchored
 * walk-forward re-optimization.
 *   npm run optimize
 *   npm run optimize -- --days 30 --folds 3
 *   npm run optimize -- --strategy volBreakout
 */
const { values } = parseArgs({
  options: {
    days: { type: 'string' },
    folds: { type: 'string', default: '3' },
    'min-trades': { type: 'string', default: '8' },
    'period-hours': { type: 'string', default: '24' },
    strategy: { type: 'string' },
  },
});


setQuiet(true); // simulated halts would otherwise flood the console
const { cfg, dataDir, reportsDir } = appContext();
const sc = loadStrategyConfig();
const name = parseStrategyName(values.strategy, sc.active);
const base = sc[name] as unknown as Record<string, unknown>;
const GRID = DEFAULT_GRIDS[name] as GridSpec;
const store = openHistoryStore(dataDir);
const from = values.days ? Date.now() - Number(values.days) * 86_400_000 : 0;
const candles = store.loadCandles(cfg.backtest.dataExchange, cfg.exchange.symbol, '1m', from);
if (candles.length < 5000) {
  console.error(`Only ${candles.length} cached bars. Run: npm run history:fetch -- --days 30`);
  process.exit(1);
}
const t0 = Date.now();
const res = optimize(candles, name, base, GRID, {
  ...backtestOpts(cfg),
  inSampleFraction: cfg.backtest.inSampleFraction,
  minTrades: Number(values['min-trades']),
  topK: 5,
  folds: Number(values.folds),
  periodHours: Number(values['period-hours']),
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
console.log(`Strategy ${name}: ${candles.length} bars, ${res.combos} combos, split at ${new Date(res.splitTs).toISOString()} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
/** Compact label of the parameters the grid varies. */
const describe = (p: Record<string, unknown>) =>
  Object.keys(GRID)
    .map((k) => `${k}=${String(p[k])}`)
    .join(' ');
console.log('\nBaseline (config/strategy.json):');
console.table({ inSample: fmt(res.baseline.inSample), outOfSample: fmt(res.baseline.outOfSample) });
console.log('\nTop in-sample combos and their OUT-OF-SAMPLE results:');
console.table(
  res.ranked.map((r) => ({
    params: describe(r.params),
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
    chosen: f.chosen ? describe(f.chosen) : 'none (too few trades)',
    testNet: f.test ? Number(f.test.netPnl.toFixed(4)) : null,
    testTrades: f.test?.trades ?? 0,
  })),
);
console.log(`Walk-forward total: net ${res.walkForward.totalNet.toFixed(4)} USD over ${res.walkForward.totalTrades} trades`);
const of = res.overfitting;
console.log(
  `\nOverfitting diagnostics (${of.trialsUsed} trials with >= ${values['min-trades']} trades, ${of.trialsExcluded} near-inactive excluded, ${of.periodHours}h periods):`,
);
if (of.error) console.log(`  unavailable: ${of.error}`);
console.log('  Low PBO only means the ranking is stable; check the out-of-sample loss rate and Deflated Sharpe for profitability.');
if (of.pbo) {
  console.log(
    `  PBO (CSCV, ${of.pbo.blocks} blocks, ${of.pbo.splits} splits): ${(of.pbo.pbo * 100).toFixed(1)}%  ` +
      '(chance the in-sample winner ranks below median out-of-sample; above 50% means selection is worse than random)',
  );
  console.log(`  In-sample winner lost money out-of-sample in ${(of.pbo.probOosLoss * 100).toFixed(1)}% of splits`);
}
if (of.dsr) {
  const p = of.dsr.params;
  console.log(
    `  Best full-sample Sharpe: ${of.dsr.sharpe.toFixed(3)}/period (${describe(p)}); ` +
      `luck benchmark for ${of.dsr.trials} trials: ${of.dsr.benchmarkSharpe.toFixed(3)}`,
  );
  console.log(`  Probabilistic Sharpe P(SR>0): ${(of.dsr.psr * 100).toFixed(1)}%   Deflated Sharpe: ${(of.dsr.dsr * 100).toFixed(1)}%  (want > 95%)`);
}
console.log('\nIn-sample rank is NOT evidence of an edge. Judge by out-of-sample and walk-forward results, and even those do not guarantee live profitability.');
const path = join(reportsDir, `optimize-${name}-${Date.now()}.json`);
writeFileSync(path, JSON.stringify({ grid: GRID, ...res }, null, 2));
console.log(`Saved ${path}`);
store.db.close();
