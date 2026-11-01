import { z } from 'zod';
import type { Candle, Level, MarketEvent } from '../domain';
import type { ProductMeta } from './coinbase';
import { checkWebSocket, guardedGet, type FetchLike } from './netguard';

/**
 * Binance.US public market data for BTC/USD (no account, no keys).
 *
 * Verified live on 2026-10-31:
 *  - combined stream `btcusd@depth@100ms` (diff depth, ABSOLUTE quantities; 0 removes a level),
 *    `btcusd@trade` and `btcusd@kline_5m`;
 *  - Binance's documented book sync: buffer diffs, fetch the REST snapshot (lastUpdateId), drop
 *    diffs with u <= lastUpdateId, the first applied diff must satisfy U <= lastUpdateId + 1 <= u,
 *    and every later diff must have U == previous u + 1, otherwise the book is unreliable and we
 *    resynchronize on a new connection (epoch).
 *  - Completed bars come from the venue's own closed 5m klines (`k.x === true`): exactly the
 *    candles the historical research used, so live decisions match research decisions.
 */
export const BINANCEUS_SYMBOL = 'BTCUSD';
export const BINANCEUS_WS_URL = `wss://stream.binance.us:9443/stream?streams=btcusd@depth@100ms/btcusd@trade/btcusd@kline_5m`;
const REST = 'https://api.binance.us/api/v3';

const ExchangeInfo = z.object({
  symbols: z.array(
    z.object({
      symbol: z.literal(BINANCEUS_SYMBOL),
      status: z.string(),
      filters: z.array(z.record(z.string(), z.unknown())),
    }),
  ),
});

/** Product constraints mapped onto the venue-neutral ProductMeta shape. */
export async function fetchBinanceUsProduct(fetchImpl?: FetchLike): Promise<ProductMeta> {
  const j = ExchangeInfo.parse(await guardedGet(`${REST}/exchangeInfo?symbol=${BINANCEUS_SYMBOL}`, { fetchImpl }));
  const s = j.symbols[0]!;
  const f = (type: string) => s.filters.find((x) => x.filterType === type) ?? {};
  const price = f('PRICE_FILTER');
  const lot = f('LOT_SIZE');
  const notional = { ...f('NOTIONAL'), ...f('MIN_NOTIONAL') };
  const trim = (v: unknown) =>
    String(v)
      .replace(/(\.\d*?)0+$/, '$1')
      .replace(/\.$/, '');
  return {
    product_id: 'BTC-USD',
    base_increment: trim(lot.stepSize),
    quote_increment: trim(price.tickSize),
    price_increment: trim(price.tickSize),
    base_min_size: trim(lot.minQty),
    base_max_size: trim(lot.maxQty),
    quote_min_size: trim(notional.minNotional ?? '1'),
    quote_max_size: '100000000',
    status: s.status === 'TRADING' ? 'online' : s.status.toLowerCase(),
    trading_disabled: s.status !== 'TRADING',
    cancel_only: false,
    limit_only: false,
    post_only: false,
    is_disabled: false,
    product_type: 'SPOT',
  };
}

/** Completed 5m klines from REST (warmup). Never invents missing buckets. */
export async function fetchBinanceUsCandles(startMs: number, endMs: number, fetchImpl?: FetchLike): Promise<Candle[]> {
  const out: Candle[] = [];
  let start = startMs;
  while (start < endMs) {
    const rows = (await guardedGet(`${REST}/klines?symbol=${BINANCEUS_SYMBOL}&interval=5m&startTime=${start}&endTime=${endMs}&limit=1000`, {
      fetchImpl,
    })) as (string | number)[][];
    if (!rows.length) break;
    for (const r of rows) {
      if ((r[6] as number) >= Date.now()) continue; // still open
      out.push({ start: r[0] as number, open: trim(r[1]), high: trim(r[2]), low: trim(r[3]), close: trim(r[4]), volume: trim(r[5]) });
    }
    start = (rows.at(-1)![0] as number) + 300_000;
  }
  return out;
}

function trim(v: unknown): string {
  const s = String(v);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') || '0' : s;
}

const levels = (xs: [string, string][]): Level[] => xs.map(([price, qty]) => ({ price: trim(price), qty: trim(qty) }));

// ---------- depth sync (pure; tested) ----------

export interface DepthSyncState {
  epoch: number;
  /** lastUpdateId of the applied snapshot, or null before it. */
  snapshotId: number | null;
  /** u of the last applied diff (or snapshot id), or null. */
  lastU: number | null;
  /** Diffs received before the snapshot. */
  buffer: { U: number; u: number; b: [string, string][]; a: [string, string][]; E: number }[];
}

type Diff = DepthSyncState['buffer'][number];

