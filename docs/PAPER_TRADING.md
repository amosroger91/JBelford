# Bitcoin paper trading (Coinbase or Binance.US public data, simulated funds)

**PAPER — SIMULATED FUNDS.** Real public BTC-USD market data; simulated cash, orders and fills.
The system requires no exchange credentials and cannot submit real orders.

Kalshi event-contract paper test: [`docs/KALSHI_PAPER.md`](KALSHI_PAPER.md)

Design: [`docs/adr/0001-paper-trading-subsystem.md`](adr/0001-paper-trading-subsystem.md) ·
plan: [`docs/plans/bitcoin-paper-trading-plan.md`](plans/bitcoin-paper-trading-plan.md)

## Quick start (Windows PowerShell)

```powershell
npm ci
npm run build
node dist/cli.js paper start --config config/trading.paper.yaml --duration 30m   # bounded live-data paper run
node dist/cli.js paper web                                                        # dashboard (prints a tokenized URL)
```

## Commands

| Command                                                                                                            | What it does                                                                                    |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `paper start [--config F] [--strategy ID] [--usd N] [--duration 30m] [--drill disconnect@10m:20s,duplicate@12m:5]` | New session on live public data. `--duration` bounds the _process_; the session stays resumable |
| `paper resume ID [--duration] [--drill]`                                                                           | Restart a runtime for an existing session (restart recovery), or resume a paused one            |
| `paper pause ID` / `paper stop ID`                                                                                 | Cancel open simulated orders and keep inventory. Recorded even when no runtime is attached      |
| `paper flatten ID`                                                                                                 | Explicit simulated liquidation; only with a running session and healthy live data               |
| `paper status [ID]` / `paper sessions`                                                                             | Balances, equity, fills, runtime attachment                                                     |
| `paper replay ID`                                                                                                  | Replay the session's recording into a separate database and compare canonical journal hashes    |
| `paper replay ID --participation 0.0001`                                                                           | Counterfactual thin-liquidity stress on the recorded data (labelled; not a reproduction)        |
| `paper report ID [--output DIR]`                                                                                   | Replay check, readiness verdicts, and HTML/JSON/CSV export with an evidence manifest            |
| `paper history [binanceus]`                                                                                        | Download 5-minute candles into `data/history.db` (Coinbase by default)                          |
| `paper bracket BATCH`                                                                                              | Run a predeclared bracket research batch (`batch-01`..`batch-04`); writes `artifacts/research/` |
| `paper research [--days 360]`                                                                                      | Historical screening on Coinbase 5m candles (simplified execution) plus optimization            |
| `paper web [--port 8787]`                                                                                          | Loopback dashboard with controls                                                                |
| `paper mcp`                                                                                                        | Opt-in MCP toolset (`paper_start/status/pause/resume/stop/report`)                              |

To enable the MCP toolset in Claude Code, add this to `.mcp.json` (opt-in):

```json
{ "mcpServers": { "jbelford-paper": { "command": "node", "args": ["dist/cli.js", "paper", "mcp"] } } }
```

## Strategies (`strategy.id`)

| ID                                                                | Kind                     | Notes                                                                                              |
| ----------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------- |
| `cash`, `buyHold`, `matchedExposure`                              | controls                 | Buy-and-hold and matched-exposure are clamped to `risk.maxExposure`                                |
| `smokeProbe`                                                      | infrastructure check     | Alternates 5% long / flat every bar so orders occur. **Not a candidate**                           |
| `emaTrend`, `donchianBreakout`, `rsiReversion`, `sessionMomentum` | deterministic candidates | Pure rules on completed 5-minute bars; exits after at most 12h                                     |
| `capitulation`                                                    | bracket candidate        | Drop on a volume spike then a green bar; post-only limit entry with take-profit, stop and max hold |
| `llm`                                                             | optional candidate       | Claude API (`claude-opus-5-5`); needs `ANTHROPIC_API_KEY`; frozen model; output validated with Zod |

## Assumptions (all frozen per session and printed in every report)

- **Fees:** Coinbase Advanced US entry tier, taker 0.90% / maker 0.50% (`verified: false`: the official
  page returned HTTP 403; source is third-party reports of the 2026-09-16 schedule). Market orders pay taker.
