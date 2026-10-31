# Market-context data (keyless public APIs)

`src/data/context/` polls free public APIs that need no key or account. Every response is
schema-validated; geo-blocked endpoints (HTTP 451/403) fail fast without retries.

```powershell
npm run context      # one-shot snapshot (JSON), saved to data\history.db
```

During `npm run paper` / `npm run live` the same service runs in the background
(`marketContext.enabled` in `config/default.json`).

## Sources (verified 2026-10-31 from a US connection)

| Source         | Endpoint                                                 | Used for                                                | Status                                                           |
| -------------- | -------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| CoinPaprika    | `GET api.coinpaprika.com/v1/tickers/btc-bitcoin`         | Cross-exchange BTC price, 24h volume, 15m/1h/24h change | ✅ keyless                                                       |
| CoinPaprika    | `GET /v1/coins/btc-bitcoin/markets?quotes=USD`           | Which exchanges list BTC (2,100+ markets), volume share | ✅ keyless                                                       |
| Binance        | `api.binance.com/api/v3/...`                             | –                                                       | ❌ **HTTP 451** for US locations                                 |
| Binance.US     | `GET api.binance.us/api/v3/ticker/price`, `/trades`      | Independent reference price, recent trade flow          | ✅ keyless (default)                                             |
| Kraken         | `GET api.kraken.com/0/public/Ticker`, `/Trades`          | REST cross-check of the WebSocket feed, trade flow      | ✅ keyless                                                       |
| CoinMarketCap  | `pro-api.coinmarketcap.com/...`                          | –                                                       | ❌ requires an API key                                           |
| CoinMarketCap  | `GET api.coinmarketcap.com/data-api/v3/fear-greed/chart` | Fear & Greed daily history (2023 onward)                | ✅ keyless, **undocumented** (used by CMC's website; may change) |
| alternative.me | `GET api.alternative.me/fng/?limit=0`                    | Fear & Greed fallback (documented keyless API)          | ✅ keyless                                                       |

Polling is deliberately slow: exchanges every 15s, CoinPaprika every 5 min (free-tier limits),
Fear & Greed hourly.

## How the system uses them

1. **Price-divergence entry veto (active).** If Kraken's mid differs from a _fresh_ independent
   reference (Binance.US, or Kraken's own REST ticker, which catches a stuck WebSocket) by more than
   `maxDivergenceBps` (default 50 bps), new entries are blocked. Missing or stale references never
   veto, so an outage of a context API can't block trading on its own; the engine's own
   staleness checks handle real outages. This is a data-quality guard, so it needs no proof of edge.
2. **History accumulation.** CoinPaprika snapshots and the full Fear & Greed series are stored in
   SQLite (`context_snapshots`, `fear_greed` tables), so context-based filters can be backtested later.
3. **Claude research context.** `npm run context` gives Claude (as supervisor) cross-exchange
   price, trade-flow imbalance, market listings and sentiment.

## Not yet used for trading decisions

Fear & Greed or trade-flow filters are **not** wired into entry decisions. Only daily Fear & Greed
history exists, and a filter must pass the promotion gate (`npm run gate`) before it influences trades.
Adding one means adding it as a strategy parameter with backtest support, then gating it.
