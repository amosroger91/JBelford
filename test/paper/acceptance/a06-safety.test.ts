import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePaperConfig } from '../../../src/paper/config';
import { PaperOnlyError, type MarketEvent } from '../../../src/paper/domain';
import {
  checkRequest,
  checkSubscribeMessage,
  checkWebSocket,
  guardedGet,
  networkLog,
  NetworkPolicyError,
} from '../../../src/paper/market/netguard';
import { CoinbaseLiveSource } from '../../../src/paper/market/coinbase';
import { Recorder } from '../../../src/paper/market/recorder';
import { TradingStore } from '../../../src/paper/store';
import { TradingService } from '../../../src/paper/service';
import { startWeb } from '../../../src/paper/web/server';
import { PRODUCT, ScriptedStrategy, T0, started, testConfig } from '../harness';

describe('15. paper mode refuses live configs and private exchange operations, even with credentials present', () => {
  const saved = { ...process.env };
  beforeAll(() => {
    process.env.COINBASE_API_KEY = 'organizations/x/apiKeys/fake';
    process.env.COINBASE_API_SECRET = '-----BEGIN EC PRIVATE KEY-----fake';
    process.env.JB_API_KEY = 'fake';
  });
  afterAll(() => {
    process.env = saved;
  });

  it('rejects every live configuration', () => {
    const base = JSON.parse(JSON.stringify(testConfig()));
    for (const mode of ['live', 'LIVE', 'shadow', undefined]) expect(() => parsePaperConfig({ ...base, mode })).toThrow(PaperOnlyError);
    for (const k of ['live', 'apiKey', 'apiSecret', 'credentials', 'broker'])
      expect(() => parsePaperConfig({ ...base, [k]: true })).toThrow(PaperOnlyError);
  });

  it('blocks private, mutating and unlisted endpoints by method + host + path', () => {
    const blocked: [string, string][] = [
      ['POST', 'https://api.coinbase.com/api/v3/brokerage/orders'],
      ['POST', 'https://api.coinbase.com/api/v3/brokerage/orders/batch_cancel'],
      ['GET', 'https://api.coinbase.com/api/v3/brokerage/accounts'],
      ['GET', 'https://api.coinbase.com/api/v3/brokerage/transaction_summary'],
      ['GET', 'https://api.coinbase.com/api/v3/brokerage/products/BTC-USD'], // private product route (non-/market)
      ['DELETE', 'https://api.coinbase.com/api/v3/brokerage/market/products/BTC-USD'],
      ['GET', 'https://api.exchange.coinbase.com/orders'],
      ['GET', 'http://api.coinbase.com/api/v3/brokerage/market/products/BTC-USD'],
    ];
    for (const [m, u] of blocked) expect(() => checkRequest(m, u)).toThrow(NetworkPolicyError);
    expect(() => checkRequest('GET', 'https://api.coinbase.com/api/v3/brokerage/market/products/BTC-USD')).not.toThrow();
    expect(() => checkWebSocket('wss://advanced-trade-ws-user.coinbase.com')).toThrow(NetworkPolicyError);
    expect(() => checkSubscribeMessage({ type: 'subscribe', channel: 'level2', jwt: 'x' })).toThrow(NetworkPolicyError);
    expect(() => checkSubscribeMessage({ type: 'subscribe', channel: 'user' })).toThrow(NetworkPolicyError);
  });

  it('never attaches credentials to public requests', async () => {
    let seen: Record<string, string> = {};
    const fake = async (_url: string, init?: { headers?: Record<string, string> }) => {
      seen = init?.headers ?? {};
      return new Response('{}', { status: 200 });
    };
    await guardedGet('https://api.coinbase.com/api/v3/brokerage/market/products/BTC-USD', { fetchImpl: fake });
    expect(Object.keys(seen).map((k) => k.toLowerCase())).not.toEqual(expect.arrayContaining(['authorization']));
    expect(JSON.stringify(seen)).not.toMatch(/fake|organizations|PRIVATE/);
    expect(networkLog.every((n) => !n.authenticated)).toBe(true);
  });
});

