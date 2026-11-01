import type { PaperConfig } from './config';
import type { ControlAction, FeedHealth, MarketEvent, RecordedDecision, SessionStatus } from './domain';
import { SESSION_TRANSITIONS, assertTransition } from './domain';
import { PaperBroker } from './execution/paper';
import { BarBuilder } from './features';
import { Ledger } from './ledger';
import { OrderBook } from './market/book';
import type { ProductMeta } from './market/coinbase';
import type { Recorder } from './market/recorder';
import { ONE, ZERO, dec, div, mul, str, type Dec } from './money';
import { evaluateIntent } from './risk';
import { BracketManager } from './bracket';
import type { TradingStore } from './store';
import type { StrategyInput, StrategyPort } from './strategies/types';

export interface RuntimeOptions {
  mode: 'forward' | 'replay';
  /** Forward mode: invoke the strategy. Replay: apply recorded decision_ready events verbatim. */
  strategy: StrategyPort | null;
  recorder: Recorder | null;
  /** Called once the runtime has stopped (stop control, duration, abort). */
  onStatus?: (s: RuntimeStatus) => void;
  /** Forward mode: poll the controls table for CLI/dashboard requests. */
  pollControls?: boolean;
  leaseOwner?: string;
}

export interface RuntimeStatus {
  sessionId: string;
  status: SessionStatus;
  feed: FeedHealth;
  ordinal: number;
  lastEventTime: number;
  bestBid: string | null;
  bestAsk: string | null;
  lastTrade: string | null;
  bookLevels: { bids: number; asks: number };
  epoch: number;
  reconnects: number;
  seqGaps: number;
  duplicatesDropped: number;
  lateTrades: number;
  skippedDecisions: number;
  inFlightDecision: string | null;
  generation: number;
  recorderDurableOrdinal: number;
  recorderFailed: string | null;
}

/**
 * Single-owner event loop (plan sections 3-4). Every input, including clock
 * ticks, strategy completions, controls and lifecycle changes, is an event
 * with an ordinal, recorded BEFORE it is processed. Replay feeds the recorded
 * events through this same code, so live and replay share execution, risk and
 * accounting exactly. Receipt time is the only clock.
 */
export class PaperRuntime {
  readonly ledger: Ledger;
  readonly book = new OrderBook();
  readonly bars = new BarBuilder();
  private readonly brackets: BracketManager;
  private readonly broker: PaperBroker;
  private status: SessionStatus;
  private feed: FeedHealth = 'connecting';
  private ordinal: number;
  private lastTime = 0;
  private lastMsgTime = 0;
  private lastTrade: string | null = null;
  private epoch = 0;
  private reconnects = 0;
  private seqGaps = 0;
  private skipped = 0;
  private generation: number;
  private inFlight: { decisionId: string; snapshotId: string; generation: number } | null = null;
  private readonly internal: MarketEvent[] = [];
  private lastValuationAt = 0;
  private stopRequested = false;
  private positionSince: number | null = null;
  private openGap: number | null = null;
  duplicatesDropped = 0;

  constructor(
    private readonly store: TradingStore,
    private readonly cfg: PaperConfig,
    readonly sessionId: string,
    private readonly product: ProductMeta,
    private readonly o: RuntimeOptions,
  ) {
    this.ledger = new Ledger(store);
    const s = store.get('SELECT status, generation, last_ordinal, last_event_time FROM sessions WHERE id = ?', sessionId);
    if (!s) throw new Error(`unknown session ${sessionId}`);
    this.status = s.status as SessionStatus;
    this.generation = s.generation as number;
    this.ordinal = s.last_ordinal as number;
    this.lastTime = (s.last_event_time as number | null) ?? 0;
    this.broker = new PaperBroker({
      takerRate: dec(cfg.fees.takerRate),
      makerRate: dec(cfg.fees.makerRate),
      participation: dec(cfg.execution.participation),
      guardBps: cfg.execution.guardBps,
      baseIncrement: dec(product.base_increment),
      baseMinSize: dec(product.base_min_size),
    });
    this.brackets = new BracketManager(store, this.ledger, cfg, product, sessionId);
    const held = this.ledger.balances(sessionId);
    if (held.btcAvailable + held.btcReserved > ZERO) {
      const firstBuy = store.get("SELECT MIN(time) AS t FROM fills WHERE session_id = ? AND side = 'buy'", sessionId);
      this.positionSince = (firstBuy?.t as number | null) ?? null;
    }
  }

  // ---------- public views ----------

