import ccxt, { type Exchange } from 'ccxt';
import type { Candle } from '../core/types';
import type { Store } from '../persistence/store';
import { log } from '../core/log';

/**
 * Download 1m OHLCV into the SQLite cache, resuming from the newest cached
 * bar. Public endpoints only. Kraken's REST OHLCV only serves the last 720
 * bars, so backtests use an exchange with deep 1m history (default:
 * Bitstamp) as a BTC/USD price proxy.
 */
export async function fetchHistory(opts: {
  store: Store;
  exchangeId: string;
  symbol: string;
  days: number;
  onProgress?: (fetched: number, upTo: number) => void;
}): Promise<number> {
  const Ctor = (ccxt as unknown as Record<string, new (c: object) => Exchange>)[opts.exchangeId];
  if (!Ctor) throw new Error(`unknown exchange ${opts.exchangeId}`);
  const ex = new Ctor({ enableRateLimit: true, timeout: 20_000 });
  const now = Date.now();
  const start = now - opts.days * 86_400_000;
  const range = opts.store.candleRange(opts.exchangeId, opts.symbol, '1m');
  let since = range.max && range.min !== null && range.min <= start + 60_000 ? range.max + 60_000 : start;
  let total = 0;
  let retries = 0;
  while (since < now - 120_000) {
    try {
      const raw = await ex.fetchOHLCV(opts.symbol, '1m', since, 1000);
      retries = 0;
      const candles: Candle[] = raw
        .filter((r) => (r[0] as number) + 60_000 <= now)
        .map((r) => ({ ts: r[0] as number, open: r[1] as number, high: r[2] as number, low: r[3] as number, close: r[4] as number, volume: r[5] as number }));
      if (candles.length === 0) {
        since += 1000 * 60_000;
        continue;
      }
      opts.store.upsertCandles(opts.exchangeId, opts.symbol, '1m', candles);
      total += candles.length;
      since = candles.at(-1)!.ts + 60_000;
      opts.onProgress?.(total, since);
    } catch (e) {
      if (++retries > 5) throw e;
      log.warn('history fetch error; retrying', { error: String(e), retries });
      await new Promise((r) => setTimeout(r, 2000 * retries));
    }
  }
  return total;
}
