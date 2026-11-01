# Profitability search, 2026-10-31

Goal: find an intraday (12-hour maximum hold), long-only BTC strategy that is profitable after
realistic costs, without fooling ourselves.

## Protocol (declared before any batch ran)

- **Chronological splits:** development = first 60%, validation = next 20%, held-out = last 20%.
- **Selection:** parameters are chosen on development only. Per family, the best development trial
  that is also positive on validation is run on held-out once.
- **"Profitable" requires:**
  - positive net on development, validation **and** held-out;
  - at least 15 held-out trades;
  - still positive under stressed costs.
- **Every trial is registered** (`experiments` table, `artifacts/research/<batch>/trials.csv`). The
  Deflated Sharpe Ratio and PBO are computed over all active trials, so more searching raises the bar.
- **Batches are predeclared** in `src/paper/research/bracket.ts` (`BATCHES`) and never edited after
  running. New ideas become new batches.

**Execution model (simplified, candle-based):**

- limit entries fill only when price later trades _through_ them (modelling non-fills and adverse selection);
- limit take-profits pay the maker fee;
- stops and timed exits pay taker plus spread and slippage;
- if a stop and the target are both touched in one bar, the stop wins;
- one position at a time at the 20% exposure budget.

Reproduce a batch with `node dist/cli.js paper bracket <batch>`. It needs cached candles:
`paper history --days 1095` (Coinbase) or `paper history binanceus --days 1095`.

## Results

| Batch                        | Data / costs                                                    | Trials | Profitable on development | Passed validation → held-out                                                                                             | Verdict                          |
| ---------------------------- | --------------------------------------------------------------- | ------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| Screening (`paper research`) | Coinbase 1y, market orders, 0.90% taker                         | 156    | 0                         | –                                                                                                                        | fail                             |
| batch-01                     | Coinbase 1y, maker/taker brackets (0.50% / 0.90%)               | 2,970  | 0                         | –                                                                                                                        | fail                             |
| batch-02                     | Coinbase 3y, extreme capitulation and deep dips, bigger targets | 972    | 5                         | none survived validation                                                                                                 | fail                             |
| batch-03                     | **Binance.US** 20 months, published 0% maker / 0.02% taker      | 16,380 | **909**                   | capitulation: dev +2.48% (36 trades), val +0.92% (8), held-out +0.15% but **1 trade**; hour-of-day: held-out −0.24% (14) | fail (too few trades / negative) |
| batch-04                     | Binance.US, trend regime with wide targets                      | 144    | 0                         | –                                                                                                                        | fail                             |

**Multiple testing:**

- batch-03: Deflated Sharpe ≈ 0.0001, PBO 0.46;
- batch-02: Deflated Sharpe 0.002.

No trial's development Sharpe beats what luck alone would produce across that many trials.

## What we learned

1. **Costs decide everything at this account size.** At Coinbase's US entry tier, a round trip costs
   about 1.0–1.4% (maker in and out ≈ 1.0%; a stop ≈ 1.4%). No candle-based intraday signal tested
   carries that much edge per trade.
2. **Gross edge exists in one place.** A zero-cost diagnostic on the development data found capitulation
   entries (a sharp drop on a volume spike followed by a reversal bar) positive in 138 of 172 variants,
   with a mean of +0.135% per trade. That's real but small, and only survives near-zero fees.
3. **At near-zero fees (Binance.US), many variants turn profitable in development** (909 versus 0), but
   none passed the full protocol. The capitulation candidate is the best lead. It's rare (about 3
   trades/month), so the 4-month held-out window held one trade and can't confirm it.
4. **Long-only selective intraday strategies trail buy-and-hold in strong uptrends.** In batch-03's
   held-out window BTC rose about 30%, while the matched-exposure control made about 6%.

## Recommended next step (forward evidence, not more backtest tuning)

Forward-paper-trade the batch-03 capitulation candidate on Binance.US public data, with maker
entries and exits, at the published fees. That needs:

- a Binance.US public depth/trade adapter;
- resting limit-order support in the paper broker, with queue-conservative, trade-through fills.

It would also need a decision on whether Binance.US is an acceptable venue (eligibility, custody and
regulatory history are the owner's call).

The candidate's parameters: `artifacts/research/batch-03/bracket.json` → `perFamily[capitulation].pick`.

## Forward paper test (started 2026-11-01)

Built: the Binance.US public adapter, post-only limits with trade-through fills, and brackets
(`config/trading.paper.binanceus-capitulation.yaml`).

First bounded run, `ps-20261101-2db8bff4`:

- 30 minutes, 4,702 events, 0 reconnects, feed healthy throughout.
- 6 decisions, **0 trades.** The signal fires about 3 times a month, so this is expected.
- Replay matched the canonical journal hash exactly.
- Verdicts: operational correctness = pass, strategy evidence = `insufficient_evidence`.

**Status: not profitable yet.** There's no forward evidence either way.

At about 3 signals a month, reaching the 15+ trades the protocol requires takes roughly 5 months of
continuous forward data.
