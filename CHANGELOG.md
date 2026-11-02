# Changelog

All notable changes to this project are recorded here (plus full history in git).

## 0.5.0 (2026-11-02): Kalshi paper test

### Added

- **Kalshi paper test** (`node dist/cli.js kalshi start|report|sessions`, `src/kalshi/`): forward
  paper test of research candidate A. In 15-minute commodity markets it joins the best bid on the
  favorite side (bid of 80c or more), i.e. sells longshots to takers.
  - Public data only: the network guard allows Kalshi public GETs and refuses `/portfolio`, POSTs
    and other hosts. No account and no keys.
  - Queue-conservative fills: our order sits behind the displayed queue. It fills when longshot
    buyers trade at our level once the queue ahead is used up, or completely when a trade goes
    through our level.
  - Every observation is recorded before the engine sees it, and `kalshi report` replays the
    recording and verifies the result hash.
  - Frozen parameters in `config/kalshi.paper.yaml`. See `docs/KALSHI_PAPER.md`.
- Research behind it (batch K-01): 21.3M public Kalshi trades from 24 two-hour windows,
  June 30 – October 23, 2026, split into discovery and test halves.
  - **What held up:** only maker-vs-longshot-takers in commodity markets, at about +2.3c per
    contract out of sample (contract-weighted).
  - **What didn't:** taking liquidity lost about 1.1c per contract after fees.
  - **The catch:** a $50 simulation still ended between $28 and $51.

## 0.4.0 (2026-10-31): paper-trading subsystem, profitability research, Binance.US brackets

### Added

- **Event-sourced paper-trading subsystem** (`node dist/cli.js paper ...`, `src/paper/`): exact
  fixed-point money, SQLite ledger, recorded market events, deterministic replay with canonical
  journal hashes, readiness verdicts, HTML/JSON/CSV reports, loopback dashboard and opt-in MCP
  tools. See `docs/PAPER_TRADING.md`.
- **Profitability research** (`paper history`, `paper bracket <batch>`): predeclared batches over
  up to 3 years of 5-minute candles with dev/validation/held-out splits, every trial registered,
  Deflated Sharpe and PBO. About 20,500 trials so far; none passed. See
  `docs/research/2026-10-31-profitability-search.md`.
- **Binance.US public venue** (`venue: binanceus`): combined depth/trade/kline WebSocket with
  snapshot-bridged depth sync and gap detection, venue klines as bars, published 0% maker / 0.02%
  taker fees. Market-data GETs only; no credentials.
- **Post-only limit orders** (`limit-trade-through-v1`): fills only when a trade prints through the
  limit (up to its size) or the book moves through it; touches never fill; maker fee.
- **Brackets** (`src/paper/bracket.ts`): limit entry, resting take-profit, engine-side stop and
  max-hold market exits; one bracket at a time; persisted and replayed exactly.
- `capitulation` strategy (drop on a volume spike, then a green bar), matching the research signal
  bar for bar, and `config/trading.paper.binanceus-capitulation.yaml` for forward testing.

### Fixed

- A partially filled resting limit can now expire (its fill stands, the rest is released).

## 0.3.1 (2026-10-31): logo and README

### Added

- Project logo (`docs/assets/logo.png`, plus a 64px icon at `docs/assets/logo-64.png`).

### Changed

- README rewritten: status at a glance, full feature list (strategies, validation pipeline,
  execution and safety, market context, Claude supervisor, monitoring), architecture, hard limits,
  gate criteria, commands, configuration, live-trading gates, layout and version history.

## 0.3.0 (2026-10-31): intraday redesign, promotion gate, market context

### Changed

- **Built for intraday (minutes to hours).** Strategies are pluggable (`src/strategy/types.ts`) and
  every strategy must close positions within 12 hours (`maxHoldMinutes` <= 720, schema-enforced).
- Exits are chosen per trade at signal time (e.g. ATR- or stretch-sized) and persisted before the
  entry is sent; the engine and backtester apply them to the actual fill price.
- `config/strategy.json` now holds every strategy's parameters plus `active`. All strategies share
  execution settings, including `allowedHoursUtc` (time-of-day filter).
- Proposals name a `strategy`, may change its parameters (including `allowedHoursUtc`), and may
  `activate` it. They still cannot touch risk limits, gate criteria, mode, exchange or fees.

### Added

- `vwapReversion`: buys stretched, high-volume sell-offs below rolling VWAP on the first reversal
  bar; target sized to the stretch (clamped), fixed stop, crash guard.
- `volBreakout`: Bollinger-squeeze breakout on 5-60 min bars with volume and optional trend filter;
  ATR-scaled target and stop.
- Random-entry null test (`src/backtest/nullTest.ts`): does the entry signal beat random entries
  with the same exits, fills, fees and risk engine? Statistic: average net P&L per trade.
