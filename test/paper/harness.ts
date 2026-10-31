import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePaperConfig, type PaperConfig } from '../../src/paper/config';
import type { MarketEvent, TradeIntent } from '../../src/paper/domain';
import type { ProductMeta } from '../../src/paper/market/coinbase';
import { Recorder } from '../../src/paper/market/recorder';
import { PaperRuntime } from '../../src/paper/runtime';
import { TradingService } from '../../src/paper/service';
import { TradingStore } from '../../src/paper/store';
import type { StrategyInput, StrategyPort, StrategyResult } from '../../src/paper/strategies/types';

/** Product constraints as published for BTC-USD (fixture copy; acceptance tests must not fetch). */
export const PRODUCT: ProductMeta = {
  product_id: 'BTC-USD',
  base_increment: '0.00000001',
  quote_increment: '0.01',
  price_increment: '0.01',
  base_min_size: '0.00000001',
  base_max_size: '3400',
  quote_min_size: '1',
  quote_max_size: '150000000',
  status: 'online',
  trading_disabled: false,
  cancel_only: false,
  limit_only: false,
  post_only: false,
  is_disabled: false,
  product_type: 'SPOT',
};

export function testConfig(over: Record<string, unknown> = {}, dir?: string): PaperConfig {
  const base = {
    mode: 'paper',
    venue: 'coinbase',
    product: 'BTC-USD',
    purpose: 'acceptance test fixture (synthetic timestamps; not a live run)',
    initialBalances: { usd: '10000', btc: '0' },
    strategy: { id: 'cash', params: {} },
    decision: { barSeconds: 300, timeoutMs: 2000, intentTtlMs: 60000, coalesce: 'skip' },
    execution: { model: 'ioc-depth-walk-v1', delayMs: 750, participation: '1', guardBps: 50 },
    fees: { version: 'test', takerRate: '0.009', makerRate: '0.005', source: 'fixture', asOf: '2026-10-31', verified: false },
    risk: {
      version: 'risk-test',
      maxExposure: '0.20',
      maxOrderPctEquity: '0.05',
      dailyLossPausePct: '0.02',
      drawdownPausePct: '0.05',
      maxSpreadBps: 10,
      minTouchDepthUsd: '1',
      maxOrdersPerHour: 12,
      maxOpenOrders: 1,
      minRebalancePctEquity: '0.005',
      operatingCostBudgetUsd: '0',
    },
    feed: { staleMs: 5000, maxClockSkewMs: 5000, tickMs: 1000, reconnectMinMs: 1000, reconnectMaxMs: 30000 },
    recording: { dir: dir ?? join(mkdtempSync(join(tmpdir(), 'jb-rec-')), 'rec'), segmentSeconds: 60 },
    storage: { db: ':memory:' },
    readiness: {
      version: 'qual-test',
      minDays: 60,
      minRoundTrips: 100,
      minCoveragePct: 95,
      minContinuousHours: 24,
      bootstrapBlockDays: 5,
      bootstrapSamples: 500,
      confidence: 0.95,
    },
  };
  return parsePaperConfig(deepMerge(base, over));
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object'
        ? deepMerge(a[k] as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return out;
}

/** A strategy whose target weight the test controls; synchronous like the deterministic rules. */
export class ScriptedStrategy implements StrategyPort {
  readonly id = 'scripted';
  readonly kind = 'deterministic' as const;
  readonly paid = false;
  readonly warmupBars = 0;
  target: number | 'hold' = 'hold';
  /** Intent time-to-live relative to the snapshot time (negative = already expired). */
  ttlMs = 60_000;
  calls: StrategyInput[] = [];
  decideSync(input: StrategyInput): StrategyResult {
    this.calls.push(input);
    const intent: TradeIntent =
      this.target === 'hold'
        ? { decisionId: '', snapshotId: input.snapshotId, action: 'hold', validUntil: input.asOf + this.ttlMs, rationale: 'scripted hold' }
        : {
            decisionId: '',
            snapshotId: input.snapshotId,
            action: 'target',
            targetWeight: this.target.toFixed(6),
            validUntil: input.asOf + this.ttlMs,
            rationale: 'scripted',
          };
    return { outcome: 'ok', intent };
  }
  async decide(input: StrategyInput): Promise<StrategyResult> {
    return this.decideSync(input);
  }
}

export const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);

