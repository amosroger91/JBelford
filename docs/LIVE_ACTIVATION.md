# Live activation procedure

**Status: NOT AUTHORIZED.** This build cannot trade real money. Do not provide API credentials until
the owner has explicitly authorized the live deployment stage in writing.

## Gates (all must pass; enforced in `src/safety/liveGate.ts`)

1. **Deployment-stage switch:** `LIVE_STAGE_ENABLED = true` in `src/safety/liveGate.ts`. It ships as
   `false`. Flipping it is a code change made only after the owner's explicit authorization.
2. **Mode:** environment variable `JB_TRADING_MODE=live`.
3. **Credentials:** `JB_API_KEY` and `JB_API_SECRET` in the environment, never in files that are committed.
4. **No kill switch:** `state\KILL` must not exist.
5. **Promotion gate passed:** `npm run gate` for the active strategy reports PASS, for the exact
   current `config/strategy.json` (SHA-256), at most 14 days old.
6. **Signed authorization:** `state\live-authorization.json`, created by `npm run live:authorize`:
   * only runs in an **interactive terminal** (automation and Claude's tool calls are refused);
   * shows limits, fees and breakeven economics, then requires typing the exact phrase
     `I AUTHORIZE LIVE TRADING ON KRAKEN BTC/USD WITH REAL MONEY`;
   * expires after at most **24 hours**;
   * stores SHA-256 fingerprints of the risk limits, risk engine, order guard, execution engine, live
     adapter, gate code and both config files. **Any edit to these files invalidates it.**

The `LiveAdapter` can only be constructed with a proof object that `verifyLiveGate()` returns when
every gate passes. Hard risk limits apply identically in live mode and cannot be changed by config.

## Step by step (only after written authorization)

1. **Paper first.** Run paper trading for at least 2 weeks. Compare paper fills and P&L with the backtest.
2. **Exchange account.** Kraken account, fully verified, 2FA on, **withdrawal address allow-list
   enabled**. Deposit only what you can afford to lose ($25–$50).
3. **Trading API key** (Kraken → Settings → API):
   * permissions: *Query Funds*, *Query Open Orders & Trades*, *Query Closed Orders & Trades*,
     *Create & Modify Orders*, *Cancel/Close Orders*;
   * **NOT**: Withdraw Funds, Deposit, Export, Staking, Margin/Futures;
   * restrict to your IP address if it is static;
   * set an expiry date.
4. **Optional read-only key for Claude/MCP account inspection:** Query permissions only, stored only
   in the MCP server's own environment.
5. **Enable the stage** (code change after authorization): set `LIVE_STAGE_ENABLED = true`, commit.
6. **Authorize** (owner, interactive PowerShell):

   ```powershell
   npm run live:authorize -- --operator "Your Name" --hours 8
   ```

7. **Start** (same PowerShell session; variables are not saved to disk):

   ```powershell
   $env:JB_TRADING_MODE = "live"
   $env:JB_API_KEY      = Read-Host "API key"
   $env:JB_API_SECRET   = Read-Host "API secret" -MaskInput   # PowerShell 7; on 5.1 omit -MaskInput
   npm run live
   ```

   Dashboard in a second window: `npm run dashboard -- --mode live`.
8. **First hour:** watch every order on the Kraken website as well as the dashboard.

## Stopping

* Normal: Ctrl+C (cancels orders, flattens).
* Emergency: `npm run kill`, then confirm on the Kraken website that no orders or BTC remain.
* Last resort: revoke the API key on Kraken. The engine detects errors, marks state uncertain and stops trading.

## Known live risks

* **The stop is engine-side.** Kraken spot reserves the BTC for the resting take-profit, so a second
  exchange-side stop order can't be placed. If the PC, network or process dies while in a position,
  only the take-profit is protecting it. On restart the engine reconciles and enforces the stop
  immediately.
* **Partial fills** smaller than the exchange minimum can't be sold by the engine; it halts and asks
  for manual action.
* Fees above Tier 1, or a Kraken fee change, alter the economics. Re-verify before every authorization.