- **Fills (`ioc-depth-walk-v1`):**
  - market IOC orders arrive 750ms after the decision completes;
  - they fill against the first healthy book received after arrival;
  - they walk displayed depth, taking at most 25% of each level, within a 50 bps guard;
  - the unfilled remainder is cancelled;
  - liquidity our orders consumed is not reused until the venue republishes that level;
  - no market impact or queue-position model.
- **Accounting:** exact decimals; weighted-average cost basis including buy fees; fees rounded up to
  1e-8 USD; spread is never charged twice.
- **Risk (paper placeholders, not live limits):**
  - exposure: at most 20% BTC, including pending orders;
  - order size: at most 5% of equity per order;
  - pause new buys after a 2% UTC-day loss or a 5% drawdown from the high-water mark;
  - spread of at most 10 bps, and at least $100 resting at the best price;
  - at most 12 orders/hour and one open order;
  - a minimum rebalance of 0.5% of equity;
  - paid-model costs must be known and within budget.
- **Valuation:** mid-marked equity plus an executable liquidation value (walk the bids, minus taker fee).
  Stale data is labelled stale and never re-priced.

## Starting a longer experiment

1. **Freeze the configuration.** Copy `config/trading.paper.yaml` to `config/trading.paper.local.yaml`
   and pick the strategy. Changing anything that affects decisions (strategy, fees, risk, execution or
   readiness) creates a new experiment version.
2. **Run it unattended, in bounded chunks.** For example, a daily Task Scheduler job:

   ```powershell
   node dist/cli.js paper start --config config/trading.paper.local.yaml --duration 23h55m
   # following days: resume the same session so evidence accumulates
   node dist/cli.js paper resume SESSION_ID --duration 23h55m
   ```

   Every restart is disclosed as an observation gap; no fills are simulated while offline.

3. **Report periodically:** `npm run test:acceptance` (attaches suite evidence), then
   `node dist/cli.js paper report SESSION_ID`.
4. **Qualification** requires at least 60 days and 100 round trips of untouched forward observation,
   at least 95% coverage, positive net and all-in PnL with complete costs, a positive 95% block-bootstrap
   lower bound versus the matched-exposure control, and robustness under 1.5× fees and +20 bps slippage.
   Until all of these hold, the report says `insufficient_evidence`. That's a normal outcome.
5. **Stop it:** `node dist/cli.js paper stop SESSION_ID`. Starting over means a new session.

## Verification commands

```powershell
npm run format:check
npm run lint
npm run typecheck
npm run build
npm test                 # all unit + acceptance tests
npm run test:acceptance  # the plan's 20 adversarial acceptance areas (writes artifacts/acceptance/latest.json)
npm run test:e2e         # Playwright, desktop + mobile
```

## Binance.US and brackets

```powershell
node dist/cli.js paper start --config config/trading.paper.binanceus-capitulation.yaml --duration 30m
```

- **Venue:** Binance.US public combined stream (depth@100ms, trades, 5-minute klines). Depth is
  synced from a REST snapshot; any sequence gap resets the book and blocks trading until resynced.
  Bars come from the venue's closed klines.
- **Fees:** 0% maker / 0.02% taker, from Binance.US's published schedule (2026-04-22).
- **Limit fills (`limit-trade-through-v1`):** a resting buy at L fills only when a trade prints
  strictly below L (up to that trade's size) or the best ask moves below L. Touching L never fills,
  because queue position is unknown. Fills happen at L with the maker fee.
- **Brackets:** entry is a post-only bid at the best bid, valid for `entryValidBars`. On fill a
  post-only take-profit rests at `tpPct` above the average entry. A stop (`slPct`) or max hold exits
  at market with the taker fee. Pause and stop cancel resting orders and keep inventory; resuming
  re-arms the take-profit.
- Binance.US trades thinly (about one print per 13 seconds), so trade-through fills are rare and the
  model is deliberately pessimistic.
- Choosing Binance.US as a real venue (eligibility, custody, regulatory history) is the owner's call.

## Known limitations

- Fees are unverified against Coinbase's own page (HTTP 403) and not account-specific.
- Our orders' market impact, queue position and venue-side latency are not modelled.
- Warmup bars come from REST candles; live bars are built from trades (they can differ slightly).
- Historical screening uses candles with simplified execution. It's useful for rejecting ideas, not
  for fill claims.
- The LLM strategy's token costs are estimates from a cached price table, recorded per call.
- There is no daemon: a runtime is a foreground (or scheduled) process per session.
- No live trading exists in this subsystem (phase 8 is not implemented).
