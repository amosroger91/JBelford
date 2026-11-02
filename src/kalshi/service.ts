import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { guardedGet, type FetchLike } from '../paper/market/netguard';
import { resolveFromRoot } from '../paper/service';
import type { KalshiConfig } from './config';
import { KalshiPaperEngine, UNIT, type KalshiEvent, type MarketInfo, type TradeRec } from './engine';

const API = 'https://api.elections.kalshi.com/trade-api/v2';
const units = (s: string | number | undefined) => Math.round(Number(s ?? 0) * UNIT);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function sessionDir(cfg: KalshiConfig, id: string): string {
  return join(resolveFromRoot(cfg.recordingDir), id);
}

/** Read a recording back as events (one JSON event per line). */
export function readEvents(dir: string): KalshiEvent[] {
  const p = join(dir, 'events.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as KalshiEvent);
}

export function replayKalshi(cfg: KalshiConfig, dir: string): KalshiPaperEngine {
  const engine = new KalshiPaperEngine(cfg);
  for (const e of readEvents(dir)) engine.ingest(e);
  return engine;
}

export interface LiveOptions {
  cfg: KalshiConfig;
  durationMs: number;
  fetchImpl?: FetchLike;
  now?: () => number;
  onProgress?: (e: KalshiPaperEngine, note: string) => void;
  progressEveryMs?: number;
  signal?: AbortSignal;
  sessionId?: string;
}

/**
 * Live paper run on Kalshi PUBLIC market data. Polls markets, order books, trades and
 * results through the paper network guard (GET only, no credentials), records every
 * observation before the engine sees it, and stops posting after `durationMs`. Open
 * positions are then followed until they settle (at most `settleWaitMs`).
 */
export async function runKalshiLive(o: LiveOptions): Promise<{ sessionId: string; dir: string; engine: KalshiPaperEngine }> {
  const { cfg } = o;
  const now = o.now ?? Date.now;
  const id = o.sessionId ?? `ks-${new Date(now()).toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 8)}`;
  const dir = sessionDir(cfg, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
  const engine = new KalshiPaperEngine(cfg);
  const emit = (e: KalshiEvent) => {
    appendFileSync(join(dir, 'events.jsonl'), JSON.stringify(e) + '\n');
    engine.ingest(e);
  };
  const get = (path: string) => guardedGet(API + path, { fetchImpl: o.fetchImpl });
  const started = now();
  writeFileSync(
    join(dir, 'session.json'),
    JSON.stringify({ id, startedAt: started, durationMs: o.durationMs, status: 'running' }, null, 2),
  );

  const fees = new Map<string, { feeType: string; feeMultiplier: number }>();
  for (const s of cfg.series) {
    try {
      const r = (await get(`/series/${s}`)) as { series?: { fee_type?: string; fee_multiplier?: number } };
      fees.set(s, { feeType: r.series?.fee_type ?? 'unknown', feeMultiplier: r.series?.fee_multiplier ?? 1 });
    } catch {
      fees.set(s, { feeType: 'unknown_maker_fees', feeMultiplier: 1 }); // unknown fees are charged, never assumed zero
    }
  }

  let markets: MarketInfo[] = [];
  let lastMarkets = 0;
  let lastProgress = started;
  const seenTrades = new Map<string, Set<string>>();
  const lastTradeTs = new Map<string, number>();
  const stopAt = started + o.durationMs;
  let stopped = false;

  while (!o.signal?.aborted) {
    const t0 = now();
    if (!stopped && t0 >= stopAt) {
      emit({ kind: 'stop', t: t0, reason: `bounded run of ${o.durationMs}ms` });
      stopped = true;
    }
    if (stopped && (engine.positions.size === 0 || t0 - stopAt > cfg.settleWaitMs)) break;
    try {
      if (!stopped && t0 - lastMarkets >= cfg.marketsRefreshMs) {
        const found: MarketInfo[] = [];
        for (const s of cfg.series) {
          const r = (await get(`/markets?series_ticker=${s}&status=open&limit=50`)) as { markets?: Record<string, unknown>[] };
          for (const m of r.markets ?? []) {
            found.push({
              ticker: String(m.ticker),
              series: s,
              closeTime: Date.parse(String(m.close_time)),
              status: String(m.status),
              ...fees.get(s)!,
            });
          }
        }
        markets = found;
        lastMarkets = t0;
        emit({ kind: 'markets', t: now(), markets: found });
      }
      if (!stopped) {
        for (const m of markets) {
          if (now() >= m.closeTime) continue;
          const b = (await get(`/markets/${m.ticker}/orderbook?depth=10`)) as {
            orderbook_fp?: { yes_dollars?: [string, string][]; no_dollars?: [string, string][] };
          };
          const lv = (x?: [string, string][]) => (x ?? []).map(([p, s]) => [units(p), Number(s)] as [number, number]);
          emit({ kind: 'book', t: now(), ticker: m.ticker, yes: lv(b.orderbook_fp?.yes_dollars), no: lv(b.orderbook_fp?.no_dollars) });
          const since = lastTradeTs.get(m.ticker) ?? t0 - 5_000;
          const tr = (await get(`/markets/trades?ticker=${m.ticker}&limit=1000&min_ts=${Math.floor(since / 1000) - 2}`)) as {
            trades?: Record<string, unknown>[];
          };
          const seen = seenTrades.get(m.ticker) ?? new Set<string>();
          seenTrades.set(m.ticker, seen);
          const fresh: TradeRec[] = [];
          for (const x of tr.trades ?? []) {
            const tid = String(x.trade_id);
            if (seen.has(tid)) continue;
            seen.add(tid);
            const ts = Date.parse(String(x.created_time));
            fresh.push({
              id: tid,
              yesPx: units(x.yes_price_dollars as string),
              count: Number(x.count_fp),
              takerSide: x.taker_side === 'no' ? 'no' : 'yes',
              ts,
            });
            lastTradeTs.set(m.ticker, Math.max(lastTradeTs.get(m.ticker) ?? 0, ts));
          }
          if (fresh.length) emit({ kind: 'trades', t: now(), ticker: m.ticker, trades: fresh });
        }
      }
      // settle positions in closed markets
      for (const ticker of [...engine.positions.keys()]) {
        const m = markets.find((x) => x.ticker === ticker);
        if (m && now() < m.closeTime) continue;
        const r = (await get(`/markets/${ticker}`)) as { market?: { result?: string; status?: string } };
        const res = r.market?.result;
        if (res === 'yes' || res === 'no') emit({ kind: 'result', t: now(), ticker, result: res });
        else if (res === 'void' || r.market?.status === 'voided') emit({ kind: 'result', t: now(), ticker, result: 'void' });
      }
    } catch (err) {
      o.onProgress?.(engine, `poll error (skipped this cycle): ${err instanceof Error ? err.message : String(err)}`);
    }
    if (now() - lastProgress >= (o.progressEveryMs ?? 60_000)) {
      lastProgress = now();
      o.onProgress?.(engine, stopped ? 'settling' : 'running');
    }
    const wait = cfg.pollMs - (now() - t0);
    if (wait > 0) await sleep(wait);
  }
  const s = engine.summary();
  writeFileSync(
    join(dir, 'session.json'),
    JSON.stringify(
      { id, startedAt: started, endedAt: now(), durationMs: o.durationMs, status: 'finished', hash: engine.hash(), summary: s },
      null,
      2,
    ),
  );
  return { sessionId: id, dir, engine };
}

export function listKalshiSessions(
  cfg: KalshiConfig,
): { id: string; status: string; summary?: ReturnType<KalshiPaperEngine['summary']> }[] {
  const root = resolveFromRoot(cfg.recordingDir);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => existsSync(join(root, d, 'session.json')))
    .map(
      (d) =>
        JSON.parse(readFileSync(join(root, d, 'session.json'), 'utf8')) as {
          id: string;
          status: string;
          summary?: ReturnType<KalshiPaperEngine['summary']>;
        },
    );
}

/** Replay the recording, compare with the live hash, and export JSON/CSV. */
export function reportKalshi(cfg: KalshiConfig, id: string, outDir?: string) {
  const dir = sessionDir(cfg, id);
  const session = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')) as { hash?: string; status: string };
  const recorded = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as KalshiConfig;
  const engine = replayKalshi(recorded, dir);
  const out = outDir ?? resolveFromRoot(`artifacts/kalshi/${id}`);
  mkdirSync(out, { recursive: true });
  const csv = (rows: Record<string, unknown>[]) =>
    rows.length ? [Object.keys(rows[0]!).join(','), ...rows.map((r) => Object.values(r).join(','))].join('\n') + '\n' : '';
  const usd = (u: number) => (u / UNIT).toFixed(4);
  writeFileSync(
    join(out, 'fills.csv'),
    csv(engine.fills.map((f) => ({ ...f, price: usd(f.price), fee: usd(f.fee), time: new Date(f.t).toISOString() }))),
  );
  writeFileSync(
    join(out, 'settlements.csv'),
    csv(
      engine.settlements.map((s) => ({ ...s, cost: usd(s.cost), fees: usd(s.fees), pnl: usd(s.pnl), time: new Date(s.t).toISOString() })),
    ),
  );
  writeFileSync(
    join(out, 'orders.csv'),
    csv(engine.orderEvents.map((x) => ({ ...x, price: usd(x.price), time: new Date(x.t).toISOString() }))),
  );
  const replay = {
    liveHash: session.hash ?? null,
    replayHash: engine.hash(),
    matched: session.hash ? session.hash === engine.hash() : null,
  };
  const report = {
    label: 'PAPER - SIMULATED FUNDS. Kalshi public data; no account; no orders sent.',
    sessionId: id,
    status: session.status,
    summary: engine.summary(),
    researchExpectation: 'K-01 candidate A: about +2.3c per contract (contract-weighted, Sep-Oct 2026 test half); not a forecast',
    replay,
  };
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
  return { report, out };
}
