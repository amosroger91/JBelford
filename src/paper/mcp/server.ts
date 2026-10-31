import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { STRATEGY_IDS, loadPaperConfig } from '../config';
import { TradingStore } from '../store';
import { PROJECT_ROOT, TradingService, resolveFromRoot } from '../service';
import { evaluateReadiness } from '../evaluation/readiness';

/**
 * Opt-in MCP toolset for paper trading (stdio, JSON-RPC 2.0). Bounded and
 * explicitly selected tools only: no generic exchange request, no shell, no
 * order RPC, no live activation. Register in .mcp.json to opt in.
 */
const ID = z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/);

const TOOLS = [
  {
    name: 'paper_start',
    description: 'Start a bounded PAPER trading session (simulated funds, real public data). Max 24h.',
    inputSchema: {
      type: 'object',
      properties: {
        strategy: { type: 'string', enum: STRATEGY_IDS.filter((s) => s !== 'llm') },
        durationMinutes: { type: 'integer', minimum: 1, maximum: 1440 },
      },
      required: ['strategy', 'durationMinutes'],
      additionalProperties: false,
    },
  },
  {
    name: 'paper_status',
    description: 'Compact status of one paper session, or a list of sessions.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, additionalProperties: false },
  },
  { name: 'paper_pause', description: 'Pause a paper session (cancels simulated open orders, keeps inventory).', inputSchema: idSchema() },
  { name: 'paper_resume', description: 'Resume a paused paper session (queues to the running runtime).', inputSchema: idSchema() },
  { name: 'paper_stop', description: 'Stop a paper session (cancels simulated open orders, keeps inventory).', inputSchema: idSchema() },
  {
    name: 'paper_report',
    description: 'Readiness verdicts and key metrics for a paper session (paginated findings).',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' }, page: { type: 'integer', minimum: 0 } },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
];

function idSchema() {
  return { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'], additionalProperties: false };
}

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { svc: TradingService; store: TradingStore; configPath?: string },
): Promise<unknown> {
  const { svc, store } = ctx;
  switch (name) {
    case 'paper_start': {
      const a = z
        .object({ strategy: z.enum(STRATEGY_IDS).exclude(['llm']), durationMinutes: z.number().int().min(1).max(1440) })
        .strict()
        .parse(args);
      const argv = [
        '--disable-warning=ExperimentalWarning',
        '--import',
        'tsx',
        join(PROJECT_ROOT, 'src', 'cli', 'main.ts'),
        'paper',
        'start',
        '--strategy',
        a.strategy,
        '--duration',
        `${a.durationMinutes}m`,
      ];
      if (ctx.configPath) argv.push('--config', ctx.configPath);
      const child = spawn(process.execPath, argv, { cwd: PROJECT_ROOT, detached: true, stdio: 'ignore' });
      child.unref();
      return {
        started: true,
        pid: child.pid,
        mode: 'paper',
        note: `bounded ${a.durationMinutes}-minute paper session starting; use paper_status to find it`,
      };
    }
    case 'paper_status': {
      const a = z.object({ sessionId: ID.optional() }).strict().parse(args);
      const list = a.sessionId ? [svc.session(a.sessionId)].filter(Boolean) : svc.sessions().slice(0, 20);
      return list.map((s) => ({ ...s, runtimeActive: svc.runtimeActive(s!.id), balances: svc.ledger.view(s!.id) }));
    }
    case 'paper_pause':
    case 'paper_resume':
    case 'paper_stop': {
      const a = z.object({ sessionId: ID }).strict().parse(args);
      return svc.control(a.sessionId, name.slice('paper_'.length) as 'pause' | 'resume' | 'stop');
    }
    case 'paper_report': {
      const a = z
        .object({ sessionId: ID, page: z.number().int().min(0).default(0) })
        .strict()
        .parse(args);
      const r = evaluateReadiness(store, a.sessionId, svc.sessionConfig(a.sessionId).cfg);
      const per = 10;
      return {
        label: 'PAPER — SIMULATED FUNDS',
        operationalCorrectness: r.operationalCorrectness,
        strategyEvidence: r.strategyEvidence,
        netTradingPnl: r.metrics.netTradingPnl,
        fees: r.metrics.fees,
        roundTrips: r.metrics.roundTrips.count,
        gates: r.gates.slice(a.page * per, (a.page + 1) * per),
        findings: r.findings,
        nextPage: (a.page + 1) * per < r.gates.length ? a.page + 1 : null,
      };
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

export async function startMcp(o: { configPath?: string }): Promise<void> {
  const cfg = loadPaperConfig(o.configPath ? resolve(o.configPath) : resolveFromRoot('config/trading.paper.yaml'));
  const store = new TradingStore(resolveFromRoot(cfg.storage.db));
  const svc = new TradingService(store);
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let req: { id?: number | string; method?: string; params?: Record<string, unknown> };
    try {
      req = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      continue;
    }
    if (req.id === undefined) continue; // notification
    try {
      let result: unknown;
      if (req.method === 'initialize') {
        result = {
          protocolVersion: (req.params?.protocolVersion as string) ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'jbelford-paper', version: '1.0.0' },
        };
      } else if (req.method === 'tools/list') {
        result = { tools: TOOLS };
      } else if (req.method === 'tools/call') {
        const p = req.params as { name: string; arguments?: Record<string, unknown> };
        try {
          const out = await handleTool(p.name, p.arguments ?? {}, { svc, store, configPath: o.configPath });
          result = { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
        } catch (e) {
          result = { content: [{ type: 'text', text: `error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      } else if (req.method === 'ping') {
        result = {};
      } else {
        send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `method not found: ${req.method}` } });
        continue;
      }
      send({ jsonrpc: '2.0', id: req.id, result });
    } catch (e) {
      send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
    }
  }
  store.close();
}
