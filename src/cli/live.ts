import { appContext, openModeStore } from './common';
import { loadStrategyParams } from '../config/load';
import { verifyLiveGate } from '../safety/liveGate';
import { LiveAdapter } from '../exec/liveAdapter';
import { MarketDataFeed } from '../data/marketData';
import { runEngine } from '../exec/runner';
import { log } from '../core/log';

/**
 * Live runner. Refuses to start unless EVERY gate condition holds; see
 * docs/LIVE_ACTIVATION.md. In this build LIVE_STAGE_ENABLED is false, so this
 * always exits without touching any private API.
 */
async function main() {
  const { cfg, stateDir } = appContext();
  const gate = verifyLiveGate({ stateDir, exchangeId: cfg.exchange.id });
  if (!gate.ok || !gate.authorization) {
    console.error('LIVE TRADING REFUSED:');
    for (const r of gate.reasons) console.error(`  - ${r}`);
    process.exit(1);
  }
  const params = loadStrategyParams();
  const store = openModeStore(stateDir, 'live');
  const adapter = new LiveAdapter(gate.authorization, cfg.exchange.id, cfg.exchange.symbol);
  await adapter.init();
  const feed = new MarketDataFeed({
    exchangeId: cfg.exchange.id,
    symbol: cfg.exchange.symbol,
    useWebSocket: cfg.marketData.useWebSocket,
    pollIntervalMs: cfg.marketData.pollIntervalMs,
    candlePollIntervalMs: cfg.marketData.candlePollIntervalMs,
    bootstrapCandles: cfg.marketData.bootstrapCandles,
  });
  await runEngine({ mode: 'live', cfg, params, store, stateDir, feed, market: adapter.marketInfo(), adapter, flattenOnExit: true });
  store.db.close();
}

main().catch((e) => {
  log.error('live runner crashed', { error: String(e) });
  process.exit(1);
});