  snapshotStatus(): RuntimeStatus {
    const b = this.book.summary();
    return {
      sessionId: this.sessionId,
      status: this.status,
      feed: this.feed,
      ordinal: this.ordinal,
      lastEventTime: this.lastTime,
      bestBid: b.bestBid,
      bestAsk: b.bestAsk,
      lastTrade: this.lastTrade,
      bookLevels: this.book.depthCount(),
      epoch: this.epoch,
      reconnects: this.reconnects,
      seqGaps: this.seqGaps,
      duplicatesDropped: this.duplicatesDropped,
      lateTrades: this.bars.lateTrades,
      skippedDecisions: this.skipped,
      inFlightDecision: this.inFlight?.decisionId ?? null,
      generation: this.generation,
      recorderDurableOrdinal: this.o.recorder?.durableOrdinal ?? 0,
      recorderFailed: this.o.recorder?.failed ?? null,
    };
  }

  isStopped(): boolean {
    return ['stopped', 'failed', 'completed'].includes(this.status);
  }

  // ---------- event ingestion ----------

  /** Queue an internally generated event (strategy completion, control, drill, lifecycle). */
  enqueue(e: MarketEvent): void {
    this.internal.push(e);
  }

  /**
   * Ingest one event: assign ordinal (forward) or verify it (replay), record it
   * durably, process it, then drain internally generated events.
   */
  ingest(e: MarketEvent): void {
    this.accept(e);
    while (this.internal.length && !this.isStopped()) this.accept(this.internal.shift()!);
  }

  private accept(e: MarketEvent): void {
    if (this.o.mode === 'forward') {
      e.ordinal = ++this.ordinal;
      if (e.receiptTime < this.lastTime) e.receiptTime = this.lastTime; // keep the clock monotonic
      try {
        this.o.recorder?.append(e);
      } catch (err) {
        this.coverageFailure(`recording failed: ${String(err)}`, e.receiptTime);
        return;
      }
    } else {
      if (e.ordinal <= this.ordinal) throw new Error(`replay ordinal ${e.ordinal} not after ${this.ordinal}`);
      this.ordinal = e.ordinal;
    }
    this.lastTime = Math.max(this.lastTime, e.receiptTime);
    this.process(e);
    this.store.run('UPDATE sessions SET last_ordinal = ?, last_event_time = ? WHERE id = ?', this.ordinal, this.lastTime, this.sessionId);
  }

  private setFeed(state: FeedHealth, time: number, detail?: string): void {
    if (this.feed === state) return;
    this.feed = state;
    this.store.run(
      'INSERT INTO feed_health (session_id, time, state, detail) VALUES (?, ?, ?, ?)',
      this.sessionId,
      time,
      state,
      detail ?? null,
    );
    if (state === 'healthy') {
      if (this.openGap !== null) {
        this.store.run('UPDATE observation_gaps SET end_time = ? WHERE session_id = ? AND end_time IS NULL', time, this.sessionId);
        this.openGap = null;
      }
    } else if (['stale', 'gap', 'disconnected'].includes(state) && this.openGap === null) {
      this.openGap = time;
      this.store.run(
        'INSERT INTO observation_gaps (session_id, start_time, reason) VALUES (?, ?, ?)',
        this.sessionId,
        time,
        `${state}${detail ? `: ${detail}` : ''}`,
      );
    }
  }

  private invalidateBook(state: FeedHealth, time: number, detail: string): void {
    this.book.reset();
    this.broker.resetConsumption();
    this.setFeed(state, time, detail);
  }

