# Claude as strategy supervisor

Claude **advises**. The deterministic engine **executes**. The risk engine **decides** what is allowed.

| Claude may                                                                            | Claude may not                                                              |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Research markets via the CCXT MCP server and `npm run context` (public data)          | Place, cancel or modify orders                                              |
| Read `npm run report` output, backtest and optimizer reports                          | Change risk limits (they are compiled constants)                            |
| Run backtests / optimizer / `npm run gate` / `proposal validate` / `proposal compare` | Apply proposals (`proposal apply` needs a human at an interactive terminal) |
| Write proposal files in `proposals/`                                                  | Activate live trading, create authorizations, or handle credentials         |
|                                                                                       | Reset halts or clear the kill switch (interactive only)                     |

## Proposal format

`proposals/<name>.json`:

```json
{
  "author": "claude",
  "createdAt": "2026-10-31T12:00:00Z",
  "rationale": "Why this change, with evidence from out-of-sample / walk-forward results.",
  "strategy": "volBreakout",
  "changes": { "squeezePercentile": 15, "allowedHoursUtc": [13, 14, 15, 16, 17, 18, 19, 20] },
  "activate": false,
  "evidence": { "report": "reports/gate-volBreakout-....json" }
}
```

Only that strategy's keys from `config/strategy.json` are accepted, within the bounds in
`src/config/schema.ts` (intraday only: max hold 12 hours). `activate: true` proposes making it the
active strategy. Any other key (e.g. `maxOrderValueUsd`, `leverage`, `mode`, gate criteria) makes the
proposal invalid. A strategy can't be authorized for live trading until `npm run gate` passes for
its exact config.

```powershell
npm run proposal -- validate proposals/my-idea.json
npm run proposal -- compare  proposals/my-idea.json
npm run proposal -- apply    proposals/my-idea.json    # human only
```

## CCXT MCP

`.mcp.json` runs `@mcpfun/mcp-server-ccxt@1.2.1` with **no credentials**. Use its public tools
(`get-ticker`, `get-orderbook`, `get-ohlcv`, `get-markets`, `get-exchange-info`) for research. Its
trading tools fail without keys, by design. Never give the MCP server trading credentials.
