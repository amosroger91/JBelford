import type { DB } from './db';
import { inTransaction } from './db';
import type {
  Balance,
  Candle,
  LocalOrderStatus,
  OrderRecord,
  PositionRecord,
  TradeRecord,
} from '../core/types';

type Row = Record<string, unknown>;

function toOrder(r: Row): OrderRecord {
  return {
    clientOrderId: r.client_order_id as string,
    exchangeOrderId: (r.exchange_order_id as string | null) ?? null,
    tradeId: r.trade_id as string,
    symbol: r.symbol as string,
    side: r.side as OrderRecord['side'],
    type: r.type as OrderRecord['type'],
    purpose: r.purpose as OrderRecord['purpose'],
    price: (r.price as number | null) ?? null,
    amount: r.amount as number,
    filled: r.filled as number,
    avgPrice: (r.avg_price as number | null) ?? null,
    fee: r.fee as number,
    status: r.status as LocalOrderStatus,
    postOnly: Boolean(r.post_only),
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function toPosition(r: Row): PositionRecord {
  return {
    tradeId: r.trade_id as string,
    symbol: r.symbol as string,
    amount: r.amount as number,
    entryPrice: r.entry_price as number,
    entryFee: r.entry_fee as number,
    openedAt: r.opened_at as number,
    stopPrice: r.stop_price as number,
    takeProfitPrice: r.take_profit_price as number,
  };
}

function toTrade(r: Row): TradeRecord {
  return {
    tradeId: r.trade_id as string,
    symbol: r.symbol as string,
    amount: r.amount as number,
    entryPrice: r.entry_price as number,
    exitPrice: r.exit_price as number,
    entryFee: r.entry_fee as number,
    exitFee: r.exit_fee as number,
    grossPnl: r.gross_pnl as number,
    netPnl: r.net_pnl as number,
    openedAt: r.opened_at as number,
    closedAt: r.closed_at as number,
    exitReason: r.exit_reason as TradeRecord['exitReason'],
    mode: r.mode as TradeRecord['mode'],
  };
}

export const OPEN_STATUSES: LocalOrderStatus[] = ['pending_submit', 'open', 'unknown'];

export class Store {
  constructor(readonly db: DB) {}

  // ---- key/value ----
  getKv<T>(key: string): T | undefined {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as T) : undefined;
  }

  setKv(key: string, value: unknown, now = Date.now()): void {
    this.db
      .prepare(
        'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(key, JSON.stringify(value), now);
  }

  deleteKv(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }

  // ---- orders ----
  insertOrder(o: OrderRecord): void {
    this.db
      .prepare(
        `INSERT INTO orders (client_order_id, exchange_order_id, trade_id, symbol, side, type, purpose, price, amount,
          filled, avg_price, fee, status, post_only, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        o.clientOrderId,
        o.exchangeOrderId,
        o.tradeId,
        o.symbol,
        o.side,
        o.type,
        o.purpose,
        o.price,
        o.amount,
        o.filled,
        o.avgPrice,
        o.fee,
        o.status,
        o.postOnly ? 1 : 0,
        o.createdAt,
        o.updatedAt,
      );
  }

  updateOrder(
    clientOrderId: string,
    patch: Partial<Pick<OrderRecord, 'exchangeOrderId' | 'filled' | 'avgPrice' | 'fee' | 'status'>>,
    now = Date.now(),
  ): void {
    const cur = this.getOrder(clientOrderId);
    if (!cur) throw new Error(`unknown order ${clientOrderId}`);
    const n = { ...cur, ...patch };
    this.db
      .prepare(
        'UPDATE orders SET exchange_order_id = ?, filled = ?, avg_price = ?, fee = ?, status = ?, updated_at = ? WHERE client_order_id = ?',
      )
      .run(n.exchangeOrderId, n.filled, n.avgPrice, n.fee, n.status, now, clientOrderId);
  }

  getOrder(clientOrderId: string): OrderRecord | undefined {
    const r = this.db.prepare('SELECT * FROM orders WHERE client_order_id = ?').get(clientOrderId) as Row | undefined;
    return r ? toOrder(r) : undefined;
  }

  openOrders(): OrderRecord[] {
    return (
      this.db
        .prepare(`SELECT * FROM orders WHERE status IN ('pending_submit','open','unknown') ORDER BY created_at`)
        .all() as Row[]
    ).map(toOrder);
  }

  ordersForTrade(tradeId: string): OrderRecord[] {
    return (this.db.prepare('SELECT * FROM orders WHERE trade_id = ? ORDER BY created_at').all(tradeId) as Row[]).map(
      toOrder,
    );
  }

  recentOrders(limit = 20): OrderRecord[] {
    return (this.db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?').all(limit) as Row[]).map(toOrder);
  }

  // ---- fills ----
  insertFill(f: { clientOrderId: string; tradeId: string; ts: number; side: string; price: number; amount: number; fee: number }): void {
    this.db
      .prepare('INSERT INTO fills (client_order_id, trade_id, ts, side, price, amount, fee) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(f.clientOrderId, f.tradeId, f.ts, f.side, f.price, f.amount, f.fee);
  }

  // ---- positions ----
  openPosition(): PositionRecord | undefined {
    const r = this.db.prepare(`SELECT * FROM positions WHERE status = 'open' LIMIT 1`).get() as Row | undefined;
    return r ? toPosition(r) : undefined;
  }

  upsertPosition(p: PositionRecord): void {
    this.db
      .prepare(
        `INSERT INTO positions (trade_id, symbol, amount, entry_price, entry_fee, opened_at, stop_price, take_profit_price, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')
         ON CONFLICT(trade_id) DO UPDATE SET amount = excluded.amount, entry_price = excluded.entry_price,
           entry_fee = excluded.entry_fee, stop_price = excluded.stop_price, take_profit_price = excluded.take_profit_price`,
      )
      .run(p.tradeId, p.symbol, p.amount, p.entryPrice, p.entryFee, p.openedAt, p.stopPrice, p.takeProfitPrice);
  }

  closePositionWithTrade(t: TradeRecord): void {
    inTransaction(this.db, () => {
      this.db.prepare(`UPDATE positions SET status = 'closed' WHERE trade_id = ?`).run(t.tradeId);
      this.db
        .prepare(
          `INSERT INTO trades (trade_id, symbol, amount, entry_price, exit_price, entry_fee, exit_fee, gross_pnl, net_pnl,
            opened_at, closed_at, exit_reason, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          t.tradeId,
          t.symbol,
          t.amount,
          t.entryPrice,
          t.exitPrice,
          t.entryFee,
          t.exitFee,
          t.grossPnl,
          t.netPnl,
          t.openedAt,
          t.closedAt,
          t.exitReason,
          t.mode,
        );
    });
  }

  // ---- trades ----
  tradesSince(ts: number): TradeRecord[] {
    return (this.db.prepare('SELECT * FROM trades WHERE closed_at >= ? ORDER BY closed_at').all(ts) as Row[]).map(toTrade);
  }

  recentTrades(limit = 20): TradeRecord[] {
    return (this.db.prepare('SELECT * FROM trades ORDER BY closed_at DESC LIMIT ?').all(limit) as Row[]).map(toTrade);
  }

  lastTrade(): TradeRecord | undefined {
    return this.recentTrades(1)[0];
  }

  totals(): { trades: number; netPnl: number; grossPnl: number; fees: number; wins: number } {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(net_pnl),0) AS net, COALESCE(SUM(gross_pnl),0) AS gross,
          COALESCE(SUM(entry_fee + exit_fee),0) AS fees, COALESCE(SUM(CASE WHEN net_pnl > 0 THEN 1 ELSE 0 END),0) AS wins FROM trades`,
      )
      .get() as { n: number; net: number; gross: number; fees: number; wins: number };
    return { trades: r.n, netPnl: r.net, grossPnl: r.gross, fees: r.fees, wins: r.wins };
  }

  // ---- balances ----
  insertBalance(ts: number, b: Balance, markPrice: number): void {
    this.db
      .prepare('INSERT INTO balances (ts, usd, btc, mark_price, equity) VALUES (?, ?, ?, ?, ?)')
      .run(ts, b.usd, b.btc, markPrice, b.usd + b.btc * markPrice);
  }

  latestBalance(): { ts: number; usd: number; btc: number; markPrice: number; equity: number } | undefined {
    const r = this.db.prepare('SELECT * FROM balances ORDER BY id DESC LIMIT 1').get() as Row | undefined;
    if (!r) return undefined;
    return { ts: r.ts as number, usd: r.usd as number, btc: r.btc as number, markPrice: r.mark_price as number, equity: r.equity as number };
  }

  firstBalance(): { ts: number; equity: number } | undefined {
    const r = this.db.prepare('SELECT ts, equity FROM balances ORDER BY id ASC LIMIT 1').get() as Row | undefined;
    return r ? { ts: r.ts as number, equity: r.equity as number } : undefined;
  }

  // ---- events ----
  insertEvent(ts: number, level: string, msg: string, data?: unknown): void {
    this.db
      .prepare('INSERT INTO events (ts, level, msg, data) VALUES (?, ?, ?, ?)')
      .run(ts, level, msg, data === undefined ? null : JSON.stringify(data));
  }

  recentEvents(limit = 10): { ts: number; level: string; msg: string }[] {
    return this.db.prepare('SELECT ts, level, msg FROM events ORDER BY id DESC LIMIT ?').all(limit) as {
      ts: number;
      level: string;
      msg: string;
    }[];
  }

  // ---- market context ----
  insertContext(source: string, ts: number, payload: unknown): void {
    this.db.prepare('INSERT INTO context_snapshots (source, ts, payload) VALUES (?, ?, ?)').run(source, ts, JSON.stringify(payload));
  }

  latestContext<T>(source: string): { ts: number; payload: T } | undefined {
    const r = this.db.prepare('SELECT ts, payload FROM context_snapshots WHERE source = ? ORDER BY id DESC LIMIT 1').get(source) as
      | { ts: number; payload: string }
      | undefined;
    return r ? { ts: r.ts, payload: JSON.parse(r.payload) as T } : undefined;
  }

  upsertFearGreed(source: string, points: { ts: number; score: number }[]): void {
    const stmt = this.db.prepare(
      'INSERT INTO fear_greed (source, ts, score) VALUES (?, ?, ?) ON CONFLICT(source, ts) DO UPDATE SET score = excluded.score',
    );
    inTransaction(this.db, () => {
      for (const p of points) stmt.run(source, p.ts, p.score);
    });
  }

  fearGreedSeries(source: string, from = 0): { ts: number; score: number }[] {
    return this.db.prepare('SELECT ts, score FROM fear_greed WHERE source = ? AND ts >= ? ORDER BY ts').all(source, from) as {
      ts: number;
      score: number;
    }[];
  }

  // ---- candles (history cache) ----
  upsertCandles(exchange: string, symbol: string, tf: string, candles: Candle[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO candles (exchange, symbol, tf, ts, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(exchange, symbol, tf, ts) DO UPDATE SET open = excluded.open, high = excluded.high, low = excluded.low,
         close = excluded.close, volume = excluded.volume`,
    );
    inTransaction(this.db, () => {
      for (const c of candles) stmt.run(exchange, symbol, tf, c.ts, c.open, c.high, c.low, c.close, c.volume);
    });
  }

  loadCandles(exchange: string, symbol: string, tf: string, from = 0, to = Number.MAX_SAFE_INTEGER): Candle[] {
    return this.db
      .prepare(
        'SELECT ts, open, high, low, close, volume FROM candles WHERE exchange = ? AND symbol = ? AND tf = ? AND ts >= ? AND ts < ? ORDER BY ts',
      )
      .all(exchange, symbol, tf, from, to) as unknown as Candle[];
  }

  candleRange(exchange: string, symbol: string, tf: string): { min: number | null; max: number | null; n: number } {
    return this.db
      .prepare('SELECT MIN(ts) AS min, MAX(ts) AS max, COUNT(*) AS n FROM candles WHERE exchange = ? AND symbol = ? AND tf = ?')
      .get(exchange, symbol, tf) as { min: number | null; max: number | null; n: number };
  }
}