  private process(e: MarketEvent): void {
    switch (e.kind) {
      case 'connection':
        if (e.state === 'open') {
          this.epoch = e.epoch;
          if (this.reconnects++ > 0) this.store.audit(this.sessionId, e.receiptTime, e.ordinal, 'reconnect', { epoch: e.epoch });
          this.invalidateBook('connecting', e.receiptTime, `epoch ${e.epoch}`);
        } else if (e.state === 'subscribed') {
          if (!this.book.synced) this.setFeed('synchronizing', e.receiptTime);
        } else {
          this.invalidateBook('disconnected', e.receiptTime, e.detail ?? e.state);
        }
        break;
      case 'seq_gap':
        this.seqGaps++;
        this.store.audit(this.sessionId, e.receiptTime, e.ordinal, 'seq_gap', { expected: e.expected, got: e.got, epoch: e.epoch });
        this.invalidateBook('gap', e.receiptTime, `sequence gap ${e.expected} -> ${e.got}`);
        break;
      case 'book_snapshot':
        this.lastMsgTime = e.receiptTime;
        this.book.loadSnapshot(e.bids, e.asks);
        this.broker.resetConsumption();
        if (this.book.crossed()) this.invalidateBook('gap', e.receiptTime, 'crossed snapshot');
        else this.setFeed('healthy', e.receiptTime, `snapshot ${e.bids.length}/${e.asks.length} levels`);
        break;
      case 'book_update':
        this.lastMsgTime = e.receiptTime;
        if (!this.book.synced) break;
        for (const c of e.changes) {
          this.book.set(c.side, dec(c.price), dec(c.qty));
          this.broker.onLevelChange(c.side, c.price);
        }
        if (this.book.crossed()) this.invalidateBook('gap', e.receiptTime, 'crossed book');
        else if (this.feed === 'stale') this.setFeed('healthy', e.receiptTime, 'updates resumed');
        break;
      case 'trade':
        this.lastMsgTime = e.receiptTime;
        this.lastTrade = e.price;
        // Coinbase bars are built from trades; Binance.US bars come from the venue's closed klines.
        if (this.cfg.venue === 'coinbase') this.bars.onTrade(e.tradeId, e.price, e.size, e.exchangeTime);
        this.fillLimitsFromTrade(dec(e.price), dec(e.size), e.receiptTime, e.ordinal);
        break;
      case 'bar': {
        const before = this.bars.lastCompletedStart();
        this.bars.seed([e.candle]);
        if (this.bars.lastCompletedStart() !== before) this.onBarCompleted(e.candle.start, e.receiptTime, e.ordinal);
        break;
      }
      case 'heartbeat':
        this.lastMsgTime = e.receiptTime;
        if (Math.abs(e.receiptTime - e.exchangeTime) > this.cfg.feed.maxClockSkewMs && this.feed === 'healthy') {
          this.setFeed('stale', e.receiptTime, `clock skew ${e.receiptTime - e.exchangeTime}ms`);
        }
        break;
      case 'tick':
        this.onTick(e.receiptTime, e.ordinal);
        break;
      case 'warmup_candles':
        this.bars.seed(e.candles);
        this.store.audit(this.sessionId, e.receiptTime, e.ordinal, 'warmup', { candles: e.candles.length });
        break;
      case 'decision_ready':
        this.onDecision(e.decision, e.receiptTime, e.ordinal);
        break;
      case 'control':
        this.onControl(e.action, e.requestId, e.receiptTime, e.ordinal);
        break;
      case 'drill':
        this.store.audit(this.sessionId, e.receiptTime, e.ordinal, 'drill', { name: e.name, detail: e.detail });
        break;
      case 'lifecycle':
        this.onLifecycle(e.state, e.receiptTime, e.ordinal, e.detail);
        break;
    }
    if (e.kind === 'book_snapshot' || e.kind === 'book_update' || e.kind === 'tick') {
      this.fillLimitsFromBook(e.receiptTime, e.ordinal);
      this.executeDue(e.receiptTime, e.ordinal);
    }
    if (e.kind === 'book_snapshot' || e.kind === 'book_update' || e.kind === 'tick' || e.kind === 'trade' || e.kind === 'control') {
      this.brackets.manage(this.book, e.receiptTime, e.ordinal, this.status === 'running' && this.feed === 'healthy' && this.book.synced);
    }
    if (e.kind === 'trade' || e.kind === 'tick' || e.kind === 'book_update') {
      for (const bar of this.bars.advance(e.receiptTime)) this.onBarCompleted(bar.start, e.receiptTime, e.ordinal);
    }
  }

  private onTick(time: number, ordinal: number): void {
    if (this.feed === 'healthy' && this.lastMsgTime && time - this.lastMsgTime > this.cfg.feed.staleMs) {
      this.setFeed('stale', time, `no market data for ${time - this.lastMsgTime}ms`);
    }
    if (time - this.lastValuationAt >= 60_000) this.valuation(time, ordinal);
    if (this.o.recorder) {
      try {
        this.o.recorder.flush();
      } catch (err) {
        this.coverageFailure(`recorder flush failed: ${String(err)}`, time);
      }
    }
  }

  private coverageFailure(reason: string, time: number): void {
    this.store.audit(this.sessionId, time, this.ordinal, 'coverage_failure', { reason });
    this.store.run('INSERT INTO observation_gaps (session_id, start_time, reason) VALUES (?, ?, ?)', this.sessionId, time, reason);
    if (this.status === 'running') this.transition('paused', time, reason);
  }

  // ---------- lifecycle ----------

  private transition(to: SessionStatus, time: number, reason?: string): void {
    if (this.status === to) return;
    assertTransition(SESSION_TRANSITIONS, this.status, to, 'session');
    this.status = to;
    this.generation++;
    this.store.run(
      'UPDATE sessions SET status = ?, generation = ?, pause_reason = ?, started_at = COALESCE(started_at, ?), ended_at = ? WHERE id = ?',
      to,
      this.generation,
      to === 'paused' ? (reason ?? null) : null,
      time,
      ['stopped', 'failed', 'completed'].includes(to) ? time : null,
      this.sessionId,
    );
    this.store.audit(this.sessionId, time, this.ordinal, 'session_status', { status: to, reason, generation: this.generation });
    if (to !== 'running') this.inFlight = null;
  }

