import { appContext, openHistoryStore } from './common';
import { MarketContextService, divergenceVeto } from '../data/context/service';
import { binanceTrades, krakenTicker, krakenTrades } from '../data/context/providers';

/**
 * One-shot market context snapshot from the keyless public APIs
 * (CoinPaprika, Binance.US, Kraken, CoinMarketCap / alternative.me Fear & Greed).
 * Snapshots and the Fear & Greed history are saved to data/history.db.
 *   npm run context
 */
async function main() {
  const { cfg, dataDir } = appContext();
  const store = openHistoryStore(dataDir);
  const svc = new MarketContextService(store, cfg.marketContext);
  const results = await Promise.allSettled([svc.pollExchanges(), svc.pollPaprika(), svc.pollFearGreed()]);
  const errors = results.flatMap((r, i) =>
    r.status === 'rejected' ? [`${['exchanges', 'coinpaprika', 'fearGreed'][i]}: ${String(r.reason)}`] : [],
  );

  const [kt, kTrades, bTrades] = await Promise.allSettled([
    krakenTicker(),
    krakenTrades(100),
    binanceTrades(cfg.marketContext.binanceBaseUrl, 'BTCUSD', 100),
  ]);
  const flow = (t: PromiseSettledResult<{ qty: number; side: 'buy' | 'sell' }[]>) => {
    if (t.status !== 'fulfilled' || t.value.length === 0) return null;
    const buy = t.value.filter((x) => x.side === 'buy').reduce((s, x) => s + x.qty, 0);
    const total = t.value.reduce((s, x) => s + x.qty, 0);
    return { trades: t.value.length, buyVolumePct: Number(((buy / total) * 100).toFixed(1)) };
  };
  const mid = kt.status === 'fulfilled' ? (kt.value.bid + kt.value.ask) / 2 : NaN;
  const s = svc.status;
  const out = {
    generatedAt: new Date().toISOString(),
    kraken: kt.status === 'fulfilled' ? kt.value : null,
    references: s.refs,
    divergence: Number.isFinite(mid)
      ? divergenceVeto(
          mid,
          s.refs.filter((r) => r.source !== 'kraken-rest'),
          Date.now(),
          cfg.marketContext.maxDivergenceBps,
          cfg.marketContext.maxReferenceAgeMs,
        )
      : null,
    recentTradeFlow: { kraken: flow(kTrades), binanceUs: flow(bTrades) },
    coinpaprika: s.paprika,
    btcMarkets: s.markets
      ? { listed: s.markets.count, topByVolume: s.markets.top.slice(0, 8).map((m) => `${m.exchange} ${m.pair} $${m.priceUsd.toFixed(0)}`) }
      : null,
    fearGreed: s.fearGreed ? { ...s.fearGreed, date: new Date(s.fearGreed.ts).toISOString().slice(0, 10) } : null,
    errors,
  };
  console.log(JSON.stringify(out, null, 2));
  store.db.close();
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
