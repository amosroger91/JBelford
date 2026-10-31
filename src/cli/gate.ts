import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { setQuiet } from '../core/log';
import { appContext, backtestOpts, openHistoryStore, parseStrategyName } from './common';
import { STRATEGY_CONFIG_PATH, loadStrategyConfig } from '../config/load';
import { DEFAULT_GRIDS } from '../strategy/registry';
import { GATE_CRITERIA, runGate, saveGateResult } from '../backtest/gate';
import { sha256File } from '../safety/liveGate';
import type { GridSpec } from '../backtest/optimize';

/**
 * Promotion gate for the ACTIVE strategy in config/strategy.json. Every check
 * must pass before live trading can be authorized. The result is bound to the
 * exact strategy config by SHA-256.
 *   npm run gate
 *   npm run gate -- --sims 200
 *   npm run gate -- --strategy vwapReversion   research a non-active strategy (cannot authorize live)
 */
const { values } = parseArgs({
  options: { sims: { type: 'string', default: '100' }, days: { type: 'string' }, strategy: { type: 'string' } },
});

setQuiet(true);
const { cfg, dataDir, stateDir, reportsDir } = appContext();
const sc = loadStrategyConfig();
const name = parseStrategyName(values.strategy, sc.active);
const store = openHistoryStore(dataDir);
const from = values.days ? Date.now() - Number(values.days) * 86_400_000 : 0;
const candles = store.loadCandles(cfg.backtest.dataExchange, cfg.exchange.symbol, '1m', from);
if (candles.length < 10_000) {
  console.error(`Only ${candles.length} cached bars; the gate needs at least 10,000. Run: npm run history:fetch -- --days 45`);
  process.exit(1);
}
const t0 = Date.now();
const r = runGate(
  candles,
  sc,
  name,
  DEFAULT_GRIDS[name] as GridSpec,
  { ...backtestOpts(cfg), inSampleFraction: cfg.backtest.inSampleFraction },
  sha256File(STRATEGY_CONFIG_PATH),
  Number(values.sims),
);
console.log(`Promotion gate: ${name}  (${r.data.bars} bars ${r.data.from} .. ${r.data.to}, ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
console.table(
  r.checks.map((c) => ({
    check: c.name,
    value: c.value === null ? 'n/a' : Number(c.value.toFixed(4)),
    required: c.threshold,
    result: c.pass ? 'PASS' : 'FAIL',
  })),
);
if (r.nullTest) {
  const n = r.nullTest;
  console.log(
    `Random-entry test: strategy ${n.strategyAvgNet.toFixed(4)} USD/trade over ${n.strategyTrades} trades vs random mean ${n.nullMeanAvgNet.toFixed(4)} ` +
      `(90% range ${n.nullP05.toFixed(4)} .. ${n.nullP95.toFixed(4)}, ${n.simulations} sims)`,
  );
}
console.log(`\nRESULT: ${r.pass ? 'PASS' : 'FAIL'}  (criteria are compiled constants: ${JSON.stringify(GATE_CRITERIA)})`);
if (!r.pass) console.log('Live authorization stays blocked. Keep paper trading and researching.');
else console.log('Passing the gate does NOT guarantee live profit. It is the minimum bar for considering it.');
saveGateResult(stateDir, r);
const path = join(reportsDir, `gate-${name}-${Date.now()}.json`);
writeFileSync(path, JSON.stringify(r, null, 2));
console.log(`Saved ${path}`);
store.db.close();
