# CLAUDE.md

Intraday (minutes to hours) BTC/USD spot research/paper-trading system. Read `docs/CLAUDE_SUPERVISOR.md` first.

## Hard rules for Claude in this repo

- **Never** enable live trading, edit `LIVE_STAGE_ENABLED`, create `state/live-authorization.json`,
  or ask for/handle API credentials unless the owner explicitly authorizes the live deployment stage
  in the current conversation.
- **Never** loosen `src/risk/limits.ts` or bypass `RiskEngine` / `GuardedAdapter`. Making limits
  stricter needs the owner's approval too.
- Intraday only: never propose holds over 12h or multi-day strategies; the owner chose this scope.
- Never weaken `GATE_CRITERIA` in `src/backtest/gate.ts`.
- Strategy changes go through `proposals/*.json` (`npm run proposal -- validate|compare`); applying
  them is the owner's interactive step.
- Never commit `state/`, `data/`, `reports/`, `.env`, or anything containing secrets.
- Report backtests honestly, including out-of-sample and walk-forward numbers. Never imply that a
  backtest predicts live profit.

## Commands

`npm test` · `npm run typecheck` · `npm run backtest` · `npm run optimize` · `npm run paper -- --duration 10m` ·
`npm run dashboard -- --once` · `npm run report` · `npm run gate` · `npm run context` · `npm run kill`

## Layout

- `src/risk/` hard limits + risk engine (independent of strategy)
- `src/exec/` engine state machine, order guard, paper adapter, live adapter (gated)
- `src/strategy/` pluggable intraday strategies (momentum, vwapReversion, volBreakout) + registry
- `src/backtest/` backtester, optimizer, overfitting stats, random-entry null test, promotion gate
- `src/data/context/` keyless market-context APIs (CoinPaprika, Binance.US, Kraken, Fear & Greed)
- `src/safety/` kill switch and live gate
- `src/supervisor/` proposal validation
- `src/cli/` entry points (see package.json scripts)