  private onLifecycle(state: 'started' | 'restarted' | 'stopping', time: number, ordinal: number, detail?: string): void {
    this.store.audit(this.sessionId, time, ordinal, `lifecycle_${state}`, { detail });
    if (state === 'started' && this.status === 'created') this.transition('running', time);
    if (state === 'restarted') {
      // A restart never invents fills for the unobserved outage; the gap is disclosed.
      this.generation++;
      this.store.run('UPDATE sessions SET generation = ? WHERE id = ?', this.generation, this.sessionId);
      this.invalidateBook('disconnected', time, 'process restart');
      this.inFlight = null;
    }
    if (state === 'stopping') {
      this.stopRequested = true;
      this.valuation(time, ordinal); // closing mark is part of the recorded stream, so replay reproduces it
      // The process stops observing the market here. Anything recorded later (an offline control)
      // must see no book, in the original run and in replay alike.
      this.invalidateBook('disconnected', time, 'runtime stopping');
    }
  }

  private onControl(action: ControlAction, requestId: string, time: number, ordinal: number): void {
    this.store.audit(this.sessionId, time, ordinal, 'control', { action, requestId });
    if (action === 'pause' && this.status === 'running') {
      this.transition('paused', time, 'operator pause');
      this.cancelOpen(time, ordinal, 'operator pause');
    } else if (action === 'resume' && this.status === 'paused') {
      this.transition('running', time);
    } else if (action === 'stop' && !this.isStopped()) {
      this.cancelOpen(time, ordinal, 'operator stop');
      this.transition('stopped', time, 'operator stop');
      this.valuation(time, ordinal);
    } else if (action === 'flatten') {
      this.flatten(requestId, time, ordinal);
    }
    this.store.run("UPDATE controls SET status = 'applied', applied_at = ? WHERE request_id = ?", time, requestId);
  }

  private cancelOpen(time: number, ordinal: number, reason: string): void {
    for (const o of this.ledger.openOrders(this.sessionId))
      this.ledger.close(this.sessionId, o.orderId, 'cancelled', time, ordinal, reason);
  }

  /** Explicit simulated liquidation: only with healthy executable data; never at a fictional price. */
  private flatten(requestId: string, time: number, ordinal: number): void {
    const b = this.ledger.balances(this.sessionId);
    const bid = this.book.bestBid();
    if (b.btcAvailable === ZERO) return this.store.audit(this.sessionId, time, ordinal, 'flatten_noop', { reason: 'no available BTC' });
    if (this.feed !== 'healthy' || !bid) {
      return this.store.audit(this.sessionId, time, ordinal, 'flatten_deferred', {
        reason: `feed ${this.feed}: no healthy executable data`,
      });
    }
    this.cancelOpen(time, ordinal, 'flatten requested');
    const g = dec(String(this.cfg.execution.guardBps / 10_000));
    const orderId = `o-flatten-${requestId}`;
    this.ledger.submit(
      {
        orderId,
        clientOrderId: `${this.sessionId}:flatten:${requestId}`,
        sessionId: this.sessionId,
        decisionId: `flatten-${requestId}`,
        side: 'sell',
        qty: str(b.btcAvailable),
        guardPrice: str(mul(bid.price, ONE - g, 'ceil')),
        reserved: str(b.btcAvailable),
        submittedAt: time,
        arrivalAt: time + this.cfg.execution.delayMs,
        validUntil: time + this.cfg.decision.intentTtlMs,
        policyVersion: this.cfg.risk.version,
        snapshotId: `flatten-${requestId}`,
        purpose: 'flatten',
      },
      ordinal,
    );
  }

  // ---------- decisions ----------