/** Apply one diff according to Binance's sync rules. Returns events (book_update or seq_gap). */
export function applyDiff(st: DepthSyncState, d: Diff, receiptTime: number): MarketEvent[] {
  if (st.snapshotId === null) {
    st.buffer.push(d);
    if (st.buffer.length > 5000) st.buffer.shift();
    return [];
  }
  if (d.u <= st.lastU!) return []; // already covered by the snapshot / duplicate
  const first = st.lastU === st.snapshotId;
  const ok = first ? d.U <= st.snapshotId + 1 && st.snapshotId + 1 <= d.u : d.U === st.lastU! + 1;
  if (!ok) {
    const ev: MarketEvent = { kind: 'seq_gap', ordinal: 0, epoch: st.epoch, receiptTime, expected: st.lastU! + 1, got: d.U };
    st.snapshotId = null;
    st.lastU = null;
    st.buffer = [];
    return [ev];
  }
  st.lastU = d.u;
  return [
    {
      kind: 'book_update',
      ordinal: 0,
      epoch: st.epoch,
      seq: d.u,
      exchangeTime: d.E,
      receiptTime,
      changes: [
        ...d.b.map(([p, q]) => ({ side: 'bid' as const, price: trim(p), qty: trim(q) })),
        ...d.a.map(([p, q]) => ({ side: 'ask' as const, price: trim(p), qty: trim(q) })),
      ],
    },
  ];
}

/** Install a REST snapshot and replay the buffered diffs it bridges. */
export function applySnapshot(
  st: DepthSyncState,
  snap: { lastUpdateId: number; bids: [string, string][]; asks: [string, string][] },
  receiptTime: number,
): MarketEvent[] {
  st.snapshotId = snap.lastUpdateId;
  st.lastU = snap.lastUpdateId;
  const out: MarketEvent[] = [
    {
      kind: 'book_snapshot',
      ordinal: 0,
      epoch: st.epoch,
      seq: snap.lastUpdateId,
      exchangeTime: receiptTime,
      receiptTime,
      bids: levels(snap.bids),
      asks: levels(snap.asks),
    },
  ];
  const buffered = st.buffer;
  st.buffer = [];
  for (const d of buffered) {
    const evs = applyDiff(st, d, receiptTime);
    out.push(...evs);
    if (evs.some((e) => e.kind === 'seq_gap')) break;
  }
  return out;
}

/** Normalize one combined-stream message (trades and closed klines; depth goes through applyDiff). */
export function normalizeBinanceUs(raw: unknown, receiptTime: number, st: DepthSyncState): MarketEvent[] {
  const m = raw as { stream?: string; data?: Record<string, unknown> };
  const d = m.data;
  if (!d) return [];
  if (d.e === 'depthUpdate')
    return applyDiff(
      st,
      { U: d.U as number, u: d.u as number, b: d.b as [string, string][], a: d.a as [string, string][], E: d.E as number },
      receiptTime,
    );
  if (d.e === 'trade') {
    return [
      {
        kind: 'trade',
        ordinal: 0,
        epoch: st.epoch,
        seq: d.t as number,
        exchangeTime: d.T as number,
        receiptTime,
        tradeId: String(d.t),
        price: trim(d.p),
        size: trim(d.q),
        venueSide: d.m ? 'buyer_is_maker' : 'buyer_is_taker',
      },
    ];
  }
  if (d.e === 'kline') {
    const k = d.k as { t: number; o: string; h: string; l: string; c: string; v: string; x: boolean };
    if (!k.x) return [];
    return [
      {
        kind: 'bar',
        ordinal: 0,
        receiptTime,
        candle: { start: k.t, open: trim(k.o), high: trim(k.h), low: trim(k.l), close: trim(k.c), volume: trim(k.v) },
      },
    ];
  }
  return [];
}

// ---------- live transport ----------

export interface BinanceUsSourceOptions {
  tickMs: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  silenceMs?: number;
  wsFactory?: (url: string) => WebSocket;
  fetchImpl?: FetchLike;
}

/** Same contract as CoinbaseLiveSource: normalized events, ticks, connection/gap health. */
export class BinanceUsLiveSource {
  private queue: MarketEvent[] = [];
  private wake: (() => void) | null = null;
  private ws: WebSocket | null = null;
  private epoch = 0;
  private st: DepthSyncState = { epoch: 0, snapshotId: null, lastU: null, buffer: [] };
  private lastMsgAt = 0;
  private stalledUntil = 0;
  private attempts = 0;
  duplicatesDropped = 0;
  onRaw: ((raw: unknown, receiptTime: number, epoch: number) => void) | null = null;

