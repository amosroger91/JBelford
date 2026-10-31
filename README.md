# JBelford: BTC/USD spot scalping research & paper trading

A TypeScript system for researching, backtesting and **paper trading** short-term BTC/USD spot
strategies, sized for an eventual $25–$50 account. Paper trading is the default and the only
enabled mode. **Live trading is disabled in this build** (see `docs/LIVE_ACTIVATION.md`).

> **Read this first: current findings.** At Kraken's verified Tier-1 fees (0.40% maker / 0.80% taker),
> the specified 1% target / 0.5% stop nets **+0.196%** per win and **−1.75%** per loss, so it needs a
> **~90% win rate** to break even. On 45 days of 1-minute data, the baseline lost $11.68 of $50 and
> **every one of 162 parameter combinations lost money**, including out-of-sample and walk-forward.
> Details: [`docs/EXCHANGE_VALIDATION.md`](docs/EXCHANGE_VALIDATION.md).

## Architecture

```
            ┌──────────────────────────────┐
 Claude ───▶│ CCXT MCP (public data only)  │  research / monitoring
 (advisor)  └──────────────────────────────┘
    │ writes proposals/*.json (strategy params only; human applies)
    ▼
┌────────────┐  book/candles  ┌─────────────────┐ signal ┌──────────────┐
│ MarketData │───────────────▶│ TradingEngine   │◀───────│ Momentum     │
│ WS + poll  │                │ state machine,  │        │ strategy     │
└────────────┘                │ reconciliation  │        └──────────────┘
                              └───────┬─────────┘
                       evaluateEntry  │  every order
                     ┌────────────────▼───────────────┐
                     │ RiskEngine (hard limits, code) │
                     │ GuardedAdapter (order guard)   │
                     └────────────────┬───────────────┘
                          ┌───────────┴──────────┐
                     PaperAdapter (default)   LiveAdapter (gated, disabled)
                          │
                     SQLite: orders, fills, positions, trades, balances, events
```

* **Deterministic execution engine** (`src/exec/engine.ts`): FLAT → post-only bid → LONG with
  resting post-only take-profit, plus engine-side stop and max hold → FLAT.
* **Independent risk engine** (`src/risk/`): limits are compiled constants, not config. A second
  layer, `GuardedAdapter`, checks every order (no market buys, no shorting, ≤ $10, nothing while halted).
* **Duplicate prevention:** each order gets a UUID client order id, persisted *before* sending
  (Kraken `cl_ord_id`).
* **Reconciliation:** at startup, after errors and after any ambiguous response. It matches orders
  by client id, flags orphan orders and checks the BTC balance against tracked positions. If state is
  uncertain, nothing new is sent.
* **Realistic fills:** maker orders fill only when price trades *through* them (models non-fills and
  adverse selection); taker exits pay spread, slippage and taker fees.
* **Market data:** ccxt.pro WebSocket order book and trades, automatic REST polling fallback, and
  staleness detection (15s blocks entries, 5 min halts).

## Hard risk limits (`src/risk/limits.ts`)

BTC/USD spot only · 1 position · $10 max order · $1 max daily realized + unrealized loss ·
3 consecutive losses → shutdown (manual reset) · 10 trades/day · 5 min cooldown · halt on stale
data or uncertain exchange state.

## Quick start (Windows PowerShell)

```powershell
npm install
npm test
npm run validate:exchange
npm run history:fetch -- --days 45
npm run backtest
npm run optimize
npm run paper              # window 1
npm run dashboard          # window 2
npm run kill               # emergency stop
```

Full guide: [`docs/WINDOWS_SETUP.md`](docs/WINDOWS_SETUP.md).

## Commands

| Command | Purpose |
|---|---|
| `npm run validate:exchange` | Market minimums, precision, WS support, spread, fee economics (public API) |
| `npm run history:fetch -- --days N` | Cache 1m candles in `data/history.db` |
| `npm run backtest` | Backtest `config/strategy.json` |
| `npm run optimize` | Grid search, 70/30 out-of-sample, anchored walk-forward |
| `npm run paper [-- --duration 2h]` | Paper trading on live public data |
| `npm run dashboard [-- --mode live]` | Terminal dashboard: balance, equity, trades, net P&L, fees |
| `npm run report` | JSON status for Claude/humans |
| `npm run proposal -- validate/compare/apply <file>` | Strategy proposals (apply is human-only) |
| `npm run kill` | Emergency kill switch |
| `npm run halt:status` / `halt:reset` | Inspect / clear halts (reset is interactive) |
| `npm run live:authorize`, `npm run live` | Live stage, **disabled** |

## Docs

* [`docs/EXCHANGE_VALIDATION.md`](docs/EXCHANGE_VALIDATION.md): CCXT MCP review, exchange minimums, fees, backtest results
* [`docs/WINDOWS_SETUP.md`](docs/WINDOWS_SETUP.md): setup, running, scheduling
* [`docs/LIVE_ACTIVATION.md`](docs/LIVE_ACTIVATION.md): gated live procedure (requires the owner's authorization)
* [`docs/CLAUDE_SUPERVISOR.md`](docs/CLAUDE_SUPERVISOR.md): what Claude may and may not do
* [`CHANGELOG.md`](CHANGELOG.md): change history

## Disclaimer

Research software. Backtests and paper results do not guarantee live profitability. Nothing here is
financial advice.
