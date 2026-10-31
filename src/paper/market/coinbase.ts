import { z } from 'zod';
import type { Candle, Level, MarketEvent } from '../domain';
import { PUBLIC_WS_URL, checkSubscribeMessage, checkWebSocket, guardedGet, type FetchLike } from './netguard';

const BASE = 'https://api.coinbase.com/api/v3/brokerage';

// ---------- product metadata ----------

const ProductSchema = z.object({
  product_id: z.literal('BTC-USD'),
  base_increment: z.string(),
  quote_increment: z.string(),
  price_increment: z.string().optional(),
  base_min_size: z.string(),
  base_max_size: z.string(),
  quote_min_size: z.string(),
  quote_max_size: z.string(),
  status: z.string(),
  trading_disabled: z.boolean(),
  cancel_only: z.boolean(),
  limit_only: z.boolean(),
  post_only: z.boolean(),
  is_disabled: z.boolean(),
  product_type: z.literal('SPOT'),
});
export type ProductMeta = z.infer<typeof ProductSchema>;

export async function fetchProduct(fetchImpl?: FetchLike): Promise<ProductMeta> {
  const p = ProductSchema.parse(await guardedGet(`${BASE}/market/products/BTC-USD`, { fetchImpl }));
  return p;
}

/** Problems that make the product unusable for simulated market orders. */
export function productRestrictions(p: ProductMeta): string[] {
  const out: string[] = [];
  if (p.status !== 'online') out.push(`status ${p.status}`);
  if (p.trading_disabled || p.is_disabled) out.push('trading disabled');
  if (p.cancel_only) out.push('cancel-only');
  if (p.limit_only) out.push('limit-only (market orders unavailable)');
  if (p.post_only) out.push('post-only');
  return out;
}

// ---------- candles (warmup and historical screening) ----------

const CandlesSchema = z.object({
  candles: z.array(
    z.object({ start: z.string(), low: z.string(), high: z.string(), open: z.string(), close: z.string(), volume: z.string() }),
  ),
});

