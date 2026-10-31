import { parseArgs } from 'node:util';
import { appContext, openHistoryStore } from './common';
import { fetchHistory } from '../data/history';

/**
 *   npm run history:fetch -- --days 30
 *   npm run history:fetch -- --days 60 --exchange coinbase
 */
const { values } = parseArgs({ options: { days: { type: 'string', default: '30' }, exchange: { type: 'string' } } });

async function main() {
  const { cfg, dataDir } = appContext();
  const exchangeId = values.exchange ?? cfg.backtest.dataExchange;
  const store = openHistoryStore(dataDir);
  let lastPrint = 0;
  const n = await fetchHistory({
    store,
    exchangeId,
    symbol: cfg.exchange.symbol,
    days: Number(values.days),
    onProgress: (count, upTo) => {
      if (Date.now() - lastPrint > 2000) {
        lastPrint = Date.now();
        console.log(`  ${count} bars, up to ${new Date(upTo).toISOString()}`);
      }
    },
  });
  const r = store.candleRange(exchangeId, cfg.exchange.symbol, '1m');
  console.log(`Fetched ${n} new bars. Cache: ${r.n} bars ${r.min ? new Date(r.min).toISOString() : '-'} .. ${r.max ? new Date(r.max).toISOString() : '-'}`);
  store.db.close();
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
