import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { z } from 'zod';
import { STRATEGY_IDS } from '../config';
import { evaluateReadiness } from '../evaluation/readiness';
import { TradingStore } from '../store';
import { PROJECT_ROOT, TradingService } from '../service';

/**
 * Local "Paper trading" dashboard. Security: binds to 127.0.0.1 only, requires
 * a random per-process token (query param on first load, then an HttpOnly
 * SameSite=Strict cookie; POSTs also need the X-Paper-Token header), and
 * validates Host and Origin exactly. All external content is rendered with
 * textContent in the browser (never innerHTML).
 */
export interface WebOptions {
  dbPath: string;
  port: number;
  host?: string;
  token?: string;
  configPath?: string;
  /** Allow the browser "Start" control to spawn a bounded paper session (default true). */
  allowStart?: boolean;
  quiet?: boolean;
}

const STATIC = join(PROJECT_ROOT, 'src', 'paper', 'web', 'static');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export async function startWeb(o: WebOptions): Promise<{ url: string; token: string; close: () => Promise<void> }> {
  const host = o.host ?? '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('dashboard binds to loopback only');
  const token = o.token ?? randomBytes(24).toString('hex');
  const store = new TradingStore(o.dbPath);
  const svc = new TradingService(store);
  let port = o.port;
  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

  const tokenOk = (req: IncomingMessage, url: URL): boolean => {
    const cookie = /(?:^|;\s*)paper_token=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1];
    const given = url.searchParams.get('token') ?? cookie ?? '';
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
        if (data.length > 10_000) reject(new Error('body too large'));
      });
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (e) {
          reject(e);
        }
      });
    });

  const sessionView = (id: string) => {
    const s = svc.session(id);
    if (!s) return null;
    const live = store.get('SELECT json, updated_at FROM runtime_status WHERE session_id = ?', id);
    const v = store.get('SELECT * FROM valuations WHERE session_id = ? ORDER BY id DESC LIMIT 1', id);
    const feed = store.get('SELECT state, time, detail FROM feed_health WHERE session_id = ? ORDER BY id DESC LIMIT 1', id);
    const row = store.get(
      'SELECT purpose, initial_usd, initial_btc, venue, product, hwm_equity, day_start_equity FROM sessions WHERE id = ?',
      id,
    )!;
    const b = store.get('SELECT * FROM balances WHERE session_id = ?', id)!;
    return {
      ...s,
      purpose: row.purpose,
      venue: row.venue,
      product: row.product,
      initialUsd: row.initial_usd,
      initialBtc: row.initial_btc,
      runtimeActive: svc.runtimeActive(id),
      live: live ? { ...JSON.parse(live.json as string), updatedAt: live.updated_at } : null,
      valuation: v ?? null,
      feed: feed ?? null,
      balances: b,
      hwmEquity: row.hwm_equity,
      dayStartEquity: row.day_start_equity,
    };
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'invalid'}`);
      if (!allowedHosts().has(req.headers.host ?? '')) return json(res, 421, { error: 'host not allowed' });
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (!origin || !allowedHosts().has(origin.replace(/^http:\/\//, ''))) return json(res, 403, { error: 'origin not allowed' });
        if (req.headers['x-paper-token'] !== token) return json(res, 403, { error: 'missing or invalid token header' });
      }
      if (!tokenOk(req, url)) return json(res, 401, { error: 'token required: open the URL printed by `paper web`' });

      // Static assets
      if (req.method === 'GET' && (url.pathname === '/' || /^\/static\/[a-z]+\.(js|css)$/.test(url.pathname))) {
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice('/static/'.length);
        const ext = file.slice(file.lastIndexOf('.'));
        res.writeHead(200, {
          'content-type': TYPES[ext]!,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:",
          ...(url.searchParams.get('token') ? { 'set-cookie': `paper_token=${token}; HttpOnly; SameSite=Strict; Path=/` } : {}),
        });
        return res.end(readFileSync(join(STATIC, file)));
      }

      const m = /^\/api\/sessions\/([A-Za-z0-9._:-]{1,80})(?:\/([a-z_]+))?$/.exec(url.pathname);
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        return json(res, 200, {
          token,
          sessions: svc.sessions().map((s) => sessionView(s.id)),
          strategies: STRATEGY_IDS,
          allowStart: o.allowStart !== false,
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/sessions') {
        if (o.allowStart === false) return json(res, 403, { error: 'starting sessions from the browser is disabled' });
        const body = z
          .object({ strategy: z.enum(STRATEGY_IDS).exclude(['llm']), durationMinutes: z.number().int().min(1).max(1440) })
          .strict()
          .parse(await readBody(req));
        const args = [
          '--disable-warning=ExperimentalWarning',
          '--import',
          'tsx',
          join(PROJECT_ROOT, 'src', 'cli', 'main.ts'),
          'paper',
          'start',
          '--strategy',
          body.strategy,
          '--duration',
          `${body.durationMinutes}m`,
        ];
        if (o.configPath) args.push('--config', o.configPath);
        const child = spawn(process.execPath, args, { cwd: PROJECT_ROOT, detached: true, stdio: 'ignore' });
        child.unref();
        return json(res, 202, { started: true, pid: child.pid, note: `bounded paper session (${body.durationMinutes} min) starting` });
      }
      if (m) {
        const id = m[1]!;
        const sub = m[2];
        if (!svc.session(id)) return json(res, 404, { error: 'unknown session' });
        if (req.method === 'GET' && !sub) return json(res, 200, sessionView(id));
        if (req.method === 'GET' && sub === 'orders')
          return json(res, 200, store.all('SELECT * FROM orders WHERE session_id = ? ORDER BY submitted_at DESC LIMIT 200', id));
        if (req.method === 'GET' && sub === 'fills')
          return json(res, 200, store.all('SELECT * FROM fills WHERE session_id = ? ORDER BY event_ordinal DESC LIMIT 500', id));
        if (req.method === 'GET' && sub === 'valuations') {
          return json(
            res,
            200,
            store
              .all(
                'SELECT time, equity_mid, equity_bid, mark_mid, stale FROM valuations WHERE session_id = ? ORDER BY id DESC LIMIT 2000',
                id,
              )
              .reverse(),
          );
        }
        if (req.method === 'GET' && sub === 'decisions') {
          const ds = store.all('SELECT * FROM decisions WHERE session_id = ? ORDER BY event_ordinal DESC LIMIT 50', id);
          return json(
            res,
            200,
            ds.map((d) => ({
              ...d,
              checks: store.all(
                'SELECT check_name, passed, detail FROM risk_events WHERE session_id = ? AND decision_id = ? ORDER BY id',
                id,
                d.decision_id as string,
              ),
            })),
          );
        }
        if (req.method === 'GET' && sub === 'readiness') {
          const r = evaluateReadiness(store, id, svc.sessionConfig(id).cfg);
          return json(res, 200, {
            operationalCorrectness: r.operationalCorrectness,
            strategyEvidence: r.strategyEvidence,
            gates: r.gates,
            findings: r.findings,
            controls: r.controls,
            metrics: r.metrics,
          });
        }
        if (req.method === 'POST' && sub === 'control') {
          const body = z
            .object({ action: z.enum(['pause', 'resume', 'stop', 'flatten']) })
            .strict()
            .parse(await readBody(req));
          return json(res, 200, svc.control(id, body.action));
        }
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  await new Promise<void>((resolve) => server.listen(o.port, host, resolve));
  const addr = server.address();
  if (addr && typeof addr === 'object') port = addr.port;
  const url = `http://127.0.0.1:${port}/?token=${token}`;
  if (!o.quiet) console.log(`PAPER dashboard (loopback only): ${url}`);
  return {
    url,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          store.close();
          resolve();
        });
      }),
  };
}
