# Kalshi paper test (public data, simulated funds)

**PAPER — SIMULATED FUNDS.** This uses Kalshi's public market data with simulated cash, orders and
fills. It needs no account and no API keys, and it never sends an order. The network guard only
allows public GET requests: series, markets, order books, trades and market results. Any
`/portfolio` request, POST, or other host is refused.

## What it tests

It tests research candidate A from batch K-01: being a maker against takers who buy longshots in
Kalshi's 15-minute commodity markets.

**Research data:**

- 21.3M public trades from 24 two-hour windows, June 30 – October 23, 2026;
- 18.8M of those trades were in markets that had settled;
- the scripts are kept outside the repo.

**Selection:**

- The candidate was chosen on the June–August half only. On the September–October half it held up:
  - **per trade:** +3.8¢ per contract in the discovery half (t = 2.4) and +3.35¢ in the test half
    (t = 2.7), with standard errors clustered by event;
  - **weighted by contracts:** +2.3¢ per contract in the test half;
  - 19 of 24 windows were positive.
- About 100 category and strategy combinations were scanned to find it.

**Why this needs a live test:**

- A $50 simulation over the test half ended between $28 and $51.
- Rare correlated losses (a whole ladder of longshots hitting at once) dominate a small bankroll.
- Queue position, and whether our fills skew toward informed takers, can only be measured live.

**Rule (frozen in `config/kalshi.paper.yaml`):**

- In each open market of the listed series, whichever side's best bid is at least 80¢ is the
  favorite. We join that best bid, which means we sell the longshot (priced 20¢ or less).
- One order per market. Size is `orderContracts`, capped at $10 of collateral per market and at
  free cash.
- An order re-quotes while it's unfilled, and is cancelled when the side is no longer the favorite
  or when the market closes.
- Positions settle at $1 or $0 per contract, and a voided market is refunded.
- These series charge no maker fee. A maker-fee series would be charged
  0.0175 × p × (1−p) per contract, rounded up to the cent.

## Fill model (queue-conservative)

- Our order sits behind everything already displayed at its price.
- A taker who buys the longshot at our level consumes the queue ahead of us first, then fills us.
- A trade below our price went through our level, so it fills us completely.
- Taker buys of the favorite never touch our order. Neither do trades stamped before we placed it.
- We assume orders ahead of us were cancelled only when the displayed size falls below our queue
  estimate.

## Commands

```powershell
npm run build
node dist/cli.js kalshi start --duration 2h      # bounded live paper run; Ctrl+C stops cleanly
node dist/cli.js kalshi sessions
node dist/cli.js kalshi report SESSION_ID         # replay the recording, verify the hash, export CSV/JSON
```

- **Recordings:** `data/kalshi/<session>/events.jsonl` holds every observation, recorded before the
  engine sees it. `report` replays it, and the hash must match the live run.
- **Reports:** written to `artifacts/kalshi/<session>/`.

## Limits

- **Polling, not streaming.** Order books and trades are polled every 3 seconds, so fills between
  polls are applied in timestamp order. Kalshi's WebSocket needs an authenticated account, which
  this project deliberately doesn't use.
- **Not modelled:** our own effect on the queue, and fills on orders we would have cancelled.
- **Account access isn't settled.** Trading on Kalshi needs an account, and eligibility is the
  owner's decision. Nothing here connects to one.
