import { DatabaseSync } from 'node:sqlite';

/**
 * node:sqlite (built into Node >= 22.13) is used instead of a native addon so
 * Windows installs need no C++ build tools.
 */
export type DB = DatabaseSync;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS orders (
    client_order_id TEXT PRIMARY KEY,
    exchange_order_id TEXT,
    trade_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy','sell')),
    type TEXT NOT NULL CHECK (type IN ('limit','market')),
    purpose TEXT NOT NULL,
    price REAL,
    amount REAL NOT NULL,
    filled REAL NOT NULL DEFAULT 0,
    avg_price REAL,
    fee REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    post_only INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE TABLE IF NOT EXISTS fills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_order_id TEXT NOT NULL,
    trade_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    side TEXT NOT NULL,
    price REAL NOT NULL,
    amount REAL NOT NULL,
    fee REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS positions (
    trade_id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    amount REAL NOT NULL,
    entry_price REAL NOT NULL,
    entry_fee REAL NOT NULL,
    opened_at INTEGER NOT NULL,
    stop_price REAL NOT NULL,
    take_profit_price REAL NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open','closed'))
  );
  CREATE TABLE IF NOT EXISTS trades (
    trade_id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    amount REAL NOT NULL,
    entry_price REAL NOT NULL,
    exit_price REAL NOT NULL,
    entry_fee REAL NOT NULL,
    exit_fee REAL NOT NULL,
    gross_pnl REAL NOT NULL,
    net_pnl REAL NOT NULL,
    opened_at INTEGER NOT NULL,
    closed_at INTEGER NOT NULL,
    exit_reason TEXT NOT NULL,
    mode TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_trades_closed ON trades(closed_at);
  CREATE TABLE IF NOT EXISTS balances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    usd REAL NOT NULL,
    btc REAL NOT NULL,
    mark_price REAL NOT NULL,
    equity REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    level TEXT NOT NULL,
    msg TEXT NOT NULL,
    data TEXT
  );
  CREATE TABLE IF NOT EXISTS candles (
    exchange TEXT NOT NULL,
    symbol TEXT NOT NULL,
    tf TEXT NOT NULL,
    ts INTEGER NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume REAL NOT NULL,
    PRIMARY KEY (exchange, symbol, tf, ts)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS context_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    ts INTEGER NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_context_source_ts ON context_snapshots(source, ts);
  CREATE TABLE IF NOT EXISTS fear_greed (
    source TEXT NOT NULL,
    ts INTEGER NOT NULL,
    score REAL NOT NULL,
    PRIMARY KEY (source, ts)
  );
  `,
];

export function openDb(path: string): DB {
  const db = new DatabaseSync(path);
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);');
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  while (version < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]!);
      version++;
      db.prepare('UPDATE schema_version SET version = ?').run(version);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

export function inTransaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
