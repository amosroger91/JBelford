import { parseArgs } from 'node:util';
import { appContext, openModeStore } from './common';
import { loadStrategyParams } from '../config/load';
import { MarketDataFeed } from '../data/marketData';
import { PaperAdapter } from '../exec/paperAdapter';
import { runEngine } from '../exec/runner';
import { isKillActive, readKill } from '../safety/killSwitch';
import { log } from '../core/log';

/**
 * Paper trading runner: live PUBLIC market data, simulated orders. Needs no
 * API credentials and never calls private exchange endpoints.
 *
 *   npm run paper                       run until Ctrl+C
 *   npm run paper -- --duration 30m     run for a fixed time
 *   npm run paper -- --keep-position    on exit, cancel orders but do not flatten
 */
const { values } = parseArgs({
  options: {
    duration: { type: 'string' },
    'keep-position': { type: 'boolean', default: false },
  },
});

function parseDuration(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = /^(\d+)(s|m|h)$/.exec(s);
  if (!m) throw new Error('duration must look like 90s, 30m or 2h');
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as 's' | 'm' | 'h'];
}

async function main() {
  const { cfg, stateDir } = appContext();
  if (isKillActive(stateDir)) {
    log.error('kill switch is active; refusing to start', { kill: readKill(stateDir) });
    log.error('after investigating, clear it with: npm run halt:reset');
    process.exit(1);
  }
  const params = loadStrategyParams();
  const store = openModeStore(stateDir, 'paper');
  const feed = new MarketDataFeed({
    exchangeId: cfg.exchange.id,
    symbol: cfg.exchange.symbol,
    useWebSocket: cfg.marketData.useWebSocket,
    pollIntervalMs: cfg.marketData.pollIntervalMs,
    candlePollIntervalMs: cfg.marketData.candlePollIntervalMs,
    bootstrapCandles: cfg.marketData.bootstrapCandles,
  });
  const market = await feed.loadMarketInfo(cfg.exchange.fallback);
  const paper = new PaperAdapter(store, {
    startingUsd: cfg.paper.startingUsd,
    fees: cfg.exchange.fees,
    takerSlippageBps: cfg.paper.takerSlippageBps,
    market,
    faults: cfg.paper.faults,
    seed: Date.now() & 0xffffffff,
  });
  await runEngine({
    mode: 'paper',
    cfg,
    params,
    store,
    stateDir,
    feed,
    market,
    adapter: paper,
    paper,
    durationMs: parseDuration(values.duration),
    flattenOnExit: !values['keep-position'],
  });
  store.db.close();
}

main().catch((e) => {
  log.error('paper runner crashed', { error: String(e) });
  process.exit(1);
});