- Promotion gate (`npm run gate`, `src/backtest/gate.ts`): walk-forward, out-of-sample, profit
  factor, Deflated Sharpe, PBO and random-entry p-value. The criteria are compiled constants. **Live
  authorization now requires a passing gate result** for the exact active strategy config
  (SHA-256 bound, at most 14 days old).
- Market-context layer (`src/data/context/`, `npm run context`): CoinPaprika (ticker and BTC market
  listings), Binance.US public (api.binance.com is geo-blocked from the US), Kraken public, and
  CoinMarketCap Fear & Greed (keyless website endpoint, with an alternative.me fallback). It provides
  a price-divergence entry veto, stores snapshots in SQLite, and gives Claude research context.
- 36 new tests (119 total), including a look-ahead check for every strategy and a test proving the
  null test detects a real (cheating) edge.

### Findings (45 days, Kraken Tier-1 fees)

| Strategy      | Trades | Avg hold | Net     | Gross  | Random-entry p | Gate |
| ------------- | ------ | -------- | ------- | ------ | -------------- | ---- |
| momentum      | 91     | 89 min   | -$11.68 | -$1.23 | 0.86           | FAIL |
| vwapReversion | 7      | 207 min  | -$1.05  | -$0.23 | 0.79           | FAIL |
| volBreakout   | 29     | 185 min  | -$3.30  | +$0.03 | 0.36           | FAIL |

Random entries with the same exits lose about $0.12 per trade, roughly the round-trip cost. No signal
beats random entries yet.

## 0.2.0 (2026-10-31): overfitting diagnostics

### Added

- `src/backtest/overfitting.ts`: Probability of Backtest Overfitting via CSCV (Bailey et al. 2014),
  Probabilistic Sharpe Ratio, and Deflated Sharpe Ratio (Bailey & López de Prado 2014), computed on
  per-period net P&L across every optimizer trial.
- `npm run optimize` now prints PBO, the out-of-sample loss rate of the in-sample winner, the
  best Sharpe vs. the "luck benchmark" for N trials, and PSR/DSR. `--period-hours` sets the period length.
- Trials with fewer than `--min-trades` trades are excluded from these diagnostics (a do-nothing trial
  earns $0, beats every loser, and fakes a stable ranking).
- 12 new tests (95 total), including noise-only and genuine-edge synthetic cases.

### Findings (45 days, 108 active trials)

- PBO 0%: the ranking is stable, but the in-sample winner lost money out-of-sample in 100% of splits.
- Best Sharpe −0.81 per day vs. luck benchmark +0.73; Deflated Sharpe 0%. No evidence of an edge.

## 0.1.0 (2026-10-31): initial paper-trading system

### Research & validation

- Reviewed the CCXT MCP ecosystem: there is no official CCXT-maintained server. Selected the community
  `@mcpfun/mcp-server-ccxt@1.2.1`, pinned and keyless, for research only.
- Validated BTC/USD on Kraken, Coinbase, Bitstamp and Gemini via public APIs. Selected Kraken
  (min 0.00006 BTC ≈ $4.63; post-only and `cl_ord_id` supported; full WebSocket support).
- Verified Kraken Tier-1 fees (0.40% / 0.80%) on the official page; ccxt's built-in table (0.16% / 0.26%) is stale.

### Added

- Hard risk limits as compiled constants and an independent `RiskEngine`.
- `GuardedAdapter` order-level invariants (no market buys, no shorting, ≤ $10, nothing while halted).
- `TradingEngine` state machine with persisted client order ids, reconciliation, ambiguous-response
  handling, engine-side stop, max hold, safe shutdown.
- `PaperAdapter` with a conservative maker fill model, taker slippage, fault injection and persistence.
- `LiveAdapter` (CCXT), unreachable behind `LIVE_STAGE_ENABLED = false` plus an authorization gate
  bound to code and config fingerprints.
- Market data: ccxt.pro WebSocket with REST polling fallback; staleness detection.
- SQLite persistence (`node:sqlite`): orders, fills, positions, trades, balances, events, candle cache.
- 1m momentum strategy with 5m trend confirmation, volume, spread, extension and net-of-fee target filters.
- Backtester (same risk engine and fill model) and optimizer (out-of-sample + walk-forward).
- Terminal dashboard, JSON report, kill switch, halt status/reset, strategy proposal workflow.
- 83 unit and integration tests; Windows PowerShell documentation.

### Findings

- Baseline 1% / 0.5%: 91 trades over 45 days, net −$11.68 on $50 (fees $10.45). All 162 optimizer
  combinations lost money; walk-forward −$3.05 over 27 trades. No edge demonstrated at Tier-1 fees.
