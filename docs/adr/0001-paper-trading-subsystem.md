# ADR 0001: Paper-trading subsystem (plan phases 0–7)

Date: 2026-10-31 · Status: accepted · Plan: [`docs/plans/bitcoin-paper-trading-plan.md`](../plans/bitcoin-paper-trading-plan.md)

The plan was written against LLM-Swarm. It was implemented here in JBelford, with these
adaptations and decisions.

## Decisions

1. **Separate subsystem.** All new code lives in `src/paper/` with its own SQLite database
   (`state/paper/trading.db`) and migrations. The earlier Kraken scalper (`src/exec`, `state/paper.db`)
   is untouched.
2. **Venue: Coinbase Advanced Trade public data**, as the plan specifies. Verified live on 2026-10-31:
   level2 (`l2_data`), `market_trades` and `heartbeats` arrive on one unauthenticated socket, with no key.
   **`sequence_num` is one counter per connection across all channels** (0 gaps in a live capture), so
   gaps are detected per socket and per epoch, and counters are never compared across reconnects.
3. **Exact money.** `src/paper/money.ts` uses bigint fixed point at a scale of 10⁻¹² with explicit
   rounding. Fees are rounded up to 0.00000001 USD. Floats are used only for statistics.
4. **One event loop, one clock.** Every input becomes an ordinal-numbered event, recorded before it is
   processed: market messages, 1-second ticks, strategy completions, controls and lifecycle changes.
   Receipt time is the only clock. Replay feeds the recording through the same runtime, so live and
   replay share execution, risk and accounting exactly.
5. **Model calls never block the feed.** LLM decisions run asynchronously and re-enter as
   `decision_ready` events bound to a session generation. Pause, stop and restart bump the generation,
   so late answers cannot trade. One decision may be in flight; later bars are skipped and audited.
6. **Fill model `ioc-depth-walk-v1`:**
   - market IOC orders arriving after a configurable delay (750ms default);
   - they walk the real order book with a participation cap and an execution guard;
   - liquidity consumed by our orders is remembered per level until the venue republishes that level;
   - market impact and queue position are not modelled, and this is disclosed in reports.
7. **No daemon.** JBelford has none. A single-owner lease row guards each session. CLI and dashboard
   controls are queued to the running runtime. With no runtime attached, they are applied through a
   short-lived runtime, so they're still recorded events and replay stays exact.
8. **Deterministic identities.** Decision, order and fill IDs derive from bar times and event ordinals,
   unique per session (primary key `(session_id, order_id)`). The canonical journal excludes session
   IDs, client order IDs, audit rows and export metadata.
9. **Network allowlist by method + host + path**, enforced in one client (`guardedGet`). The only
   WebSocket allowed is the public one; authenticated subscribe fields and private channels are refused.
   Credentials are never attached, even when present in the environment.
10. **Dashboard:**
    - loopback only;
    - a per-process token (query string on first load, then an HttpOnly SameSite=Strict cookie, plus
      an `X-Paper-Token` header on POST);
    - exact Host and Origin checks and a strict CSP;
    - all external content is rendered with `textContent`.
11. **MCP:** an opt-in stdio server with six bounded `paper_*` tools. It has no order or exchange RPC.
12. **LLM candidate:** `@anthropic-ai/sdk` `messages.parse` with a Zod schema, model `claude-opus-5-5`
    (frozen per experiment). Server-side model fallback is deliberately **off**, so models are never
    silently mixed. Any refusal, model change, invented snapshot ID, timeout or malformed output
    becomes a recorded `hold`.
13. **Qualification** returns `operationalCorrectness` and `strategyEvidence` with per-gate evidence.
    It never changes mode or grants access to funds.

## Deviations from the plan, with reasons

- **No "CLI strategy providers" exist here**, so nothing needs rejecting; the LLM path is API-only.
- **Recording is per event** (normalized events, plus raw venue messages for audit), gzip-compressed
  and SHA-256 checksummed per segment. Durability is an fsync on every tick and before every fill. A
  partial segment left by a crash is recovered on restart.
- **Coinbase fees:** the official fee page returned HTTP 403. The configured taker rate (0.90%) comes
  from third-party reports of the 2026-09-16 schedule and is marked `verified: false`.
- **Phase 8 (live bridge) is not implemented**, by design. See [`docs/LIVE_ACTIVATION.md`](../LIVE_ACTIVATION.md).
