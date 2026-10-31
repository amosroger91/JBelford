import ccxt, { type Exchange } from 'ccxt';
import type { Candle, MarketInfo, TopOfBook } from '../core/types';
import { log } from '../core/log';
import { sleep } from '../core/util';

export interface FeedHandlers {
  onBook: (b: TopOfBook) => void;
  onCandles: (c: Candle[]) => void;
  onPrint?: (price: number, ts: number) => void;
}

export interface FeedOptions {
  exchangeId: string;
  symbol: string;
  useWebSocket: boolean;
  pollIntervalMs: number;
  candlePollIntervalMs: number;
  bootstrapCandles: number;
}

export interface FeedStatus {
  transport: 'websocket' | 'polling' | 'starting';
  lastBookTs: number;
  lastCandleTs: number;
  wsFailures: number;
}

/**
 * Public market data (no credentials). Order book top via WebSocket
 * (ccxt.pro) when supported, with automatic fallback to REST polling; 1m
 * candles via REST polling (closed bars only). WebSocket is retried after
 * failures with backoff.
 */
export class MarketDataFeed {
  private readonly rest: Exchange;
  private ws: Exchange | null = null;
  private running = false;
  private candles: Candle[] = [];
  readonly status: FeedStatus = { transport: 'starting', lastBookTs: 0, lastCandleTs: 0, wsFailures: 0 };

  private h: FeedHandlers = { onBook: () => {}, onCandles: () => {} };

  constructor(private readonly opts: FeedOptions) {
    const ctor = (ccxt as unknown as Record<string, new (c: object) => Exchange>)[opts.exchangeId];
    if (!ctor) throw new Error(`unknown exchange ${opts.exchangeId}`);
    this.rest = new ctor({ enableRateLimit: true, timeout: 10_000 });
    const pro = (ccxt.pro as unknown as Record<string, new (c: object) => Exchange>)[opts.exchangeId];
    if (opts.useWebSocket && pro) {
      const ws = new pro({ enableRateLimit: true });
      if (ws.has.watchOrderBook) this.ws = ws;
    }
  }

  async loadMarketInfo(fallback: Omit<MarketInfo, 'symbol'>): Promise<MarketInfo> {
    try {
      await this.rest.loadMarkets();
      const m = this.rest.market(this.opts.symbol);
      return {
        symbol: this.opts.symbol,
        minAmount: m.limits.amount?.min ?? fallback.minAmount,
        minCost: m.limits.cost?.min ?? fallback.minCost,
        amountStep: m.precision.amount ?? fallback.amountStep,
        priceTick: m.precision.price ?? fallback.priceTick,
      };
    } catch (e) {
      log.warn('loadMarkets failed; using fallback market info', { error: String(e) });
      return { symbol: this.opts.symbol, ...fallback };
    }
  }

  setHandlers(h: FeedHandlers): void {
    this.h = h;
  }

  async start(): Promise<void> {
    this.running = true;
    await this.pollCandles();
    void this.candleLoop();
    void this.bookLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    try {
      await this.ws?.close();
    } catch {
      /* ignore */
    }
  }

  private emitBook(bid: number | undefined, ask: number | undefined): void {
    if (!bid || !ask || !(ask >= bid)) return;
    const b = { bid, ask, ts: Date.now() };
    this.status.lastBookTs = b.ts;
    this.h.onBook(b);
  }

  private async bookLoop(): Promise<void> {
    let wsRetryAt = 0;
    while (this.running) {
      if (this.ws && Date.now() >= wsRetryAt) {
        try {
          this.status.transport = 'websocket';
          if (this.h.onPrint && this.ws.has.watchTrades) void this.tradesLoop();
          while (this.running) {
            const ob = await this.ws.watchOrderBook(this.opts.symbol, 10);
            this.emitBook(ob.bids[0]?.[0], ob.asks[0]?.[0]);
          }
        } catch (e) {
          if (!this.running) break; // closed by stop(), not a failure
          this.status.wsFailures++;
          const backoff = Math.min(300_000, 5_000 * 2 ** Math.min(this.status.wsFailures, 6));
          wsRetryAt = Date.now() + backoff;
          log.warn('websocket order book failed; falling back to polling', { error: String(e), retryInMs: backoff });
        }
      }
      if (!this.running) break;
      this.status.transport = 'polling';
      try {
        const t = await this.rest.fetchOrderBook(this.opts.symbol, 10);
        this.emitBook(t.bids[0]?.[0], t.asks[0]?.[0]);
      } catch (e) {
        log.warn('order book poll failed', { error: String(e) });
      }
      await sleep(this.opts.pollIntervalMs);
    }
  }

  private tradesLoopActive = false;
  private async tradesLoop(): Promise<void> {
    if (this.tradesLoopActive || !this.ws) return;
    this.tradesLoopActive = true;
    try {
      while (this.running) {
        const trades = await this.ws.watchTrades(this.opts.symbol);
        for (const t of trades) if (t.price && t.timestamp) this.h.onPrint?.(t.price, t.timestamp);
      }
    } catch (e) {
      if (this.running) log.warn('websocket trades stream ended', { error: String(e) });
    } finally {
      this.tradesLoopActive = false;
    }
  }

  private async candleLoop(): Promise<void> {
    while (this.running) {
      await sleep(this.opts.candlePollIntervalMs);
      if (!this.running) break;
      await this.pollCandles();
    }
  }

  private async pollCandles(): Promise<void> {
    try {
      const since = this.candles.length ? this.candles.at(-1)!.ts - 5 * 60_000 : Date.now() - this.opts.bootstrapCandles * 60_000;
      const raw = await this.rest.fetchOHLCV(this.opts.symbol, '1m', since, 1000);
      const now = Date.now();
      const closed: Candle[] = raw
        .filter((r) => (r[0] as number) + 60_000 <= now)
        .map((r) => ({ ts: r[0] as number, open: r[1] as number, high: r[2] as number, low: r[3] as number, close: r[4] as number, volume: r[5] as number }));
      const byTs = new Map(this.candles.map((c) => [c.ts, c]));
      const newOnes: Candle[] = [];
      for (const c of closed) {
        if (!byTs.has(c.ts)) newOnes.push(c);
        byTs.set(c.ts, c);
      }
      this.candles = [...byTs.values()].sort((a, b) => a.ts - b.ts).slice(-this.opts.bootstrapCandles);
      if (this.candles.length) this.status.lastCandleTs = this.candles.at(-1)!.ts;
      if (this.h.onPrint) {
        for (const c of newOnes) {
          this.h.onPrint(c.low, c.ts);
          this.h.onPrint(c.high, c.ts);
        }
      }
      this.h.onCandles(this.candles);
    } catch (e) {
      log.warn('candle poll failed', { error: String(e) });
    }
  }
}
