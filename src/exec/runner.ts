import type { AppConfig } from '../config/schema';
import type { Store } from '../persistence/store';
import type { ExchangeAdapter } from './adapter';
import type { MarketInfo } from '../core/types';
import { RiskEngine } from '../risk/engine';
import { HARD_LIMITS } from '../risk/limits';
import { GuardedAdapter } from './guardedAdapter';
import { TradingEngine } from './engine';
import type { Strategy } from '../strategy/types';
import { MarketDataFeed } from '../data/marketData';
import { isKillActive } from '../safety/killSwitch';
import { HEARTBEAT_KEY, type Heartbeat } from '../dashboard/snapshot';
import { log } from '../core/log';
import { sleep } from '../core/util';
import type { PaperAdapter } from './paperAdapter';
import { MarketContextService } from '../data/context/service';

export interface RunOptions {
  mode: 'paper' | 'live';
  cfg: AppConfig;
  strategy: Strategy;
  store: Store;
  stateDir: string;
  feed: MarketDataFeed;
  market: MarketInfo;
  /** Raw adapter; it is always wrapped in the order guard. */
  adapter: ExchangeAdapter;
  paper?: PaperAdapter;
  durationMs?: number;
  flattenOnExit: boolean;
  tickMs?: number;
}

/**
 * Wires feed -> engine and runs the loop until duration, Ctrl+C, or the kill
 * switch. On exit: cancels open orders and (by default) flattens.
 */
export async function runEngine(o: RunOptions): Promise<void> {
  const risk = new RiskEngine(o.store, HARD_LIMITS);
  let lastBid = 0;
  const context = o.cfg.marketContext.enabled ? new MarketContextService(o.store, o.cfg.marketContext) : null;
  const guarded = new GuardedAdapter(o.adapter, risk, o.store, () => lastBid);
  const engine = new TradingEngine(
    o.store,
    risk,
    guarded,
    o.strategy,
    { fees: o.cfg.exchange.fees, spreadBps: 1, takerSlippageBps: o.cfg.paper.takerSlippageBps, stopGapBufferPct: 0.1 },
    {
      mode: o.mode,
      ambiguousGraceMs: o.mode === 'live' ? 30_000 : 0,
      sizeFraction: 0.98,
      balanceSnapshotMs: 60_000,
      killSwitch: () => isKillActive(o.stateDir),
      entryVeto: context ? (now, book) => context.veto(now, book) : undefined,
    },
  );

  let lastAsk = 0;
  o.feed.setHandlers({
    onBook: (b) => {
      lastBid = b.bid;
      lastAsk = b.ask;
      o.paper?.onBook(b);
      engine.onBook(b);
    },
    onCandles: (c) => engine.onCandles(c),
    onPrint: (price, ts) => o.paper?.onPrint(price, ts),
  });

  let stopRequested: 'signal' | null = null;
  const onSignal = () => {
    if (stopRequested) {
      log.error('second interrupt: exiting immediately without cleanup');
      process.exit(2);
    }
    stopRequested = 'signal';
    log.warn('interrupt received; shutting down safely (press Ctrl+C again to force)');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  await o.feed.start();
  context?.start();
  log.info(`${o.mode} engine started`, { exchange: o.cfg.exchange.id, symbol: o.market.symbol, strategy: o.strategy.name, market: o.market });
  o.store.insertEvent(Date.now(), 'info', `${o.mode} engine started: ${o.strategy.name} (pid ${process.pid})`);

  const started = Date.now();
  const tickMs = o.tickMs ?? 1000;
  try {
    while (!engine.isStopped()) {
      await engine.tick();
      const now = Date.now();
      const hb: Heartbeat = {
        ts: now,
        phase: engine.phase(),
        transport: o.feed.status.transport,
        dataAgeMs: o.feed.status.lastBookTs ? now - o.feed.status.lastBookTs : -1,
        stateCertain: engine.isStateCertain(),
        bid: lastBid || null,
        ask: lastAsk || null,
        pid: process.pid,
      };
      o.store.setKv(HEARTBEAT_KEY, hb, now);
      if (stopRequested || (o.durationMs !== undefined && now - started >= o.durationMs)) {
        await engine.shutdown('shutdown', o.flattenOnExit);
        break;
      }
      await sleep(tickMs);
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await o.feed.stop();
    context?.stop();
    o.store.setKv(HEARTBEAT_KEY, { ...(o.store.getKv<Heartbeat>(HEARTBEAT_KEY) ?? {}), phase: 'STOPPED', ts: Date.now() });
    o.store.insertEvent(Date.now(), 'info', `${o.mode} engine stopped`);
    log.info(`${o.mode} engine stopped`);
  }
}
