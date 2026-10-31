# Exchange & CCXT MCP validation (2026-10-31)

All checks used **public endpoints only**. No credentials were requested or used.
Re-run at any time with:

```powershell
npm run validate:exchange -- --exchanges kraken,coinbase,bitstamp,gemini
```

## CCXT MCP: what exists

There is **no official MCP server published by the CCXT maintainers** (github.com/ccxt/ccxt).
Community servers built on CCXT:

| Package | Repo | Latest | Notes |
|---|---|---|---|
| `@mcpfun/mcp-server-ccxt` | doggybee/mcp-server-ccxt | 1.2.1 (npm, Apr 2025) | Clear public/private tool split; public tools need no keys; keys via `.env` |
| `@lazydino/ccxt-mcp` | lazy-dinosaur/ccxt-mcp | 0.4.1 (npm, Apr 2025) | Keys in a JSON config; includes futures/leverage tools; README encourages "use entire capital" prompts |

Both are ~18 months old and unaudited. This project therefore:

* uses `@mcpfun/mcp-server-ccxt@1.2.1` (pinned) in `.mcp.json` **for Claude's research and monitoring only**;
* configures it **without any API keys** (public market data only);
* never routes unattended trading through MCP: the deterministic engine in `src/` uses the CCXT library directly.

For account inspection at the live stage, create a separate **read-only key** (Kraken permission "Query Funds" + "Query Open/Closed Orders" only, no trading or withdrawal permission). See `docs/LIVE_ACTIVATION.md`.

> ⚠️ Never put variables named like `KRAKEN_API_KEY` / `KRAKEN_SECRET` in this project's `.env`. The MCP server reads those names from its working directory.

## Exchange comparison (BTC/USD spot, ccxt 4.5.91)

| Exchange | Min order | Price tick | Spread (observed) | WS book / trades / OHLCV | Fits $10 cap? |
|---|---|---|---|---|---|
| **Kraken** (selected) | 0.00006 BTC (≈ $4.63), cost ≥ $0.50 | $0.10 | ~0.01 bps | ✅ / ✅ / ✅ | ✅ |
| Coinbase Advanced | $1.00 | $0.01 | ~0.001 bps | ✅ / ✅ / ❌ | ✅ |
| Bitstamp | **$10.00** | $0.01 | ~0.001 bps | ✅ / ✅ / ❌ | ❌ (minimum = cap) |
| Gemini | not reported by ccxt | – | ~0.001 bps | ✅ / ✅ / ✅ | ? |

Why Kraken: US-accessible spot BTC/USD, minimum well under the $10 cap, full WebSocket support in
ccxt.pro, post-only orders (`oflags=post`) and client order ids (`cl_ord_id`, accepts a UUID) both
supported by ccxt's Kraken implementation, which the duplicate-order protection relies on.

## Fees: verified against the official schedule

| Source | Maker | Taker |
|---|---|---|
| Kraken official fee page, Tier 1 ($0+ 30-day volume) | **0.40%** | **0.80%** |
| Kraken Tier 2 ($2.5K+) | 0.30% | 0.60% |
| Kraken Tier 3 ($10K+ or $20K assets on platform) | 0.22% | 0.38% |
| ccxt's built-in Kraken table (**stale**) | 0.16% | 0.26% |
| Coinbase Advanced (third-party reports; not verified on the official page) | ~0.50–0.60% | ~0.90–1.20% |

`config/default.json` uses the verified Kraken Tier-1 values. **ccxt's static fee table is out of
date and must not be trusted.** At the live stage, `fetchTradingFee` with a read-only key returns the
account's actual tier.

A $25–$50 account trading $10 orders will stay in Tier 1 indefinitely (10 trades/day × $20 round trip
≈ $6K/month at most, so Tier 2 is reachable only at full trade frequency).

## What the fees mean for the specified strategy

| | Per trade, % of notional |
|---|---|
| 1% target, maker in + maker out | **+0.196%** net |
| 0.5% stop, maker in + taker out + spread + 5 bps slippage | **−1.751%** net |
| Win rate needed to break even | **89.9%** |

On a $9.80 position: a win nets about **$0.019**, a loss costs about **$0.17**. Nine wins are erased by one loss.

## Backtest results (Bitstamp 1m data as a BTC/USD price proxy)

Kraken's REST API serves only the last 720 one-minute bars, so history comes from Bitstamp (deep 1m
history, prices within a few dollars of Kraken). Data: 64,799 bars, 2026-09-16 → 2026-10-31.
Fill model: maker entries fill only when price trades *through* the bid; stop beats target in the
same bar; taker exits pay spread plus slippage.

**Baseline (1% / 0.5%, config/strategy.json):** 91 trades, 6.6% win rate, gross −$1.23, fees $10.45,
**net −$11.68** on a $50 account; 26 loss-streak shutdowns (simulation resumes next day).

**Optimizer (162 combos, 70/30 chronological split + 3-fold anchored walk-forward):** every
combination lost money **in-sample**, before any out-of-sample test. Best out-of-sample: −$1.50 over 15
trades. Walk-forward total: **−$3.05 over 27 trades**.

Conclusion: with Tier-1 fees this strategy has **no demonstrated edge**. Gross P&L is negative even
before fees, and fees alone exceed any plausible scalping edge at this size. The system is built to
keep testing; it is not evidence that live trading would be profitable.
