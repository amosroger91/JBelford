import { z } from 'zod';
import { getJson, type FetchOpts } from './http';

/**
 * Keyless public market-context sources. All are read-only and need no
 * account. Every response is validated; numbers arrive as strings on several
 * APIs and are coerced.
 */

const num = z.coerce.number().refine(Number.isFinite, 'not a finite number');

// ---------- CoinPaprika (aggregate cross-exchange data) ----------
// Docs: https://api.coinpaprika.com  Free tier is rate limited; poll every few minutes.

const PaprikaTicker = z.object({
  id: z.literal('btc-bitcoin'),
  last_updated: z.string(),
  quotes: z.object({
    USD: z.object({
      price: num,
      volume_24h: num,
      percent_change_15m: num,
      percent_change_1h: num,
      percent_change_24h: num,
      market_cap: num,
    }),
  }),
});

export interface PaprikaSnapshot {
  price: number;
  volume24hUsd: number;
  pctChange15m: number;
  pctChange1h: number;
  pctChange24h: number;
  lastUpdated: number;
}

export async function coinpaprikaTicker(o?: FetchOpts): Promise<PaprikaSnapshot> {
  const t = await getJson('https://api.coinpaprika.com/v1/tickers/btc-bitcoin', PaprikaTicker, { minIntervalMs: 2000, ...o });
  const q = t.quotes.USD;
  return {
    price: q.price,
    volume24hUsd: q.volume_24h,
    pctChange15m: q.percent_change_15m,
    pctChange1h: q.percent_change_1h,
    pctChange24h: q.percent_change_24h,
    lastUpdated: Date.parse(t.last_updated),
  };
}

const PaprikaMarkets = z.array(
  z.object({
    exchange_id: z.string(),
    exchange_name: z.string(),
    pair: z.string(),
    category: z.string().optional(),
    outlier: z.boolean().optional(),
    adjusted_volume_24h_share: num.optional(),
    quotes: z.object({ USD: z.object({ price: num, volume_24h: num }) }),
  }),
);

export interface BtcMarket {
  exchange: string;
  pair: string;
  priceUsd: number;
  volume24hUsd: number;
  volumeSharePct: number;
  outlier: boolean;
}

/** Which exchanges list BTC, with price and volume share. Spot, non-outlier, sorted by volume. */
export async function coinpaprikaMarkets(o?: FetchOpts): Promise<BtcMarket[]> {
  const rows = await getJson('https://api.coinpaprika.com/v1/coins/btc-bitcoin/markets?quotes=USD', PaprikaMarkets, { minIntervalMs: 2000, ...o });
  return rows
    .filter((r) => (r.category ?? 'Spot') === 'Spot')
    .map((r) => ({
      exchange: r.exchange_name,
      pair: r.pair,
      priceUsd: r.quotes.USD.price,
      volume24hUsd: r.quotes.USD.volume_24h,
      volumeSharePct: r.adjusted_volume_24h_share ?? 0,
      outlier: r.outlier ?? false,
    }))
    .sort((a, b) => b.volume24hUsd - a.volume24hUsd);
}

// ---------- Binance (US) public market data ----------
// api.binance.com refuses US locations (HTTP 451); api.binance.us serves the same API shape.

const BinancePrice = z.object({ symbol: z.string(), price: num });
const BinanceTrades = z.array(z.object({ id: z.number(), price: num, qty: num, time: z.number(), isBuyerMaker: z.boolean() }));

export interface TradePrint {
  price: number;
  qty: number;
  ts: number;
  side: 'buy' | 'sell';
}

export async function binancePrice(baseUrl: string, symbol = 'BTCUSD', o?: FetchOpts): Promise<number> {
  return (await getJson(`${baseUrl}/api/v3/ticker/price?symbol=${symbol}`, BinancePrice, o)).price;
}

export async function binanceTrades(baseUrl: string, symbol = 'BTCUSD', limit = 50, o?: FetchOpts): Promise<TradePrint[]> {
  const rows = await getJson(`${baseUrl}/api/v3/trades?symbol=${symbol}&limit=${limit}`, BinanceTrades, o);
  // isBuyerMaker = the aggressor was the seller.
  return rows.map((r) => ({ price: r.price, qty: r.qty, ts: r.time, side: r.isBuyerMaker ? 'sell' : 'buy' }));
}

// ---------- Kraken public REST ----------

const KrakenTicker = z.object({
  error: z.array(z.string()),
  result: z.record(z.string(), z.object({ a: z.array(z.string()), b: z.array(z.string()), c: z.array(z.string()) })),
});
const KrakenTrades = z.object({
  error: z.array(z.string()),
  result: z.record(z.string(), z.unknown()),
});

export async function krakenTicker(o?: FetchOpts): Promise<{ bid: number; ask: number; last: number }> {
  const r = await getJson('https://api.kraken.com/0/public/Ticker?pair=XBTUSD', KrakenTicker, o);
  if (r.error.length) throw new Error(`kraken: ${r.error.join(', ')}`);
  const t = Object.values(r.result)[0];
  if (!t) throw new Error('kraken: empty ticker');
  return { bid: Number(t.b[0]), ask: Number(t.a[0]), last: Number(t.c[0]) };
}

export async function krakenTrades(count = 50, o?: FetchOpts): Promise<TradePrint[]> {
  const r = await getJson(`https://api.kraken.com/0/public/Trades?pair=XBTUSD&count=${count}`, KrakenTrades, o);
  if (r.error.length) throw new Error(`kraken: ${r.error.join(', ')}`);
  const rows = Object.entries(r.result).find(([k]) => k !== 'last')?.[1];
  const parsed = z.array(z.tuple([num, num, num, z.enum(['b', 's'])]).rest(z.unknown())).parse(rows);
  return parsed.map(([price, qty, t, side]) => ({ price, qty, ts: Math.round(t * 1000), side: side === 'b' ? 'buy' : 'sell' }));
}

// ---------- Fear & Greed ----------

const CmcFearGreed = z.object({
  data: z.object({ dataList: z.array(z.object({ score: num, timestamp: num })) }),
});

/**
 * CoinMarketCap Fear & Greed daily history. Uses the keyless endpoint that
 * CMC's own website calls; it is NOT a documented public API and may change.
 * The documented CMC API (pro-api) requires a key.
 */
export async function cmcFearGreedHistory(o?: FetchOpts): Promise<{ ts: number; score: number }[]> {
  const r = await getJson(
    `https://api.coinmarketcap.com/data-api/v3/fear-greed/chart?start=1&end=${Math.floor(Date.now() / 1000)}`,
    CmcFearGreed,
    { minIntervalMs: 5000, ...o },
  );
  return r.data.dataList.map((d) => ({ ts: d.timestamp * 1000, score: d.score }));
}

const AltFearGreed = z.object({ data: z.array(z.object({ value: num, timestamp: num })) });

/** Alternative.me Crypto Fear & Greed (documented keyless API), used as fallback. */
export async function altFearGreedHistory(limit = 0, o?: FetchOpts): Promise<{ ts: number; score: number }[]> {
  const r = await getJson(`https://api.alternative.me/fng/?limit=${limit}`, AltFearGreed, { minIntervalMs: 5000, ...o });
  return r.data.map((d) => ({ ts: d.timestamp * 1000, score: d.value })).sort((a, b) => a.ts - b.ts);
}