export interface Harness {
  store: TradingStore;
  svc: TradingService;
  rt: PaperRuntime;
  cfg: PaperConfig;
  sessionId: string;
  recorder: Recorder | null;
  t: number;
  ev: (e: Omit<MarketEvent, 'ordinal'> & { receiptTime?: number }) => void;
  snapshot: (bids: [string, string][], asks: [string, string][], epoch?: number) => void;
  update: (side: 'bid' | 'ask', price: string, qty: string) => void;
  trade: (price: string, size: string, exchangeTime?: number) => void;
  tick: (ms?: number) => void;
  /** Advance time with a fresh book update (keeps the feed healthy), then tick. */
  freshTick: (ms: number, side?: 'bid' | 'ask', price?: string, qty?: string) => void;
  advance: (ms: number) => void;
  /** Complete the current 5-minute bar (trades + clock past end+grace), triggering a decision. */
  completeBar: (price?: string) => void;
}

export function harness(
  o: {
    cfg?: PaperConfig;
    strategy?: StrategyPort | null;
    record?: boolean;
    store?: TradingStore;
    sessionId?: string;
    mode?: 'forward' | 'replay';
  } = {},
): Harness {
  const cfg = o.cfg ?? testConfig();
  const store = o.store ?? new TradingStore(':memory:');
  const svc = new TradingService(store);
  const sessionId = o.sessionId ?? svc.createSession(cfg, PRODUCT, { kind: 'forward', now: T0, id: o.store ? undefined : 'ps-test' });
  const recorder = o.record ? new Recorder(cfg.recording.dir, sessionId, sessionId, cfg.recording.segmentSeconds * 1000, false) : null;
  const rt = new PaperRuntime(store, cfg, sessionId, PRODUCT, {
    mode: o.mode ?? 'forward',
    strategy: o.strategy === undefined ? new ScriptedStrategy() : o.strategy,
    recorder,
  });
  let seq = 0;
  const h: Harness = {
    store,
    svc,
    rt,
    cfg,
    sessionId,
    recorder,
    t: T0,
    ev: (e) => rt.ingest({ ...(e as MarketEvent), ordinal: 0, receiptTime: e.receiptTime ?? h.t }),
    snapshot: (bids, asks, epoch = 1) => {
      h.ev({ kind: 'connection', epoch, state: 'open' } as MarketEvent);
      h.ev({
        kind: 'book_snapshot',
        epoch,
        seq: seq++,
        exchangeTime: h.t,
        bids: bids.map(([price, qty]) => ({ price, qty })),
        asks: asks.map(([price, qty]) => ({ price, qty })),
      } as MarketEvent);
    },
    update: (side, price, qty) =>
      h.ev({ kind: 'book_update', epoch: 1, seq: seq++, exchangeTime: h.t, changes: [{ side, price, qty }] } as MarketEvent),
    trade: (price, size, exchangeTime) =>
      h.ev({
        kind: 'trade',
        epoch: 1,
        seq: seq++,
        exchangeTime: exchangeTime ?? h.t,
        tradeId: `tr-${seq}`,
        price,
        size,
        venueSide: 'BUY',
      } as MarketEvent),
    tick: (ms = 1000) => {
      h.t += ms;
      h.ev({ kind: 'tick' } as MarketEvent);
    },
    freshTick: (ms, side = 'bid', price = '1', qty = '0') => {
      h.t += ms;
      h.update(side, price, qty);
      h.ev({ kind: 'tick' } as MarketEvent);
    },
    advance: (ms) => {
      h.t += ms;
    },
    completeBar: (price = '80000') => {
      const barStart = Math.floor(h.t / 300_000) * 300_000;
      h.trade(price, '0.01', barStart + 1000);
      h.t = barStart + 300_000 + 2_000; // end + grace
      h.update('bid', '1', '0'); // any market event advances the bar clock
    },
  };
  return h;
}

/** Minimal started session with a healthy two-sided book. */
export function started(o: Parameters<typeof harness>[0] = {}): Harness {
  const h = harness(o);
  h.ev({ kind: 'lifecycle', state: 'started' } as MarketEvent);
  h.t += 1000;
  return h;
}
