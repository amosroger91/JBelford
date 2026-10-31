# Windows PowerShell setup

Tested on Windows 11, PowerShell 5.1 / 7, Node.js 24.

## 1. Prerequisites

```powershell
winget install OpenJS.NodeJS.LTS      # Node >= 22.13 (24 recommended). Restart PowerShell afterwards.
winget install Git.Git
node -v                               # v22.13+ required (uses built-in node:sqlite, no C++ build tools)
```

## 2. Get the code and install

```powershell
cd $HOME\dev
git clone https://github.com/amosroger91/JBelford.git
cd JBelford
npm install
```

If PowerShell blocks `npm` scripts with an execution-policy error:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

## 3. Verify

```powershell
npm run typecheck
npm test
npm run validate:exchange
```

## 4. Research and backtesting (no credentials needed)

```powershell
npm run history:fetch -- --days 45     # downloads 1m BTC/USD candles into data\history.db
npm run backtest                       # current config\strategy.json
npm run optimize                       # grid search + out-of-sample + walk-forward
```

Reports are written to `reports\`.

## 5. Paper trading (no credentials needed)

Window 1:

```powershell
npm run paper                          # until Ctrl+C
npm run paper -- --duration 2h         # fixed duration
```

Window 2:

```powershell
npm run dashboard
```

Paper state lives in `state\paper.db`. To start completely fresh, stop the runner and delete `state\paper.db*`.

Ctrl+C in the runner shuts down safely: it cancels open orders and flattens any position (add
`--keep-position` to skip flattening). A second Ctrl+C exits immediately without cleanup.

## 6. Emergency stop

From any PowerShell window in the project folder:

```powershell
npm run kill
npm run kill -- --reason "describe why"
```

Or create the file `state\KILL` by any means. Running engines cancel orders, flatten and stop within
about a second; nothing restarts until a human runs:

```powershell
npm run halt:status
npm run halt:reset        # interactive; type RESET HALTS
```

## 7. Keep it running (optional)

Run paper trading unattended with Task Scheduler:

```powershell
$action  = New-ScheduledTaskAction -Execute "npm.cmd" -Argument "run paper" -WorkingDirectory "$HOME\dev\JBelford"
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "JBelford-paper" -Action $action -Trigger $trigger
```

Remove it with `Unregister-ScheduledTask -TaskName JBelford-paper`. Disable sleep on the PC
(`powercfg /change standby-timeout-ac 0`) or the engine will see stale data and halt.

## 8. Claude + CCXT MCP

`.mcp.json` registers a keyless CCXT MCP server for Claude Code. Opening the project in Claude Code
prompts to enable it. See `docs/CLAUDE_SUPERVISOR.md`.

## Costs

Everything runs locally: SQLite file database, public market data, no paid services. Infrastructure
cost is the electricity of the PC you run it on.