  private onBarCompleted(barStart: number, time: number, ordinal: number): void {
    if (this.o.mode === 'replay' || !this.o.strategy) return; // replay applies recorded decisions
    if (this.status !== 'running') return;
    const decisionId = `d-${barStart}`;
    if (this.inFlight) {
      this.skipped++;
      this.store.audit(this.sessionId, time, ordinal, 'decision_skipped', {
        decisionId,
        reason: `decision ${this.inFlight.decisionId} still in flight`,
      });
      return;
    }
    const bars = this.bars.completed(Math.max(this.o.strategy.warmupBars + 10, 300));
    if (bars.length < this.o.strategy.warmupBars) {
      this.store.audit(this.sessionId, time, ordinal, 'decision_skipped', {
        decisionId,
        reason: `warming up (${bars.length}/${this.o.strategy.warmupBars} bars)`,
      });
      return;
    }
    const snapshotId = `s-${barStart}-${ordinal}`;
    const input = this.buildInput(snapshotId, barStart + this.bars.barMs, bars, time);
    const gen = this.generation;
    this.inFlight = { decisionId, snapshotId, generation: gen };
    const requestedAt = time;
    const strategy = this.o.strategy;
    const ctrl = new AbortController();
    const finish = (r: Awaited<ReturnType<StrategyPort['decide']>>, completedAt: number) => {
      const decision: RecordedDecision = {
        decisionId,
        snapshotId,
        generation: gen,
        strategy: strategy.id,
        requestedAt,
        completedAt,
        intent: r.intent ? { ...r.intent, decisionId } : null,
        outcome: r.outcome,
        detail: r.detail,
        model: r.model,
      };
      this.enqueue({ kind: 'decision_ready', ordinal: 0, receiptTime: completedAt, decision });
    };
    if (strategy.kind === 'deterministic' && 'decideSync' in strategy) {
      // Deterministic rules are synchronous; completion time is the triggering event time.
      finish(
        (strategy as unknown as { decideSync(i: StrategyInput): Awaited<ReturnType<StrategyPort['decide']>> }).decideSync(input),
        time,
      );
    } else {
      // Never await a model inside the feed loop: the result re-enters as an event.
      void strategy.decide(input, ctrl.signal).then(
        (r) => finish(r, Math.max(Date.now(), this.lastTime)),
        (err) => finish({ intent: null, outcome: 'error', detail: String(err) }, Math.max(Date.now(), this.lastTime)),
      );
    }
  }

  private buildInput(snapshotId: string, asOf: number, bars: ReturnType<BarBuilder['completed']>, time: number): StrategyInput {
    const b = this.ledger.balances(this.sessionId);
    const mid = this.book.midpoint();
    const equity = this.equity(mid);
    const held = b.btcAvailable + b.btcReserved;
    return {
      snapshotId,
      sessionId: this.sessionId,
      generation: this.generation,
      asOf: Math.max(asOf, time),
      bars,
      bestBid: this.book.bestBid() ? str(this.book.bestBid()!.price) : null,
      bestAsk: this.book.bestAsk() ? str(this.book.bestAsk()!.price) : null,
      feedHealth: this.feed,
      balances: this.ledger.view(this.sessionId),
      exposureWeight: mid && equity > ZERO ? str(div(mul(held, mid), equity)) : '0',
      openOrders: this.ledger.openOrders(this.sessionId).length,
      limits: { maxExposure: this.cfg.risk.maxExposure, maxOrderPctEquity: this.cfg.risk.maxOrderPctEquity },
      fees: { takerRate: this.cfg.fees.takerRate },
      positionSince: held > ZERO ? (this.positionSince ?? time) : null,
      weight: mid && equity > ZERO ? Number(str(div(mul(held, mid), equity))) : 0,
    };
  }

