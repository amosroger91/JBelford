<p align="center">
  <img src="docs/assets/logo.png" alt="JBelford logo" width="220">
</p>

<h1 align="center">JBelford</h1>

<p align="center">
  <b>Intraday BTC/USD research, backtesting and paper-trading system</b><br>
  TypeScript · CCXT · SQLite · Claude as strategy supervisor
</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-0.4.0-blue">
  <img alt="tests" src="https://img.shields.io/badge/tests-119%20passing-brightgreen">
  <img alt="mode" src="https://img.shields.io/badge/mode-paper%20only-orange">
  <img alt="live" src="https://img.shields.io/badge/live%20trading-disabled-red">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522.13-339933">
</p>

---

JBelford researches, validates and **paper trades** short-term BTC/USD spot strategies. Holds last
**minutes to hours, never more than 12 hours**, and positions are sized for an eventual $25–$50
account. It runs locally with negligible infrastructure cost: a SQLite file, public market data, no
paid services.

**Paper trading is the default and the only enabled mode.** Live trading code exists, but it sits
behind six independent gates and is switched off in this build (see
[Live trading](#live-trading-locked)).

## Status at a glance

> **No strategy has a demonstrated edge yet.** Every strategy fails the promotion gate on 45 days of
> 1-minute data at Kraken's verified Tier-1 fees (0.40% maker / 0.80% taker).

| Strategy        | Style                               | Trades | Avg hold | Net (on $50) | Gross (pre-fee) | Beats random entries? | Gate    |
| --------------- | ----------------------------------- | ------ | -------- | ------------ | --------------- | --------------------- | ------- |
| `momentum`      | 1m momentum + 5m trend              | 91     | 89 min   | −$11.68      | −$1.23          | No (p = 0.86)         | ❌ FAIL |
| `vwapReversion` | Fade stretched sell-offs below VWAP | 7      | 207 min  | −$1.05       | −$0.23          | No (p = 0.79)         | ❌ FAIL |
| `volBreakout`   | 15m squeeze breakout                | 29     | 185 min  | −$3.30       | +$0.03          | No (p = 0.36)         | ❌ FAIL |

What the numbers say:

- **Fees dominate.** Entering at random times with the same exits loses about **$0.12 per trade**,
  roughly the round-trip fee on a $9.80 order. A 1% target nets only +0.196% after maker fees, and a
  0.5% stop costs −1.75%, so the original 1% / 0.5% setup needs a ~90% win rate to break even.
- **Tuning doesn't fix it.** All 162 momentum parameter combinations lost money, even on the data
  they were tuned on. The Deflated Sharpe Ratio is 0%.

Full research: [`docs/EXCHANGE_VALIDATION.md`](docs/EXCHANGE_VALIDATION.md) ·
[`CHANGELOG.md`](CHANGELOG.md).

## Features

### Intraday strategies (pluggable)

- **Three built-in strategies**, chosen with `active` in [`config/strategy.json`](config/strategy.json):
  - **`momentum`:** 1-minute momentum with 5-minute trend confirmation, volume, spread and
    over-extension filters.
  - **`vwapReversion`:** buys the first green reversal bar after a sharp, high-volume sell-off that
    stretched price below the rolling VWAP. The target scales with the stretch, and a crash guard
    skips free-falls.
  - **`volBreakout`:** waits for a Bollinger-band squeeze on 5–60 minute bars, then buys a
    high-volume breakout above recent highs. Target and stop scale with ATR.
- **Per-trade exits:** each strategy sizes its own target and stop at signal time. They're persisted
  before the order is sent and applied to the actual fill price.
- **Time-of-day filter:** `allowedHoursUtc` lists the UTC hours when new entries are allowed.
- **Intraday by construction:** the config schema rejects any max hold over 720 minutes.
- **Net-of-fee check:** no entry unless the target still clears `minNetTargetPct` after maker fees on
  both sides.
- Every strategy is tested for look-ahead: a signal at bar _i_ must not change when later bars are added.

### Validation pipeline

- **Backtester:** uses the same strategy code, risk engine and fill model as paper trading.
  - Maker orders fill only when price trades _through_ them, which models non-fills and adverse
    selection.
  - If a stop and a target are both touched in one bar, the stop is assumed to hit first.
  - Taker exits pay spread, slippage and taker fees.
- **Optimizer:** grid search with a chronological 70/30 in-sample/out-of-sample split and anchored
  walk-forward re-optimization.
- **Overfitting diagnostics:**
  - **PBO**, the Probability of Backtest Overfitting, via combinatorially symmetric
    cross-validation (Bailey et al. 2014);
  - **Probabilistic and Deflated Sharpe Ratio** (Bailey & López de Prado 2014).
  - Combinations that barely trade are excluded, so do-nothing combinations can't fake a stable ranking.
- **Random-entry null test:** does the entry signal beat random entry times with identical exits,
  fees, fills and risk rules?
- **Promotion gate:** `npm run gate` runs all of the above against fixed criteria. Live
  authorization requires a recent PASS for the exact strategy config.

### Execution and safety

- **Deterministic engine:** FLAT → post-only bid → LONG with a resting post-only take-profit, plus an
  engine-side stop and max hold → FLAT.
- **Independent risk engine:** hard limits are compiled constants. They're not read from config, env
  vars, CLI flags or proposals.
- **Order guard (`GuardedAdapter`):** a second check on every order. It blocks market buys, selling
  BTC you don't hold, orders over $10, symbols other than BTC/USD, and any buy while halted.
- **Duplicate prevention:** each order gets a UUID client order id, saved _before_ sending (Kraken `cl_ord_id`).
- **Reconciliation:** runs at startup, after errors and after any ambiguous exchange response.
  - Orders are matched by client id.
  - Unrecognized orders on the exchange trigger a halt.
  - The BTC balance is checked against tracked positions.
  - While state is uncertain, nothing new is sent.
- **Kill switch:** `npm run kill`, or create `state\KILL`. Running engines cancel orders, flatten and
  stop within about a second, and won't restart until a human resets them.
- **Safe shutdown:** Ctrl+C cancels open orders and flattens the position. A second Ctrl+C forces an exit.
- **No secrets in code or logs:** credentials come only from environment variables at the live
  stage, and a log redactor scrubs credential-like fields and registered secret values.

### Market data and context

- **Exchange feed:** ccxt.pro WebSocket order book and trades, with automatic REST polling fallback.
  - Data older than 15s blocks new entries.
  - Data stale for 5 minutes halts trading.
- **Keyless context APIs** (`npm run context`):
  - **CoinPaprika:** cross-exchange BTC price and volume, plus which exchanges list BTC.
  - **Binance.US:** public price and trades. `api.binance.com` refuses US connections with HTTP 451.
  - **Kraken:** public ticker and trades.
  - **CoinMarketCap Fear & Greed:** keyless but undocumented endpoint, with an alternative.me fallback.
- **Price-divergence veto:** new entries are blocked when Kraken's price differs from a fresh
  independent reference by more than 0.5%.
- Context snapshots and Fear & Greed history are stored in SQLite, so context filters can be
  backtested later.

### Claude as strategy supervisor

- **Research:** Claude uses the CCXT MCP server ([`.mcp.json`](.mcp.json), keyless) and
  `npm run context`.
- **Proposals:** Claude writes `proposals/*.json` that change one strategy's parameters, or propose
  activating it. The schema rejects risk limits, gate criteria, mode, exchange and fees.
- **Human-only steps:** applying proposals, resetting halts and authorizing live trading all require
  typing a phrase in an interactive terminal, which automated tools can't do.

### Monitoring

- **Terminal dashboard:** balance, equity, open position, trade history, net P&L, fees, risk
  counters, data freshness, halts and recent events.
- **`npm run report`:** a JSON status report for Claude and for humans.

## Architecture

```
            ┌──────────────────────────────┐
 Claude ───▶│ CCXT MCP + context APIs      │  research / monitoring (read-only, keyless)
 (advisor)  └──────────────────────────────┘
    │ writes proposals/*.json (strategy params only; a human applies them)
    ▼
┌────────────┐  book/candles  ┌─────────────────┐ signal ┌──────────────────────┐
│ MarketData │───────────────▶│ TradingEngine   │◀───────│ Strategy (pluggable) │
│ WS + poll  │                │ state machine,  │        │ momentum, vwapRev.,  │
└────────────┘                │ reconciliation  │        │ volBreakout          │
┌────────────┐  entry veto    │                 │        └──────────────────────┘
│ Context    │───────────────▶│                 │
│ APIs       │                └───────┬─────────┘
└────────────┘         evaluateEntry  │  every order
                     ┌────────────────▼───────────────┐
                     │ RiskEngine (hard limits, code) │
                     │ GuardedAdapter (order guard)   │
                     └────────────────┬───────────────┘
                          ┌───────────┴──────────┐
                     PaperAdapter (default)   LiveAdapter (gated, disabled)
                          │
                     SQLite: orders, fills, positions, trades, balances, events, context
```

**Path from idea to live:**

```
idea → backtest → optimize (out-of-sample + walk-forward) → gate (PBO, DSR, random-entry test)
     → paper trading (2+ weeks) → owner authorization (interactive, ≤24h, hash-bound) → live
```

## Hard risk limits

Defined in [`src/risk/limits.ts`](src/risk/limits.ts). These are compiled constants: not configurable, and not proposable.

| Limit                    | Value                                                            |
| ------------------------ | ---------------------------------------------------------------- |
| Market                   | BTC/USD spot only. No leverage, margin, borrowing or derivatives |
| Open positions           | 1                                                                |
| Max order value          | $10 (subject to exchange minimums)                               |
| Max daily loss           | $1, realized plus unrealized; open position is flattened         |
| Consecutive losses       | 3 → shutdown until a human resets it                             |
| Completed trades         | 10 per UTC day                                                   |
| Cooldown between trades  | 5 minutes                                                        |
| Stale data               | 15s blocks entries; 5 minutes halts                              |
| Uncertain exchange state | No new orders until reconciled                                   |

## Promotion gate criteria

Defined in [`src/backtest/gate.ts`](src/backtest/gate.ts). Also compiled constants.

| Check                               | Required                             |
| ----------------------------------- | ------------------------------------ |
| Walk-forward net P&L                | > 0                                  |
| Walk-forward trades                 | ≥ 30                                 |
| Out-of-sample net (current params)  | > 0                                  |
| Average net per trade (full sample) | > 0                                  |
| Profit factor (full sample)         | ≥ 1.1                                |
| Deflated Sharpe Ratio (whole grid)  | ≥ 95%                                |
| Probability of Backtest Overfitting | ≤ 50%                                |
| Random-entry p-value                | ≤ 0.05                               |
| Result age (for live authorization) | ≤ 14 days, same strategy config hash |

## Quick start (Windows PowerShell)

```powershell
npm install
npm test
npm run validate:exchange                 # exchange minimums, fees, WebSocket support
npm run history:fetch -- --days 45        # cache 1m candles
npm run backtest -- --strategy volBreakout
npm run gate                              # promotion gate for the active strategy
npm run context                           # keyless market context snapshot
npm run paper                             # window 1: paper trading on live data
npm run dashboard                         # window 2
npm run kill                              # emergency stop
```

Full guide: [`docs/WINDOWS_SETUP.md`](docs/WINDOWS_SETUP.md).

## Commands

| Command                                                         | Purpose                                                                             |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `npm run validate:exchange [-- --exchanges a,b]`                | Market minimums, precision, WebSocket support, spread, fee economics (public API)   |
| `npm run history:fetch -- --days N`                             | Cache 1m candles in `data/history.db` (Bitstamp by default; Kraken serves only 12h) |
| `npm run backtest [-- --strategy X --days N]`                   | Backtest one strategy                                                               |
| `npm run optimize [-- --strategy X]`                            | Grid search, out-of-sample, walk-forward, PBO and Deflated Sharpe                   |
| `npm run gate [-- --strategy X --sims N]`                       | Promotion gate. Live authorization requires a PASS for the active strategy          |
| `npm run context`                                               | CoinPaprika, Binance.US, Kraken and Fear & Greed snapshot                           |
| `npm run paper [-- --duration 2h --strategy X --keep-position]` | Paper trading on live public data                                                   |
| `npm run dashboard [-- --mode live --once]`                     | Terminal dashboard                                                                  |
| `npm run report [-- --mode paper]`                              | JSON status report                                                                  |
| `npm run proposal -- validate\|compare\|apply <file>`           | Strategy proposals (apply is human-only)                                            |
| `npm run kill [-- --reason "..."]`                              | Emergency kill switch                                                               |
| `npm run halt:status` / `npm run halt:reset`                    | Inspect or clear halts (reset is interactive)                                       |
| `npm run live:authorize`, `npm run live`                        | Live stage, **disabled in this build**                                              |
| `npm test` / `npm run typecheck`                                | 119 unit and integration tests / TypeScript check                                   |

## Configuration

| File                                           | What it holds                                                                          | Who changes it                  |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------- |
| [`config/default.json`](config/default.json)   | Exchange, verified fees, market data, paper and backtest settings, context APIs, paths | Owner                           |
| [`config/strategy.json`](config/strategy.json) | `active` strategy plus every strategy's parameters                                     | Owner, via proposals            |
| [`src/risk/limits.ts`](src/risk/limits.ts)     | Hard risk limits                                                                       | Code only, needs owner approval |
| [`src/backtest/gate.ts`](src/backtest/gate.ts) | Promotion criteria                                                                     | Code only, needs owner approval |
| `.env`                                         | Live credentials, **only** at the live stage                                           | Owner; never committed          |

## Live trading (locked)

Live trading requires **all** of the following ([`docs/LIVE_ACTIVATION.md`](docs/LIVE_ACTIVATION.md)):

1. `LIVE_STAGE_ENABLED = true` in [`src/safety/liveGate.ts`](src/safety/liveGate.ts). It ships `false`.
2. `JB_TRADING_MODE=live` in the environment.
3. `JB_API_KEY` / `JB_API_SECRET` in the environment, with trade permission only and no withdrawals.
4. No active kill switch.
5. A passing promotion gate for the exact active strategy config, at most 14 days old.
6. An owner authorization from `npm run live:authorize`:
   - only works in an interactive terminal, where you type the exact phrase;
   - lasts 24 hours at most;
   - is bound by SHA-256 to the risk, engine and gate code and both config files.

## Project layout

```
src/
  risk/          hard limits + risk engine
  exec/          engine state machine, order guard, paper adapter, live adapter (gated), runner
  strategy/      momentum, vwapReversion, volBreakout, indicators, registry
  backtest/      backtester, optimizer, overfitting stats, random-entry test, promotion gate
  data/          exchange feed (WS + polling), history download
  data/context/  keyless context APIs + price-divergence veto
  economics/     fee, spread and slippage math
  safety/        kill switch, live gate
  supervisor/    proposal validation (Claude's only write path)
  dashboard/     snapshot + terminal renderer
  persistence/   SQLite (node:sqlite) schema and store
  cli/           npm script entry points
test/            119 unit + integration tests (vitest)
docs/            setup, validation research, live procedure, supervisor rules, context APIs
```

## Docs

- [`docs/WINDOWS_SETUP.md`](docs/WINDOWS_SETUP.md): install, run, schedule, emergency stop
- [`docs/EXCHANGE_VALIDATION.md`](docs/EXCHANGE_VALIDATION.md): CCXT MCP review, exchange comparison, fees, all backtest and gate results
- [`docs/MARKET_CONTEXT.md`](docs/MARKET_CONTEXT.md): keyless context APIs and how they're used
- [`docs/CLAUDE_SUPERVISOR.md`](docs/CLAUDE_SUPERVISOR.md): what Claude may and may not do; proposal format
- [`docs/LIVE_ACTIVATION.md`](docs/LIVE_ACTIVATION.md): locked live procedure
- [`CHANGELOG.md`](CHANGELOG.md): every change, version by version

## Version history

| Version | Highlights                                                                                                                                                                         |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.4.0   | Event-sourced paper subsystem (`paper ...`): exact-money ledger, replay, readiness; profitability research; Binance.US venue, post-only limits and brackets                        |
| 0.3.1   | Logo, README rewrite                                                                                                                                                               |
| 0.3.0   | Intraday redesign: pluggable strategies, VWAP reversion, volatility breakout, time-of-day filter, random-entry test, promotion gate, market-context APIs and price-divergence veto |
| 0.2.0   | Overfitting diagnostics: PBO and Probabilistic/Deflated Sharpe                                                                                                                     |
| 0.1.0   | Paper-trading system: risk engine, execution engine, paper adapter, backtester, optimizer, dashboard, kill switch, gated live stage                                                |

## Disclaimer

Research software. Backtests, gate results and paper trading do **not** guarantee live
profitability, and so far no strategy here has shown an edge. Nothing in this repository is financial advice.