/** At most 350 buckets per request (plan 5). Returns completed candles oldest-first; never invents missing buckets. */
export async function fetchCandles(startSec: number, endSec: number, granularitySec = 300, fetchImpl?: FetchLike): Promise<Candle[]> {
  const gran = { 60: 'ONE_MINUTE', 300: 'FIVE_MINUTE', 900: 'FIFTEEN_MINUTE', 3600: 'ONE_HOUR' }[granularitySec];
  if (!gran) throw new Error(`unsupported granularity ${granularitySec}`);
  const out: Candle[] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  for (let s = startSec; s < endSec; s += 350 * granularitySec) {
    const e = Math.min(endSec, s + 350 * granularitySec);
    const url = `${BASE}/market/products/BTC-USD/candles?start=${s}&end=${e}&granularity=${gran}&limit=350`;
    const r = CandlesSchema.parse(await guardedGet(url, { fetchImpl }));
    for (const c of r.candles) {
      const startMs = Number(c.start) * 1000;
      // Only completed buckets inside the requested window.
      if (Number(c.start) + granularitySec > nowSec || Number(c.start) < s || Number(c.start) >= e) continue;
      out.push({ start: startMs, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    }
  }
  const dedup = new Map(out.map((c) => [c.start, c]));
  return [...dedup.values()].sort((a, b) => a.start - b.start);
}

// ---------- message normalization (pure; tested against recorded fixtures) ----------

export interface NormalizeState {
  epoch: number;
  /** Last sequence_num seen on THIS socket (-1 before the first message). */
  lastSeq: number;
  duplicates: number;
}

type Partial<E> = E extends { ordinal: number } ? Omit<E, 'ordinal'> & { ordinal: number } : never;

/**
 * Convert one raw Coinbase Advanced Trade message to normalized events.
 * Verified against a live capture (2026-10-31): `sequence_num` is a single
 * counter per WebSocket connection across all subscribed channels, so gaps are
 * detected per socket and per epoch; counters are never compared across sockets
 * or reconnects. The level2 subscription arrives on channel "l2_data".
 */
export function normalizeMessage(raw: unknown, receiptTime: number, st: NormalizeState): MarketEvent[] {
  const m = raw as {
    channel?: string;
    timestamp?: string;
    sequence_num?: number;
    events?: Record<string, unknown>[];
    type?: string;
    message?: string;
  };
  const out: Partial<MarketEvent>[] = [];
  if (m.type === 'error') {
    out.push({ kind: 'connection', ordinal: 0, epoch: st.epoch, receiptTime, state: 'error', detail: String(m.message ?? 'error') });
    return out as MarketEvent[];
  }
  const seq = typeof m.sequence_num === 'number' ? m.sequence_num : NaN;
  if (Number.isFinite(seq)) {
    if (st.lastSeq >= 0 && seq <= st.lastSeq) {
      st.duplicates++;
      return []; // duplicate or out-of-order replay of an already-applied message
    }
    if (st.lastSeq >= 0 && seq !== st.lastSeq + 1) {
      out.push({ kind: 'seq_gap', ordinal: 0, epoch: st.epoch, receiptTime, expected: st.lastSeq + 1, got: seq });
      st.lastSeq = seq;
      return out as MarketEvent[];
    }
    st.lastSeq = seq;
  }
  const exchangeTime = m.timestamp ? parseTime(m.timestamp) : receiptTime;
  for (const ev of m.events ?? []) {
    if (m.channel === 'l2_data') {
      const updates = (ev.updates as { side: string; price_level: string; new_quantity: string }[]) ?? [];
      if (ev.type === 'snapshot') {
        const bids: Level[] = [];
        const asks: Level[] = [];
        for (const u of updates) (u.side === 'bid' ? bids : asks).push({ price: u.price_level, qty: u.new_quantity });
        out.push({ kind: 'book_snapshot', ordinal: 0, epoch: st.epoch, seq, exchangeTime, receiptTime, bids, asks });
      } else if (ev.type === 'update') {
        out.push({
          kind: 'book_update',
          ordinal: 0,
          epoch: st.epoch,
          seq,
          exchangeTime,
          receiptTime,
          changes: updates.map((u) => ({ side: u.side === 'bid' ? 'bid' : 'ask', price: u.price_level, qty: u.new_quantity })),
        });
      }
    } else if (m.channel === 'market_trades') {
      for (const t of (ev.trades as { trade_id: string; price: string; size: string; side: string; time: string }[]) ?? []) {
        out.push({
          kind: 'trade',
          ordinal: 0,
          epoch: st.epoch,
          seq,
          exchangeTime: parseTime(t.time),
          receiptTime,
          tradeId: t.trade_id,
          price: t.price,
          size: t.size,
          venueSide: t.side,
        });
      }
    } else if (m.channel === 'heartbeats') {
      out.push({ kind: 'heartbeat', ordinal: 0, epoch: st.epoch, seq, exchangeTime, receiptTime, counter: Number(ev.heartbeat_counter) });
    } else if (m.channel === 'subscriptions') {
      out.push({
        kind: 'connection',
        ordinal: 0,
        epoch: st.epoch,
        receiptTime,
        state: 'subscribed',
        detail: JSON.stringify(ev.subscriptions),
      });
    }
  }
  return out as MarketEvent[];
}

/** Coinbase timestamps carry nanoseconds; keep millisecond precision. */
export function parseTime(s: string): number {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.(\d+))?Z$/.exec(s);
  if (!m) return Date.parse(s);
  const ms = (m[3] ?? '').slice(0, 3).padEnd(3, '0');
  return Date.parse(`${m[1]}.${ms}Z`);
}

// ---------- live WebSocket transport ----------

export interface LiveSourceOptions {
  tickMs: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  /** Force a reconnect if no message arrives for this long. */
  silenceMs?: number;
  maxQueue?: number;
  wsFactory?: (url: string) => WebSocket;
}

/**
 * Production public market data: level2 + market_trades + heartbeats on one
 * unauthenticated socket. Emits normalized events plus `tick` clock events and
 * `connection`/`seq_gap` health events. Never connects to the private user
 * channel. Raw messages are passed to `onRaw` for recording.
 */
export class CoinbaseLiveSource {
  private queue: MarketEvent[] = [];
  private wake: (() => void) | null = null;
  private ws: WebSocket | null = null;
  private epoch = 0;
  private st: NormalizeState = { epoch: 0, lastSeq: -1, duplicates: 0 };
  private lastMsgAt = 0;
  private stalledUntil = 0;
  private recent: { raw: unknown }[] = [];
  private overflowed = false;
  duplicatesDropped = 0;

  constructor(private readonly o: LiveSourceOptions) {}

  private push(e: MarketEvent): void {
    if (this.queue.length >= (this.o.maxQueue ?? 100_000)) {
      if (!this.overflowed) {
        this.overflowed = true;
        this.queue.push({
          kind: 'connection',
          ordinal: 0,
          epoch: this.epoch,
          receiptTime: Date.now(),
          state: 'error',
          detail: 'queue_overflow',
        });
        this.ws?.close();
      }
      return;
    }
    this.queue.push(e);
    this.wake?.();
  }

  /** Drill: deliberately disconnect for `ms` (a real outage; no data is synthesized). */
  drillDisconnect(ms: number): void {
    this.stalledUntil = Date.now() + ms;
    this.push({ kind: 'drill', ordinal: 0, receiptTime: Date.now(), name: 'disconnect', detail: `${ms}ms` });
    this.ws?.close();
  }

  /** Drill: re-deliver the last `k` raw messages; sequence checks must drop them. */
  drillDuplicate(k: number): void {
    const msgs = this.recent.slice(-k);
    this.push({ kind: 'drill', ordinal: 0, receiptTime: Date.now(), name: 'duplicate', detail: `${msgs.length} messages` });
    for (const r of msgs) this.handleRaw(r.raw, Date.now(), true);
  }

  onRaw: ((raw: unknown, receiptTime: number, epoch: number) => void) | null = null;

  private handleRaw(raw: unknown, receiptTime: number, redelivery = false): void {
    if (!redelivery) {
      this.recent.push({ raw });
      if (this.recent.length > 50) this.recent.shift();
    }
    this.lastMsgAt = receiptTime;
    const before = this.st.duplicates;
    for (const e of normalizeMessage(raw, receiptTime, this.st)) {
      this.push(e);
      if (e.kind === 'seq_gap') this.ws?.close(); // discard the unreliable book; reconnect and resync
    }
    if (this.st.duplicates > before) this.duplicatesDropped += this.st.duplicates - before;
  }

  private connect(signal: AbortSignal): void {
    if (signal.aborted) return;
    checkWebSocket(PUBLIC_WS_URL);
    this.epoch++;
    this.st = { epoch: this.epoch, lastSeq: -1, duplicates: 0 };
    this.overflowed = false;
    const ws = (this.o.wsFactory ?? ((u) => new WebSocket(u)))(PUBLIC_WS_URL);
    this.ws = ws;
    const epoch = this.epoch;
    this.push({ kind: 'connection', ordinal: 0, epoch, receiptTime: Date.now(), state: 'open', detail: 'connecting' });
    ws.onopen = () => {
      for (const channel of ['level2', 'market_trades', 'heartbeats']) {
        const msg = { type: 'subscribe', product_ids: ['BTC-USD'], channel };
        checkSubscribeMessage(msg);
        ws.send(JSON.stringify(msg));
      }
    };
    ws.onmessage = (m) => {
      if (this.ws !== ws) return;
      const receiptTime = Date.now();
      let raw: unknown;
      try {
        raw = JSON.parse(String(m.data));
      } catch {
        return;
      }
      this.onRaw?.(raw, receiptTime, epoch);
      this.handleRaw(raw, receiptTime);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.push({ kind: 'connection', ordinal: 0, epoch, receiptTime: Date.now(), state: 'closed' });
      this.scheduleReconnect(signal);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private attempts = 0;
  private scheduleReconnect(signal: AbortSignal): void {
    if (signal.aborted) return;
    const backoff = Math.min(this.o.reconnectMaxMs, this.o.reconnectMinMs * 2 ** Math.min(this.attempts++, 8));
    const wait = Math.max(backoff, this.stalledUntil - Date.now());
    setTimeout(() => this.connect(signal), wait).unref();
  }

  async *stream(signal: AbortSignal): AsyncGenerator<MarketEvent> {
    this.connect(signal);
    const tick = setInterval(() => {
      const now = Date.now();
      this.push({ kind: 'tick', ordinal: 0, receiptTime: now });
      if (this.ws && this.lastMsgAt && now - this.lastMsgAt > (this.o.silenceMs ?? 30_000)) {
        this.lastMsgAt = now;
        this.ws.close(); // silent socket: reconnect
      }
      if (this.ws && this.st.lastSeq > 5) this.attempts = 0;
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