  private onDecision(d: RecordedDecision, time: number, ordinal: number): void {
    this.store.run(
      `INSERT OR IGNORE INTO decisions (decision_id, session_id, snapshot_id, generation, strategy, requested_at, completed_at, outcome, intent_json, detail, model_json, event_ordinal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      d.decisionId,
      this.sessionId,
      d.snapshotId,
      d.generation,
      d.strategy,
      d.requestedAt,
      d.completedAt,
      d.outcome,
      d.intent ? JSON.stringify(d.intent) : null,
      d.detail ?? null,
      d.model ? JSON.stringify(d.model) : null,
      ordinal,
    );
    if (d.model) {
      this.store.run(
        'INSERT INTO model_calls (session_id, decision_id, provider, model, request_hash, response_hash, latency_ms, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        this.sessionId,
        d.decisionId,
        d.model.provider,
        d.model.model,
        d.model.requestHash,
        d.model.responseHash,
        d.model.latencyMs,
        d.model.inputTokens ?? null,
        d.model.outputTokens ?? null,
        null,
      );
    }
    if (this.inFlight?.decisionId === d.decisionId) this.inFlight = null;
    if (this.status !== 'running') {
      this.riskEvent(d.decisionId, 'lifecycle', false, `session ${this.status}: decision ignored`, time, ordinal);
      return;
    }
    if (d.intent?.bracket && this.brackets.active().length > 0) {
      this.riskEvent(d.decisionId, 'bracket', false, 'a bracket is already open (one position at a time)', time, ordinal);
      return;
    }
    const b = this.ledger.balances(this.sessionId);
    const open = this.ledger.openOrders(this.sessionId);
    const mid = this.book.midpoint();
    const equity = this.equity(mid);
    const v = this.store.get('SELECT day_start_equity, hwm_equity FROM sessions WHERE id = ?', this.sessionId)!;
    const cost = this.operatingCost();
    const res = evaluateIntent(
      d.outcome === 'ok' ? d.intent : null,
      {
        sessionId: this.sessionId,
        now: time,
        decisionCompletedAt: d.completedAt,
        generation: d.generation,
        currentGeneration: this.generation,
        expectedSnapshotId: d.snapshotId,
        feed: this.feed,
        bookSynced: this.book.synced,
        bestBid: this.book.bestBid()?.price ?? null,
        bestAsk: this.book.bestAsk()?.price ?? null,
        touchDepthUsd: { bid: this.book.touchDepthUsd('bid'), ask: this.book.touchDepthUsd('ask') },
        usdAvailable: b.usdAvailable,
        btcAvailable: b.btcAvailable,
        btcHeld: b.btcAvailable + b.btcReserved,
        pendingBuyQty: open.filter((o) => o.side === 'buy').reduce((a, o) => a + (o.qty - o.filledQty), ZERO),
        pendingSellQty: open.filter((o) => o.side === 'sell').reduce((a, o) => a + (o.qty - o.filledQty), ZERO),
        equity,
        dayStartEquity: v.day_start_equity ? dec(v.day_start_equity as string) : equity,
        hwmEquity: v.hwm_equity ? dec(v.hwm_equity as string) : equity,
        openOrders: open.length,
        ordersLastHour:
          (this.store.get('SELECT COUNT(*) AS n FROM orders WHERE session_id = ? AND submitted_at > ?', this.sessionId, time - 3_600_000)!
            .n as number) ?? 0,
        knownOperatingCostUsd: cost.known,
        operatingCostUnknown: cost.unknown,
        usesPaidModel: this.o.strategy?.paid ?? d.model !== undefined,
        paused: false,
      },
      this.cfg,
      this.product,
    );
    for (const c of res.checks) this.riskEvent(d.decisionId, c.name, c.passed, c.detail, time, ordinal);
    if (!res.order) {
      this.riskEvent(d.decisionId, 'no_order', true, res.noOrderReason ?? 'no order', time, ordinal);
      return;
    }
    const orderId = `o-${d.decisionId}`;
    try {
      if (d.intent?.bracket) this.brackets.submitEntry(res.order, d.intent.bracket, this.book, time, ordinal);
      else this.ledger.submit({ ...res.order, orderId, clientOrderId: `${this.sessionId}:${d.decisionId}` }, ordinal);
    } catch (err) {
      this.riskEvent(d.decisionId, 'submit', false, String(err), time, ordinal);
    }
  }

  private riskEvent(decisionId: string, name: string, passed: boolean, detail: string, time: number, ordinal: number): void {
    this.store.run(
      'INSERT INTO risk_events (session_id, decision_id, check_name, passed, detail, time, event_ordinal) VALUES (?, ?, ?, ?, ?, ?, ?)',
      this.sessionId,
      decisionId,
      name,
      passed ? 1 : 0,
      detail,
      time,
      ordinal,
    );
  }

  private operatingCost(): { known: Dec; unknown: boolean } {
    let known = ZERO;
    let unknown = false;
    for (const r of this.store.all('SELECT cost_usd FROM model_calls WHERE session_id = ?', this.sessionId)) {
      if (r.cost_usd === null) unknown = true;
      else known += dec(r.cost_usd as string);
    }
    return { known, unknown };
  }

  // ---------- execution ----------

  /** Execute IOC orders whose simulated arrival time has passed, against the current healthy book. */
  /** Resting post-only limits that are live at the venue (activated after arrival). */
  private restingLimits() {
    return this.ledger.openOrders(this.sessionId).filter((o) => o.orderType === 'limit' && o.activatedAt !== null && o.limitPrice !== null);
  }

  private fillLimit(o: ReturnType<PaperRuntime['restingLimits']>[number], fill: import('./domain').FillRecord | null): void {
    if (!fill) return;
    this.o.recorder?.flush();
    this.ledger.applyFill(fill);
    const b = this.ledger.balances(this.sessionId);
    const held = b.btcAvailable + b.btcReserved;
    if (held === ZERO) this.positionSince = null;
    else if (this.positionSince === null) this.positionSince = fill.time;
    void o;
  }

  private restingInput(o: ReturnType<PaperRuntime['restingLimits']>[number], time: number, ordinal: number) {
    const priorFills =
      (this.store.get('SELECT COUNT(*) AS n FROM fills WHERE session_id = ? AND order_id = ?', this.sessionId, o.orderId)!.n as number) ??
      0;
    return {
      orderId: o.orderId,
      sessionId: this.sessionId,
      side: o.side,
      limit: o.limitPrice!,
      remaining: o.qty - o.filledQty,
      priorFills,
      time,
      ordinal,
    };
  }

  private fillLimitsFromTrade(price: Dec, size: Dec, time: number, ordinal: number): void {
    if (this.feed !== 'healthy') return; // never fill on data we do not trust
    for (const o of this.restingLimits()) this.fillLimit(o, this.broker.onTradeForLimit(this.restingInput(o, time, ordinal), price, size));
  }

  private fillLimitsFromBook(time: number, ordinal: number): void {
    if (this.feed !== 'healthy' || !this.book.synced) return;
    for (const o of this.restingLimits()) this.fillLimit(o, this.broker.onBookForLimit(this.book, this.restingInput(o, time, ordinal)));
  }

  private executeDue(time: number, ordinal: number): void {
    for (const o of this.ledger.openOrders(this.sessionId)) {
      if (time > o.validUntil) {
        this.ledger.close(
          this.sessionId,
          o.orderId,
          'expired',
          time,
          ordinal,
          'not executable before expiry (no healthy book after arrival)',
        );
        continue;
      }
      if (time < o.arrivalAt || o.status !== 'accepted') continue;
      if (this.feed !== 'healthy' || !this.book.synced) continue; // wait for healthy data; never fill in an outage
      if (o.orderType === 'limit') {
        if (o.activatedAt !== null) continue;
        const violation = this.broker.postOnlyViolation(this.book, o.side, o.limitPrice!);
        if (violation) this.ledger.close(this.sessionId, o.orderId, 'rejected', time, ordinal, violation);
        else this.store.run('UPDATE orders SET activated_at = ? WHERE session_id = ? AND order_id = ?', time, this.sessionId, o.orderId);
        continue;
      }
      const touch = o.side === 'buy' ? this.book.bestAsk() : this.book.bestBid();
      const bid = this.book.bestBid();
      const ask = this.book.bestAsk();
      if (!touch || !bid || !ask) continue;
      const spreadBps = (Number(str(ask.price - bid.price)) / Number(str((ask.price + bid.price) / 2n))) * 10_000;
      if (spreadBps > this.cfg.risk.maxSpreadBps) {
        this.ledger.close(
          this.sessionId,
          o.orderId,
          'rejected',
          time,
          ordinal,
          `revalidation failed: spread ${spreadBps.toFixed(2)}bps at arrival`,
        );
        continue;
      }
      if (o.side === 'buy' ? touch.price > o.guardPrice : touch.price < o.guardPrice) {
        this.ledger.close(
          this.sessionId,
          o.orderId,
          'rejected',
          time,
          ordinal,
          'revalidation failed: touch beyond execution guard at arrival',
        );
        continue;
      }
      const priorFills =
        (this.store.get('SELECT COUNT(*) AS n FROM fills WHERE session_id = ? AND order_id = ?', this.sessionId, o.orderId)!.n as number) ??
        0;
      this.o.recorder?.flush();
      const r = this.broker.execute(this.book, {
        orderId: o.orderId,
        sessionId: this.sessionId,
        side: o.side,
        qty: o.qty - o.filledQty,
        guardPrice: o.guardPrice,
        priorFills,
        time,
        ordinal,
      });
      if (r.rejected) {
        this.ledger.close(this.sessionId, o.orderId, 'rejected', time, ordinal, r.rejected);
        continue;
      }
      for (const f of r.fills) this.ledger.applyFill(f);
      if (r.remainder) this.ledger.close(this.sessionId, o.orderId, 'cancelled', time, ordinal, r.remainder.reason);
      const b = this.ledger.balances(this.sessionId);
      const held = b.btcAvailable + b.btcReserved;
      if (held === ZERO) this.positionSince = null;
      else if (this.positionSince === null) this.positionSince = time;
      this.valuation(time, ordinal);
    }
  }

  // ---------- valuation ----------

  private equity(mid: Dec | null): Dec {
    const b = this.ledger.balances(this.sessionId);
    const usd = b.usdAvailable + b.usdReserved;
    const btc = b.btcAvailable + b.btcReserved;
    if (btc === ZERO) return usd;
    const mark = mid ?? this.lastMark();
    return mark ? usd + mul(btc, mark) : usd;
  }

  private lastMark(): Dec | null {
    const r = this.store.get(
      'SELECT mark_mid FROM valuations WHERE session_id = ? AND mark_mid IS NOT NULL ORDER BY id DESC LIMIT 1',
      this.sessionId,
    );
    return r ? dec(r.mark_mid as string) : null;
  }

  /** Executable liquidation value: walk bids for the whole BTC position, minus taker fees. */
  private liquidationValue(): Dec | null {
    const b = this.ledger.balances(this.sessionId);
    let btc = b.btcAvailable + b.btcReserved;
    const usd = b.usdAvailable + b.usdReserved;
    if (btc === ZERO) return usd;
    if (!this.book.synced) return null;
    let proceeds = ZERO;
    for (const l of this.book.levels('bid', 1000)) {
      const take = btc < l.qty ? btc : l.qty;
      proceeds += mul(take, l.price);
      btc -= take;
      if (btc === ZERO) break;
    }
    if (btc > ZERO) return null;
    return usd + proceeds - mul(proceeds, dec(this.cfg.fees.takerRate), 'ceil');
  }

  private valuation(time: number, ordinal: number): void {
    this.lastValuationAt = time;
    const healthy = this.feed === 'healthy' && this.book.synced;
    const mid = healthy ? this.book.midpoint() : null;
    const bid = healthy ? (this.book.bestBid()?.price ?? null) : null;
    const b = this.ledger.balances(this.sessionId);
    const usd = b.usdAvailable + b.usdReserved;
    const btc = b.btcAvailable + b.btcReserved;
    const eqMid = mid ? usd + mul(btc, mid) : btc === ZERO ? usd : null;
    const eqBid = bid ? usd + mul(btc, bid) : btc === ZERO ? usd : null;
    const liq = healthy ? this.liquidationValue() : null;
    this.store.run(
      'INSERT INTO valuations (session_id, time, event_ordinal, mark_bid, mark_mid, equity_mid, equity_bid, liquidation_value, stale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      this.sessionId,
      time,
      ordinal,
      bid ? str(bid) : null,
      mid ? str(mid) : null,
      eqMid !== null ? str(eqMid) : null,
      eqBid !== null ? str(eqBid) : null,
      liq !== null ? str(liq) : null,
      healthy ? 0 : 1,
    );
    if (eqMid === null) return; // stale valuation never moves day-start or high-water marks
    const s = this.store.get('SELECT day_start_date, hwm_equity FROM sessions WHERE id = ?', this.sessionId)!;
    const day = new Date(time).toISOString().slice(0, 10);
    if (s.day_start_date !== day)
      this.store.run('UPDATE sessions SET day_start_date = ?, day_start_equity = ? WHERE id = ?', day, str(eqMid), this.sessionId);
    if (!s.hwm_equity || eqMid > dec(s.hwm_equity as string))
      this.store.run('UPDATE sessions SET hwm_equity = ? WHERE id = ?', str(eqMid), this.sessionId);
  }

  // ---------- control polling and main loop ----------

  pollControls(): void {
    for (const r of this.store.all(
      "SELECT request_id, action FROM controls WHERE session_id = ? AND status = 'pending' ORDER BY requested_at",
      this.sessionId,
    )) {
      this.store.run("UPDATE controls SET status = 'queued' WHERE request_id = ?", r.request_id as string);
      this.enqueue({
        kind: 'control',
        ordinal: 0,
        receiptTime: Date.now(),
        action: r.action as ControlAction,
        requestId: r.request_id as string,
      });
    }
  }

  /** Live view for the dashboard/CLI (not part of the financial journal). */
  publishStatus(time: number): void {
    this.store.run(
      'INSERT INTO runtime_status (session_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at',
      this.sessionId,
      JSON.stringify({ ...this.snapshotStatus(), feedAgeMs: this.lastMsgTime ? time - this.lastMsgTime : null }),
      time,
    );
  }

  /** Drive the runtime from an event source until stopped or aborted. */
  async run(source: AsyncIterable<MarketEvent>, signal: AbortSignal, onEvent?: (e: MarketEvent) => void): Promise<void> {
    for await (const e of source) {
      if (signal.aborted) break;
      if (this.o.pollControls && e.kind === 'tick') {
        this.pollControls();
        if (this.o.leaseOwner && !this.store.heartbeatLease(`paper:${this.sessionId}`, this.o.leaseOwner, e.receiptTime)) {
          this.coverageFailure('runtime lease lost to another owner', e.receiptTime);
          break;
        }
      }
      this.ingest(e);
      if (e.kind === 'tick') this.publishStatus(e.receiptTime);
      onEvent?.(e);
      // A recorded 'stopping' marks a process exit; replay continues past it into any later run segment.
      if (this.isStopped() || (this.stopRequested && this.o.mode === 'forward')) break;
    }
  }

  /**
   * Shutdown bookkeeping. Closing valuations are produced by recorded events
   * ('stopping' lifecycle, stop control) so replay reproduces them exactly;
   * nothing financial is written here.
   */
  finish(): void {
    this.o.onStatus?.(this.snapshotStatus());
  }
}
