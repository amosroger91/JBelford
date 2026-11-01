import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { configHash, parsePaperConfig, strategyVersionHash, type PaperConfig } from './config';
import type { ControlAction, MarketEvent } from './domain';
import { CoinbaseLiveSource, fetchCandles, fetchProduct, productRestrictions, type ProductMeta } from './market/coinbase';
import { BinanceUsLiveSource, fetchBinanceUsCandles, fetchBinanceUsProduct } from './market/binanceus';
import { Recorder, readDataset } from './market/recorder';
import { dec } from './money';
import { PaperRuntime, type RuntimeStatus } from './runtime';
import { TradingStore } from './store';
import { DeterministicStrategy, type StrategyPort } from './strategies/types';
import { AnthropicLlmClient, LlmStrategy } from './strategies/llm';
import { Ledger } from './ledger';

/** Repository root: nearest ancestor with package.json (works from src/ and from the dist/ bundle). */
function findRoot(from: string): string {
  let d = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, 'package.json'))) return d;
    const up = resolve(d, '..');
    if (up === d) break;
    d = up;
  }
  return process.cwd();
}

export const PROJECT_ROOT = findRoot(import.meta.dirname);

export function resolveFromRoot(p: string): string {
  return resolve(PROJECT_ROOT, p);
}

function sourceCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function dependencyVersions(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  return { node: process.version, ...pkg.dependencies };
}

export function makeStrategy(cfg: PaperConfig): StrategyPort {
  if (cfg.strategy.id === 'llm') {
    const model = typeof cfg.strategy.params.model === 'string' ? cfg.strategy.params.model : 'claude-opus-5-5';
    return new LlmStrategy(new AnthropicLlmClient(), model, cfg.decision.timeoutMs, cfg.decision.intentTtlMs);
  }
  return new DeterministicStrategy(
    cfg.strategy.id,
    cfg.strategy.params as Record<string, number | string | boolean>,
    cfg.decision.intentTtlMs,
  );
}

export interface SessionSummary {
  id: string;
  status: string;
  parentId: string | null;
  strategy: string;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  lastEventTime: number | null;
  configHash: string;
  strategyVersion: string;
  datasetId: string | null;
}

export class TradingService {
  readonly ledger: Ledger;
  constructor(readonly store: TradingStore) {
    this.ledger = new Ledger(store);
  }

