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

## First live runs (2026-11-02) and K-02 risk rules

**Live paper runs with the K-01 config** (`config/kalshi.paper.yaml`). Replay matched the live hash.

| Session                | Window (UTC) | Result          | Markets W/L | Per contract |
| ---------------------- | ------------ | --------------- | ----------- | ------------ |
| `ks-20261102-fc6ba0ff` | 05:00–07:00  | $50 → $98.24    | 53 / 2      | +8.8¢        |
| `ks-20261102-7508e507` | 07:02–15:02  | $50 → about $13 | 142 / 24    | −2.4¢        |

The overnight losses came in clusters: several commodities lost in the same 15-minute window
(3 at 07:15 UTC, 4 at 14:30 UTC). Seven of the 24 losses fell between 8:00 and 9:30am New York time.
Fills from orders that swept through our price lost 5.7¢ per contract, against −0.2¢ at our price.
That's one night, and it isn't used for any rule.

**K-02 (rules chosen on the June–August research half only)**, using 15-minute commodity series,
maker against takers buying longshots, weighted by contracts:

- **8:00–11:59 New York time** earned +0.56¢ (t 0.2) in June–August and +0.02¢ in September–October.
  Every other 4-hour block earned +1.8 to +6.3¢.
- **Favorites at 95¢ or more** earned +1.9¢ in June–August and +0.6¢ in September–October, while
  tying up about 97¢ of collateral per contract.

**$50 simulation on the held-out September–October half**, taking a 2–20% share of each qualifying
taker trade:

| Rules                                  | Ending balance | Lowest point                       |
| -------------------------------------- | -------------- | ---------------------------------- |
| Baseline                               | $216–227       | $36–44                             |
| R1: no orders 8:00–11:59 New York time | $187–210       | never below $50                    |
| R2: favorite ≤ 95¢                     | $217–231       | about the same as baseline         |
| R3: at most $15 per close time         | $111–115       | not better than baseline (dropped) |

On the June–August half, no rule raised the ending balance. R3 cut it from about $82 to $72–77.

**The earlier $28–51 simulation was wrong for this config.** It also included about 3,300 trades in
daily, weekly and monthly commodity markets, which tie up collateral for days. Restricted to the
15-minute markets that are actually traded, the same simulation gives $216–227.

**Replaying the live recordings with R1+R2:**

- **2-hour run:** $95.77.
- **Overnight run:** $56.24, against about $13 as run. This comparison is not independent: those
  losses prompted the diagnosis, even though the rules were chosen on June–August data.
- **Limit of replays:** positions the live run never held have no recorded results, so a replay
  values them at cost.

**Why the forward test still matters:** the historical simulation lets us share in every
longshot trade, with no queue. Live, we join the best bid behind the displayed queue. That gap is
the main uncertainty, and the overnight run's −2.4¢ per contract is a warning about it.

**Next step:** a forward run with `config/kalshi.k02.yaml`:

```powershell
node dist/cli.js kalshi start --config config/kalshi.k02.yaml --duration 10h
```
