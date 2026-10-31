import type { Store } from '../../persistence/store';
import type { TopOfBook } from '../../core/types';
import { log } from '../../core/log';
import {
  altFearGreedHistory,
  binancePrice,
  cmcFearGreedHistory,
  coinpaprikaMarkets,
  coinpaprikaTicker,
  krakenTicker,
  type BtcMarket,
  type PaprikaSnapshot,
} from './providers';

export interface ReferenceQuote {
  source: string;
  price: number;
  ts: number;
}

export interface DivergenceCheck {
  veto: string | null;
  checked: { source: string; price: number; ageMs: number; divergenceBps: number; fresh: boolean }[];
}

/**
 * Data-quality guard: if the trading venue's mid price disagrees with an
 * independent, fresh reference by more than `maxBps`, our feed (or the venue)
 * is wrong or dislocated, so new entries are vetoed. Missing or stale
 * references never veto; the engine's own staleness checks cover outages.
 */
export function divergenceVeto(mid: number, refs: ReferenceQuote[], now: number, maxBps: number, maxAgeMs: number): DivergenceCheck {
  const checked = refs.map((r) => ({
    source: r.source,
    price: r.price,
    ageMs: now - r.ts,
    divergenceBps: (Math.abs(mid - r.price) / r.price) * 10_000,
    fresh: now - r.ts <= maxAgeMs,
  }));
  const bad = checked.filter((c) => c.fresh && c.divergenceBps > maxBps);
  return {
    veto: bad.length ? `price diverges from ${bad.map((b) => `${b.source} by ${b.divergenceBps.toFixed(0)}bps`).join(', ')}` : null,
    checked,
  };
}

export interface ContextOptions {
  binanceBaseUrl: string;
  exchangePollMs: number;
  coinpaprikaPollMs: number;
  fearGreedPollMs: number;
  maxDivergenceBps: number;
  maxReferenceAgeMs: number;
}

export interface ContextStatus {
  refs: ReferenceQuote[];
  paprika: (PaprikaSnapshot & { fetchedAt: number }) | null;
  markets: { fetchedAt: number; top: BtcMarket[]; count: number } | null;
  fearGreed: { source: string; ts: number; score: number } | null;
  errors: Record<string, string>;
}

/**
 * Polls the keyless context sources in the background, keeps the latest
 * values in memory, and persists snapshots (CoinPaprika, Fear & Greed) so a
 * history accumulates for future backtesting of context filters.
 */
export class MarketContextService {
  private running = false;
  readonly status: ContextStatus = { refs: [], paprika: null, markets: null, fearGreed: null, errors: {} };

  constructor(
    private readonly store: Store,
    private readonly o: ContextOptions,
  ) {}

  start(): void {
    this.running = true;
    void this.loop('exchanges', this.o.exchangePollMs, () => this.pollExchanges());
    void this.loop('coinpaprika', this.o.coinpaprikaPollMs, () => this.pollPaprika());
    void this.loop('fearGreed', this.o.fearGreedPollMs, () => this.pollFearGreed());
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  /** Entry veto for the engine. */
  veto(now: number, book: TopOfBook): string | null {
    const mid = (book.bid + book.ask) / 2;
    return divergenceVeto(mid, this.status.refs, now, this.o.maxDivergenceBps, this.o.maxReferenceAgeMs).veto;
  }

  private readonly timers = new Set<NodeJS.Timeout>();

  /** Interruptible, unref'd wait so long poll intervals never keep the process alive after stop(). */
  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.timers.delete(t);
        resolve();
      }, ms);
      t.unref();
      this.timers.add(t);
    });
  }

  private async loop(name: string, everyMs: number, fn: () => Promise<void>): Promise<void> {
    let first = true;
    while (this.running) {
      if (!first) await this.wait(everyMs);
      first = false;
      if (!this.running) break;
      try {
        await fn();
        delete this.status.errors[name];
      } catch (e) {
        if (this.status.errors[name] !== String(e)) log.warn(`market context source failed: ${name}`, { error: String(e) });
        this.status.errors[name] = String(e);
      }
    }
  }

  private setRef(q: ReferenceQuote): void {
    this.status.refs = [...this.status.refs.filter((r) => r.source !== q.source), q];
  }

  async pollExchanges(): Promise<void> {
    const [b, k] = await Promise.allSettled([binancePrice(this.o.binanceBaseUrl), krakenTicker()]);
    const now = Date.now();
    // Binance.US is an independent venue; Kraken REST cross-checks a possibly stuck WebSocket feed.
    if (b.status === 'fulfilled') this.setRef({ source: 'binance.us', price: b.value, ts: now });
    if (k.status === 'fulfilled') this.setRef({ source: 'kraken-rest', price: (k.value.bid + k.value.ask) / 2, ts: now });
    if (b.status === 'rejected' && k.status === 'rejected') throw new Error(`${String(b.reason)}; ${String(k.reason)}`);
  }

  private paprikaPolls = 0;
  async pollPaprika(): Promise<void> {
    const now = Date.now();
    const t = await coinpaprikaTicker();
    this.status.paprika = { ...t, fetchedAt: now };
    this.store.insertContext('coinpaprika.ticker', now, t);
    if (this.paprikaPolls++ % 6 === 0) {
      const m = await coinpaprikaMarkets();
      const top = m.filter((x) => !x.outlier).slice(0, 15);
      this.status.markets = { fetchedAt: now, top, count: m.length };
      this.store.insertContext('coinpaprika.markets', now, { count: m.length, top });
    }
  }

  async pollFearGreed(): Promise<void> {
    let source = 'cmc';
    let series: { ts: number; score: number }[];
    try {
      series = await cmcFearGreedHistory();
    } catch (e) {
      log.warn('CMC fear & greed unavailable; falling back to alternative.me', { error: String(e) });
      source = 'alternative.me';
      series = await altFearGreedHistory(0);
    }
    if (series.length === 0) throw new Error('empty fear & greed series');
    this.store.upsertFearGreed(source, series);
    const last = series.at(-1)!;
    this.status.fearGreed = { source, ...last };
  }
}
