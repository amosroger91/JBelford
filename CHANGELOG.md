# Changelog

All notable changes to this project are recorded here (plus full history in git).

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