describe('20. saturation, recorder failure and disk problems pause new orders and leave visible gaps', () => {
  it('a recorder failure pauses the session, records a gap and keeps the ledger consistent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jb-recfail-'));
    const cfg = testConfig({}, dir);
    const strat = new ScriptedStrategy();
    const h = started({ cfg, strategy: strat, record: true });
    h.snapshot([['79999', '5']], [['80000', '5']]);
    // Simulate disk exhaustion / recorder failure.
    (h.recorder as Recorder).failed = 'ENOSPC: no space left on device (simulated)';
    strat.target = 0.2;
    h.completeBar();
    expect(h.rt.snapshotStatus().status).toBe('paused');
    expect(h.store.all('SELECT * FROM orders')).toHaveLength(0);
    expect(h.store.get("SELECT reason FROM observation_gaps WHERE reason LIKE 'recording failed%'")).toBeTruthy();
    expect(h.rt.ledger.verify(h.sessionId)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('queue saturation in the live source disconnects and is treated as an observation gap', async () => {
    const sent: string[] = [];
    let onmessage: ((m: { data: string }) => void) | null = null;
    const fakeWs = {
      send: (s: string) => sent.push(s),
      close: () => {},
      set onmessage(f: (m: { data: string }) => void) {
        onmessage = f;
      },
      set onopen(f: () => void) {
        setTimeout(f, 0);
      },
      set onclose(_f: () => void) {},
      set onerror(_f: () => void) {},
    };
    const src = new CoinbaseLiveSource({
      tickMs: 10_000,
      reconnectMinMs: 60_000,
      reconnectMaxMs: 60_000,
      maxQueue: 5,
      wsFactory: () => fakeWs as unknown as WebSocket,
    });
    const ac = new AbortController();
    const it = src.stream(ac.signal)[Symbol.asyncIterator]();
    await it.next(); // connection open
    await new Promise((r) => setTimeout(r, 5));
    expect(sent.length).toBe(3);
    for (let i = 0; i < 20; i++)
      onmessage!({
        data: JSON.stringify({
          channel: 'heartbeats',
          sequence_num: i,
          timestamp: '2026-10-31T00:00:00Z',
          events: [{ heartbeat_counter: i }],
        }),
      });
    const kinds: string[] = [];
    for (let i = 0; i < 6; i++)
      kinds.push(((await it.next()).value as MarketEvent).kind + ':' + (((await Promise.resolve()) as unknown) ?? ''));
    ac.abort();
    const all = kinds.join(',');
    expect(all).toMatch(/connection/); // overflow marker emitted
    const h = started();
    h.snapshot([['1', '1']], [['2', '1']]);
    h.ev({ kind: 'connection', epoch: 1, state: 'error', detail: 'queue_overflow' } as MarketEvent);
    expect(h.rt.snapshotStatus().feed).toBe('disconnected');
    expect(h.store.get("SELECT reason FROM observation_gaps WHERE reason LIKE '%queue_overflow%'")).toBeTruthy();
  });
});

describe('16 (server side). dashboard security', () => {
  it('rejects wrong host, missing token, cross-origin and tokenless POSTs; escapes nothing server-side it should not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jb-web-'));
    const db = join(dir, 't.db');
    const store = new TradingStore(db);
    new TradingService(store).createSession(testConfig({ purpose: '<script>alert(1)</script> purpose' }), PRODUCT, {
      kind: 'forward',
      now: T0,
      id: 'web-1',
    });
    store.close();
    const w = await startWeb({ dbPath: db, port: 0, quiet: true, allowStart: false });
    const base = w.url.replace(/\/\?token=.*/, '');
    expect((await fetch(`${base}/api/sessions`)).status).toBe(401);
    const { request } = await import('node:http');
    const port = Number(new URL(base).port);
    const wrongHost = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: `/api/sessions?token=${w.token}`, headers: { host: 'evil.example:80' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(wrongHost).toBe(421); // DNS-rebinding style Host is refused
    const ok = await fetch(`${base}/api/sessions?token=${w.token}`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { sessions: { purpose: string }[] };
    expect(body.sessions[0]!.purpose).toBe('<script>alert(1)</script> purpose'); // JSON, rendered client-side with textContent
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/api/sessions/web-1/control?token=${w.token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ action: 'pause' }),
      });
    expect((await post({ origin: 'http://evil.example', 'x-paper-token': w.token })).status).toBe(403);
    expect((await post({ origin: base })).status).toBe(403);
    expect(
      (
        await fetch(`${base}/api/sessions/web-1/readiness?token=${w.token}`, {
          method: 'POST',
          headers: { origin: base, 'x-paper-token': w.token },
        })
      ).status,
    ).toBe(404); // no way to set evidence
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