  createSession(
    cfg: PaperConfig,
    product: ProductMeta,
    o: { kind: 'forward' | 'replay'; parentId?: string | null; now?: number; id?: string; datasetId?: string | null },
  ): string {
    const id = o.id ?? `ps-${new Date(o.now ?? Date.now()).toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 8)}`;
    const now = o.now ?? Date.now();
    const sv = strategyVersionHash(cfg);
    this.store.tx(() => {
      this.store.run(
        `INSERT INTO sessions (id, parent_id, status, mode, venue, product, purpose, config_json, config_hash, strategy_version, initial_usd, initial_btc,
          product_meta_json, source_commit, deps_json, dataset_id, created_at) VALUES (?, ?, 'created', 'paper', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        o.parentId ?? null,
        cfg.venue,
        cfg.product,
        cfg.purpose,
        JSON.stringify(cfg),
        configHash(cfg),
        sv,
        cfg.initialBalances.usd,
        cfg.initialBalances.btc,
        JSON.stringify(product),
        sourceCommit(),
        JSON.stringify(dependencyVersions()),
        o.datasetId === undefined ? id : o.datasetId,
        now,
      );
      this.store.run(
        'INSERT OR IGNORE INTO strategy_versions (hash, strategy_id, config_json, created_at) VALUES (?, ?, ?, ?)',
        sv,
        cfg.strategy.id,
        JSON.stringify({ strategy: cfg.strategy, fees: cfg.fees, risk: cfg.risk, execution: cfg.execution, decision: cfg.decision }),
        now,
      );
      this.store.run(
        "INSERT INTO experiments (id, kind, strategy_version, session_id, config_hash, status, created_at) VALUES (?, ?, ?, ?, ?, 'running', ?)",
        `exp-${id}`,
        o.kind,
        sv,
        id,
        configHash(cfg),
        now,
      );
      this.ledger.open(id, dec(cfg.initialBalances.usd), dec(cfg.initialBalances.btc), now);
    });
    return id;
  }

  session(id: string): SessionSummary | undefined {
    const r = this.store.get('SELECT * FROM sessions WHERE id = ?', id);
    if (!r) return undefined;
    return {
      id,
      status: r.status as string,
      parentId: (r.parent_id as string | null) ?? null,
      strategy: (JSON.parse(r.config_json as string) as PaperConfig).strategy.id,
      createdAt: r.created_at as number,
      startedAt: (r.started_at as number | null) ?? null,
      endedAt: (r.ended_at as number | null) ?? null,
      lastEventTime: (r.last_event_time as number | null) ?? null,
      configHash: r.config_hash as string,
      strategyVersion: r.strategy_version as string,
      datasetId: (r.dataset_id as string | null) ?? null,
    };
  }

  sessions(): SessionSummary[] {
    return this.store.all('SELECT id FROM sessions ORDER BY created_at DESC').map((r) => this.session(r.id as string)!);
  }

  sessionConfig(id: string): { cfg: PaperConfig; product: ProductMeta } {
    const r = this.store.get('SELECT config_json, product_meta_json FROM sessions WHERE id = ?', id);
    if (!r) throw new Error(`unknown session ${id}`);
    return {
      cfg: parsePaperConfig(JSON.parse(r.config_json as string)),
      product: JSON.parse(r.product_meta_json as string) as ProductMeta,
    };
  }

  runtimeActive(id: string, now = Date.now()): boolean {
    const l = this.store.leaseInfo(`paper:${id}`);
    return !!l && now - l.heartbeatAt < 15_000;
  }

  /**
   * Queue a control for the owning runtime, or apply it directly when no
   * runtime is attached. Offline flatten is refused: it needs live data.
   */
  control(id: string, action: ControlAction, now = Date.now()): { mode: 'queued' | 'applied' | 'refused'; detail: string } {
    const s = this.session(id);
    if (!s) throw new Error(`unknown session ${id}`);
    const requestId = `c-${now}-${randomUUID().slice(0, 6)}`;
    if (this.runtimeActive(id, now)) {
      this.store.run(
        "INSERT INTO controls (request_id, session_id, action, requested_at, status) VALUES (?, ?, ?, ?, 'pending')",
        requestId,
        id,
        action,
        now,
      );
      return { mode: 'queued', detail: `queued ${action} for the running runtime (${requestId})` };
    }
    if (action === 'flatten')
      return { mode: 'refused', detail: 'flatten needs a running session with healthy live data; start or resume it first' };
    if (action === 'resume') return { mode: 'refused', detail: 'no runtime attached: use `paper resume SESSION_ID` to restart it' };
    if (['stopped', 'failed', 'completed'].includes(s.status)) return { mode: 'refused', detail: `session is ${s.status}` };
    // Apply through the runtime so the control is a RECORDED event and replay stays exact.
    const { cfg, product } = this.sessionConfig(id);
    const owner = `offline-${process.pid}-${randomUUID().slice(0, 6)}`;
    if (!this.store.acquireLease(`paper:${id}`, owner, now)) return { mode: 'refused', detail: 'another runtime owns this session' };
    const recorder = new Recorder(resolveFromRoot(cfg.recording.dir), s.datasetId ?? id, id, cfg.recording.segmentSeconds * 1000);
    try {
      this.store.run(
        "INSERT INTO controls (request_id, session_id, action, requested_at, status) VALUES (?, ?, ?, ?, 'queued')",
        requestId,
        id,
        action,
        now,
      );
      const rt = new PaperRuntime(this.store, cfg, id, product, { mode: 'forward', strategy: null, recorder });
      rt.ingest({ kind: 'control', ordinal: 0, receiptTime: now, action, requestId });
      rt.finish();
    } finally {
      recorder.close();
      this.store.releaseLease(`paper:${id}`, owner);
    }
    return { mode: 'applied', detail: `session ${this.session(id)!.status} (recorded control ${requestId})` };
  }
}

// ---------- forward (live public data) ----------

export interface ForwardOptions {
  cfg: PaperConfig;
  resumeSessionId?: string;
  /** Bounded run: the process exits after this long; the session stays resumable. */
  durationMs?: number;
  /** Operational drills on the real feed, as offsets from start (ms). */
  drills?: { atMs: number; kind: 'disconnect' | 'duplicate'; arg: number }[];
  onProgress?: (s: RuntimeStatus) => void;
  progressEveryMs?: number;
  signal?: AbortSignal;
}

export async function runForward(o: ForwardOptions): Promise<{ sessionId: string; status: RuntimeStatus; datasetDir: string }> {
  const store = new TradingStore(resolveFromRoot(o.cfg.storage.db));
  const svc = new TradingService(store);
  let cfg = o.cfg;
  let product: ProductMeta;
  let sessionId: string;
  const resumed = !!o.resumeSessionId;
  if (o.resumeSessionId) {
    sessionId = o.resumeSessionId;
    const s = svc.session(sessionId);
    if (!s) throw new Error(`unknown session ${sessionId}`);
    if (['stopped', 'failed', 'completed'].includes(s.status))
      throw new Error(`session ${sessionId} is ${s.status}; start a new session instead`);
    ({ cfg, product } = svc.sessionConfig(sessionId)); // frozen identity: never re-read config for a running experiment
    const problems = svc.ledger.verify(sessionId);
    if (problems.length) throw new Error(`ledger invariants failed; refusing to resume: ${problems.join('; ')}`);
  } else {
    product = cfg.venue === 'binanceus' ? await fetchBinanceUsProduct() : await fetchProduct();
    const r = productRestrictions(product);
    if (r.length) throw new Error(`BTC-USD not usable for simulated market orders: ${r.join(', ')}`);
    sessionId = svc.createSession(cfg, product, { kind: 'forward' });
  }
  const owner = `${process.pid}-${randomUUID().slice(0, 8)}`;
  if (!store.acquireLease(`paper:${sessionId}`, owner, Date.now()))
    throw new Error(`session ${sessionId} is owned by another running runtime`);

  const recorder = new Recorder(resolveFromRoot(cfg.recording.dir), sessionId, sessionId, cfg.recording.segmentSeconds * 1000);
  const strategy = makeStrategy(cfg);
  const runtime = new PaperRuntime(store, cfg, sessionId, product, {
    mode: 'forward',
    strategy,
    recorder,
    pollControls: true,
    leaseOwner: owner,
  });
  const sourceOpts = { tickMs: cfg.feed.tickMs, reconnectMinMs: cfg.feed.reconnectMinMs, reconnectMaxMs: cfg.feed.reconnectMaxMs };
  // Binance.US BTC/USD prints a trade roughly every 13s; book diffs (100ms) carry liveness, so allow a longer silence.
  const source =
    cfg.venue === 'binanceus' ? new BinanceUsLiveSource({ ...sourceOpts, silenceMs: 60_000 }) : new CoinbaseLiveSource(sourceOpts);
  source.onRaw = (raw, t, epoch) => recorder.appendRaw(raw, t, epoch);

  const ctrl = new AbortController();
  o.signal?.addEventListener(
    'abort',
    () => runtime.enqueue({ kind: 'lifecycle', ordinal: 0, receiptTime: Date.now(), state: 'stopping', detail: 'signal' }),
    { once: true },
  );
  const timers: NodeJS.Timeout[] = [];
  const started = Date.now();
  if (o.durationMs !== undefined) {
    timers.push(
      setTimeout(
        () =>
          runtime.enqueue({
            kind: 'lifecycle',
            ordinal: 0,
            receiptTime: Date.now(),
            state: 'stopping',
            detail: `bounded run of ${o.durationMs}ms`,
          }),
        o.durationMs,
      ),
    );
  }
  for (const d of o.drills ?? []) {
    timers.push(setTimeout(() => (d.kind === 'disconnect' ? source.drillDisconnect(d.arg) : source.drillDuplicate(d.arg)), d.atMs));
  }

  // First recorded events: lifecycle, then warmup candles (REST, completed buckets only).
  runtime.ingest({
    kind: 'lifecycle',
    ordinal: 0,
    receiptTime: Date.now(),
    state: resumed ? 'restarted' : 'started',
    detail: `owner ${owner}`,
  });
  try {
    const warm = Math.max(strategy.warmupBars + 20, 60) * 300;
    const nowSec = Math.floor(Date.now() / 1000);
    const candles =
      cfg.venue === 'binanceus'
        ? await fetchBinanceUsCandles((nowSec - warm) * 1000, nowSec * 1000)
        : await fetchCandles(nowSec - warm, nowSec, 300);
    runtime.ingest({ kind: 'warmup_candles', ordinal: 0, receiptTime: Date.now(), granularitySec: 300, candles });
  } catch (e) {
    store.audit(sessionId, Date.now(), 0, 'warmup_failed', { error: String(e) });
  }

  let lastProgress = 0;
  try {
    await runtime.run(source.stream(ctrl.signal), ctrl.signal, (e) => {
      runtime.duplicatesDropped = source.duplicatesDropped;
      if (o.onProgress && e.kind === 'tick' && e.receiptTime - lastProgress >= (o.progressEveryMs ?? 30_000)) {
        lastProgress = e.receiptTime;
        o.onProgress(runtime.snapshotStatus());
      }
    });
  } finally {
    ctrl.abort();
    for (const t of timers) clearTimeout(t);
    runtime.finish();
    recorder.close();
    store.releaseLease(`paper:${sessionId}`, owner);
    store.audit(sessionId, Date.now(), runtime.snapshotStatus().ordinal, 'runtime_exit', { ranMs: Date.now() - started });
  }
  const status = runtime.snapshotStatus();
  store.close();
  return { sessionId, status, datasetDir: recorder.dir };
}

// ---------- recorded-market replay ----------

export interface ReplayResult {
  replaySessionId: string;
  sourceSessionId: string;
  dbPath: string;
  events: number;
}

/**
 * Replay a recorded dataset through the same runtime with the source session's
 * frozen config, product metadata and recorded decisions, into its own
 * experiment database (never the live session's lease or ledger).
 */
export function runReplay(o: {
  sourceDbPath: string;
  sourceSessionId: string;
  datasetDir: string;
  replayDbPath: string;
  replayId?: string;
  /**
   * Counterfactual stress scenario: same recorded events and decisions, different
   * execution assumptions (e.g. thinner liquidity). NOT a reproduction; results
   * are reported separately and never compared with the original hash.
   */
  executionOverride?: Partial<PaperConfig['execution']>;
}): ReplayResult {
  const src = new TradingStore(o.sourceDbPath);
  const frozen = new TradingService(src).sessionConfig(o.sourceSessionId);
  const product = frozen.product;
  const cfg = o.executionOverride
    ? parsePaperConfig({
        ...frozen.cfg,
        purpose: `STRESS (counterfactual) of ${o.sourceSessionId}`,
        execution: { ...frozen.cfg.execution, ...o.executionOverride },
      })
    : frozen.cfg;
  const created = src.get('SELECT created_at FROM sessions WHERE id = ?', o.sourceSessionId)!.created_at as number;
  src.close();
  const store = new TradingStore(o.replayDbPath);
  const svc = new TradingService(store);
  const id = svc.createSession(cfg, product, {
    kind: 'replay',
    parentId: o.sourceSessionId,
    id: o.replayId,
    now: created,
    datasetId: null,
  });
  const rt = new PaperRuntime(store, cfg, id, product, { mode: 'replay', strategy: null, recorder: null });
  let n = 0;
  for (const e of readDataset(o.datasetDir) as Iterable<MarketEvent>) {
    rt.ingest(e);
    n++;
  }
  rt.finish();
  store.run("UPDATE experiments SET status = 'completed' WHERE session_id = ?", id);
  store.close();
  return { replaySessionId: id, sourceSessionId: o.sourceSessionId, dbPath: o.replayDbPath, events: n };
}