  constructor(private readonly o: BinanceUsSourceOptions) {}

  private push(e: MarketEvent): void {
    this.queue.push(e);
    this.wake?.();
  }

  drillDisconnect(ms: number): void {
    this.stalledUntil = Date.now() + ms;
    this.push({ kind: 'drill', ordinal: 0, receiptTime: Date.now(), name: 'disconnect', detail: `${ms}ms` });
    this.ws?.close();
  }

  drillDuplicate(_k: number): void {
    this.push({ kind: 'drill', ordinal: 0, receiptTime: Date.now(), name: 'duplicate', detail: 'redelivered last diff' });
    const st = this.st;
    if (st.lastU !== null) {
      const evs = applyDiff(st, { U: st.lastU, u: st.lastU, b: [], a: [], E: Date.now() }, Date.now());
      if (evs.length === 0) this.duplicatesDropped++;
    }
  }

  private async snapshot(epoch: number): Promise<void> {
    try {
      const snap = (await guardedGet(`${REST}/depth?symbol=${BINANCEUS_SYMBOL}&limit=1000`, { fetchImpl: this.o.fetchImpl })) as {
        lastUpdateId: number;
        bids: [string, string][];
        asks: [string, string][];
      };
      if (epoch !== this.epoch) return;
      this.onRaw?.({ rest: 'depth', lastUpdateId: snap.lastUpdateId, bids: snap.bids, asks: snap.asks }, Date.now(), epoch);
      for (const e of applySnapshot(this.st, snap, Date.now())) {
        this.push(e);
        if (e.kind === 'seq_gap') this.ws?.close();
      }
    } catch (e) {
      this.push({
        kind: 'connection',
        ordinal: 0,
        epoch,
        receiptTime: Date.now(),
        state: 'error',
        detail: `snapshot failed: ${String(e)}`,
      });
      this.ws?.close();
    }
  }

  private connect(signal: AbortSignal): void {
    if (signal.aborted) return;
    checkWebSocket(BINANCEUS_WS_URL);
    this.epoch++;
    const epoch = this.epoch;
    this.st = { epoch, snapshotId: null, lastU: null, buffer: [] };
    const ws = (this.o.wsFactory ?? ((u) => new WebSocket(u)))(BINANCEUS_WS_URL);
    this.ws = ws;
    this.push({ kind: 'connection', ordinal: 0, epoch, receiptTime: Date.now(), state: 'open', detail: 'connecting' });
    ws.onopen = () => {
      this.push({ kind: 'connection', ordinal: 0, epoch, receiptTime: Date.now(), state: 'subscribed', detail: 'combined stream' });
      // Give the stream a moment to buffer diffs, then fetch the snapshot that bridges them.
      setTimeout(() => void this.snapshot(epoch), 1000).unref();
    };
    ws.onmessage = (m) => {
      if (this.ws !== ws) return;
      const t = Date.now();
      let raw: unknown;
      try {
        raw = JSON.parse(String(m.data));
      } catch {
        return;
      }
      this.lastMsgAt = t;
      this.onRaw?.(raw, t, epoch);
      for (const e of normalizeBinanceUs(raw, t, this.st)) {
        this.push(e);
        if (e.kind === 'seq_gap') ws.close();
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.push({ kind: 'connection', ordinal: 0, epoch, receiptTime: Date.now(), state: 'closed' });
      if (signal.aborted) return;
      const backoff = Math.min(this.o.reconnectMaxMs, this.o.reconnectMinMs * 2 ** Math.min(this.attempts++, 8));
      setTimeout(() => this.connect(signal), Math.max(backoff, this.stalledUntil - Date.now())).unref();
    };
    ws.onerror = () => {};
  }

  async *stream(signal: AbortSignal): AsyncGenerator<MarketEvent> {
    this.connect(signal);
    const tick = setInterval(() => {
      const now = Date.now();
      this.push({ kind: 'tick', ordinal: 0, receiptTime: now });
      if (this.ws && this.lastMsgAt && now - this.lastMsgAt > (this.o.silenceMs ?? 30_000)) {
        this.lastMsgAt = now;
        this.ws.close();
      }
      if (this.st.lastU !== null) this.attempts = 0;
    }, this.o.tickMs);
    const onAbort = () => {
      clearInterval(tick);
      this.ws?.close();
      this.wake?.();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      while (!signal.aborted) {
        if (this.queue.length === 0) {
          await new Promise<void>((r) => (this.wake = r));
          this.wake = null;
          continue;
        }
        yield this.queue.shift()!;
      }
    } finally {
      clearInterval(tick);
      signal.removeEventListener('abort', onAbort);
      const ws = this.ws;
      this.ws = null;
      ws?.close();
    }
  }
}
