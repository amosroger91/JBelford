import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * TradingStore: a separate SQLite database for the paper-trading subsystem
 * (never mixed with the scalper's state/paper.db). Additive migrations,
 * single-owner lease, and transactional helpers.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    status TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode = 'paper'),
    venue TEXT NOT NULL,
    product TEXT NOT NULL,
    purpose TEXT NOT NULL,
    config_json TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    strategy_version TEXT NOT NULL,
    initial_usd TEXT NOT NULL,
    initial_btc TEXT NOT NULL,
    product_meta_json TEXT,
    source_commit TEXT,
    deps_json TEXT,
    dataset_id TEXT,
    generation INTEGER NOT NULL DEFAULT 0,
    day_start_date TEXT,
    day_start_equity TEXT,
    hwm_equity TEXT,
    pause_reason TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    ended_at INTEGER,
    last_event_time INTEGER,
    last_ordinal INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE strategy_versions (hash TEXT PRIMARY KEY, strategy_id TEXT NOT NULL, config_json TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE experiments (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    strategy_version TEXT NOT NULL,
    session_id TEXT,
    config_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    summary_json TEXT
  );
  CREATE TABLE datasets (id TEXT PRIMARY KEY, session_id TEXT, dir TEXT NOT NULL, created_at INTEGER NOT NULL, manifest_json TEXT);
  CREATE TABLE decisions (
    decision_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    strategy TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    completed_at INTEGER,
    outcome TEXT,
    intent_json TEXT,
    detail TEXT,
    model_json TEXT,
    event_ordinal INTEGER
  );
  CREATE TABLE model_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    decision_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    request_hash TEXT,
    response_hash TEXT,
    latency_ms INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd TEXT
  );
  CREATE TABLE risk_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    decision_id TEXT,
    check_name TEXT NOT NULL,
    passed INTEGER NOT NULL,
    detail TEXT,
    time INTEGER NOT NULL,
    event_ordinal INTEGER NOT NULL
  );
  CREATE TABLE orders (
    order_id TEXT NOT NULL,
    client_order_id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    decision_id TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy','sell')),
    purpose TEXT NOT NULL,
    qty TEXT NOT NULL,
    filled_qty TEXT NOT NULL DEFAULT '0',
    notional TEXT NOT NULL DEFAULT '0',
    fees TEXT NOT NULL DEFAULT '0',
    guard_price TEXT NOT NULL,
    reserved TEXT NOT NULL,
    reserved_remaining TEXT NOT NULL,
    status TEXT NOT NULL,
    submitted_at INTEGER NOT NULL,
    arrival_at INTEGER NOT NULL,
    valid_until INTEGER NOT NULL,
    policy_version TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    reject_reason TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, order_id),
    UNIQUE (session_id, decision_id, purpose)
  );
  CREATE TABLE fills (
    fill_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    side TEXT NOT NULL,
    price TEXT NOT NULL,
    qty TEXT NOT NULL,
    fee TEXT NOT NULL,
    time INTEGER NOT NULL,
    event_ordinal INTEGER NOT NULL,
    PRIMARY KEY (session_id, fill_id)
  );
  CREATE TABLE ledger_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    time INTEGER NOT NULL,
    event_ordinal INTEGER NOT NULL,
    ref_type TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    account TEXT NOT NULL,
    amount TEXT NOT NULL,
    memo TEXT
  );
  CREATE INDEX idx_ledger_session ON ledger_entries(session_id, id);
  CREATE TABLE balances (
    session_id TEXT PRIMARY KEY,
    usd_available TEXT NOT NULL,
    usd_reserved TEXT NOT NULL,
    btc_available TEXT NOT NULL,
    btc_reserved TEXT NOT NULL,
    btc_cost_basis TEXT NOT NULL,
    realized_pnl TEXT NOT NULL,
    fees_paid TEXT NOT NULL
  );
  CREATE TABLE valuations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    time INTEGER NOT NULL,
    event_ordinal INTEGER NOT NULL,
    mark_bid TEXT,
    mark_mid TEXT,
    equity_mid TEXT,
    equity_bid TEXT,
    liquidation_value TEXT,
    stale INTEGER NOT NULL
  );
  CREATE INDEX idx_valuations_session ON valuations(session_id, id);
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    time INTEGER NOT NULL,
    event_ordinal INTEGER NOT NULL,
    kind TEXT NOT NULL,
    detail_json TEXT
  );
  CREATE INDEX idx_audit_session ON audit(session_id, id);
  CREATE TABLE feed_health (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    time INTEGER NOT NULL,
    state TEXT NOT NULL,
    detail TEXT
  );
  CREATE TABLE controls (
    request_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    action TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    applied_at INTEGER,
    status TEXT NOT NULL
  );
  CREATE TABLE lease (name TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL);
  CREATE TABLE reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    path TEXT NOT NULL,
    content_hash TEXT NOT NULL
  );
  CREATE TABLE observation_gaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    start_time INTEGER NOT NULL,
    end_time INTEGER,
    reason TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE runtime_status (session_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
  `,
  `
  ALTER TABLE orders ADD COLUMN order_type TEXT NOT NULL DEFAULT 'market';
  ALTER TABLE orders ADD COLUMN limit_price TEXT;
  ALTER TABLE orders ADD COLUMN post_only INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE orders ADD COLUMN activated_at INTEGER;
  CREATE TABLE brackets (
    session_id TEXT NOT NULL,
    bracket_id TEXT NOT NULL,
    entry_order_id TEXT NOT NULL,
    tp_pct TEXT NOT NULL,
    sl_pct TEXT NOT NULL,
    max_hold_ms INTEGER NOT NULL,
    status TEXT NOT NULL,
    entry_price TEXT,
    qty TEXT NOT NULL DEFAULT '0',
    tp_price TEXT,
    stop_price TEXT,
    tp_order_id TEXT,
    exit_order_id TEXT,
    opened_at INTEGER,
    closed_at INTEGER,
    exit_reason TEXT,
    PRIMARY KEY (session_id, bracket_id)
  );
  `,
];

export type Row = Record<string, unknown>;

export class TradingStore {
  readonly db: DatabaseSync;
  /** Test hook: called at named points inside transactions (crash-at-boundary tests). */
  faultHook: ((point: string) => void) | null = null;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS paper_schema_version (version INTEGER NOT NULL)');
    const row = this.db.prepare('SELECT version FROM paper_schema_version').get() as { version: number } | undefined;
    let v = row?.version ?? 0;
    if (!row) this.db.prepare('INSERT INTO paper_schema_version (version) VALUES (0)').run();
    while (v < MIGRATIONS.length) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.prepare('UPDATE paper_schema_version SET version = ?').run(v + 1);
      });
      v++;
    }
  }

  private depth = 0;
  /** Run fn in a transaction (nested calls join the outer one). */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }

  fault(point: string): void {
    this.faultHook?.(point);
  }

  get(sql: string, ...p: (string | number | null)[]): Row | undefined {
    return this.db.prepare(sql).get(...p) as Row | undefined;
  }
  all(sql: string, ...p: (string | number | null)[]): Row[] {
    return this.db.prepare(sql).all(...p) as Row[];
  }
  run(sql: string, ...p: (string | number | null)[]): void {
    this.db.prepare(sql).run(...p);
  }

  audit(sessionId: string, time: number, ordinal: number, kind: string, detail?: unknown): void {
    this.run(
      'INSERT INTO audit (session_id, time, event_ordinal, kind, detail_json) VALUES (?, ?, ?, ?, ?)',
      sessionId,
      time,
      ordinal,
      kind,
      detail === undefined ? null : JSON.stringify(detail),
    );
  }

  // ---------- single-owner lease ----------

  /** Acquire the runtime lease for `name`. A lease older than `staleMs` may be taken over. */
  acquireLease(name: string, owner: string, now: number, staleMs = 15_000): boolean {
    return this.tx(() => {
      const cur = this.get('SELECT owner, heartbeat_at FROM lease WHERE name = ?', name);
      if (cur && cur.owner !== owner && now - (cur.heartbeat_at as number) < staleMs) return false;
      this.run(
        'INSERT INTO lease (name, owner, pid, heartbeat_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, pid = excluded.pid, heartbeat_at = excluded.heartbeat_at',
        name,
        owner,
        process.pid,
        now,
      );
      return true;
    });
  }

  heartbeatLease(name: string, owner: string, now: number): boolean {
    const cur = this.get('SELECT owner FROM lease WHERE name = ?', name);
    if (!cur || cur.owner !== owner) return false;
    this.run('UPDATE lease SET heartbeat_at = ? WHERE name = ?', now, name);
    return true;
  }

  releaseLease(name: string, owner: string): void {
    this.run('DELETE FROM lease WHERE name = ? AND owner = ?', name, owner);
  }

  leaseInfo(name: string): { owner: string; pid: number; heartbeatAt: number } | undefined {
    const r = this.get('SELECT owner, pid, heartbeat_at FROM lease WHERE name = ?', name);
    return r ? { owner: r.owner as string, pid: r.pid as number, heartbeatAt: r.heartbeat_at as number } : undefined;
  }

  close(): void {
    this.db.close();
  }
}
