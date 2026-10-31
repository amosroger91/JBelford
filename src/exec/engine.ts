import type { Candle, ExitReason, OrderPurpose, OrderRecord, PositionRecord, Side, TopOfBook, TradeRecord } from '../core/types';
import type { Store } from '../persistence/store';
import type { RiskEngine } from '../risk/engine';
import { exitLevels, type Exits, type Strategy } from '../strategy/types';
import type { CostModel } from '../economics/costs';
import { worstCaseLossUsd } from '../economics/costs';
import { AmbiguousOrderError, OrderRejectedError, RiskViolationError, type ExchangeAdapter } from './adapter';
import { floorToStep, newClientOrderId, newTradeId, roundToStep } from '../core/util';
import { log } from '../core/log';

export interface EngineOptions {
  mode: 'paper' | 'live';
  /** How long an order may be missing from the exchange before it is treated as never placed. */
  ambiguousGraceMs: number;
  /** Fraction of the hard max order value to use (leaves room for rounding). */
  sizeFraction: number;
  balanceSnapshotMs: number;
  now?: () => number;
  /** Returns true when the emergency kill switch has been triggered. */
  killSwitch?: () => boolean;
  /** Optional data-quality veto on NEW entries (e.g. cross-exchange price divergence). Returns a reason or null. */
  entryVeto?: (now: number, book: TopOfBook) => string | null;
}

export type EnginePhase = 'FLAT' | 'ENTRY_PENDING' | 'LONG' | 'EXIT_PENDING' | 'STOPPED';

const EXIT_REASON_KEY = (tradeId: string) => `exitReason:${tradeId}`;
/** Exit distances chosen at signal time, applied to the actual fill price. */
const EXITS_KEY = (tradeId: string) => `exits:${tradeId}`;
const BASELINE_BTC_KEY = 'baselineBtc';
const EPS = 1e-10;

/**
 * Deterministic execution engine. Owns the order lifecycle:
 *   FLAT -> ENTRY_PENDING (post-only bid) -> LONG (post-only take-profit resting,
 *   engine-side stop/max-hold) -> EXIT_PENDING -> FLAT
 * Every order gets a persisted client order id BEFORE submission. Any
 * ambiguous outcome marks the state uncertain; nothing new is sent until
 * reconciliation against the exchange succeeds.
 */
export class TradingEngine {
  private book: TopOfBook | null = null;
  private candles: Candle[] = [];
  private lastEvaluatedBar = 0;
  private stateCertain = false;
  private staleSince: number | null = null;
  private lastSnapshot = 0;
  private busy = false;
  private stopped = false;
  private readonly now: () => number;

  constructor(
    private readonly store: Store,
    private readonly risk: RiskEngine,
    private readonly adapter: ExchangeAdapter,
    private readonly strategy: Strategy,
    private readonly costs: CostModel,
    private readonly opts: EngineOptions,
  ) {
    this.now = opts.now ?? Date.now;
  }

  // ---------- inputs ----------

  onBook(book: TopOfBook): void {
    this.book = book;
  }

  /** Replace the closed 1m candle window (oldest first). */
  onCandles(candles: Candle[]): void {
    this.candles = candles;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  isStateCertain(): boolean {
    return this.stateCertain;
  }

  phase(): EnginePhase {
    if (this.stopped) return 'STOPPED';
    const open = this.store.openOrders();
    if (open.some((o) => o.purpose === 'entry')) return 'ENTRY_PENDING';
    if (open.some((o) => o.purpose === 'stop' || o.purpose === 'flatten')) return 'EXIT_PENDING';
    return this.store.openPosition() ? 'LONG' : 'FLAT';
  }

  private event(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>): void {
    this.store.insertEvent(this.now(), level, msg, data);
    log[level](msg, data);
  }

  // ---------- main loop step ----------

  async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      await this.step();
    } catch (e) {
      this.stateCertain = false;
      this.event('error', 'engine step failed; state marked uncertain', { error: String(e) });
    } finally {
      this.busy = false;
    }
  }

  private async step(): Promise<void> {
    const now = this.now();

    if (this.opts.killSwitch?.()) {
      await this.shutdown('kill_switch', true);
      return;
    }

    const dataAge = this.dataAgeMs(now);
    const stale = dataAge > this.risk.limits.staleDataMs;
    if (stale) {
      this.staleSince ??= now;
      if (now - this.staleSince > this.risk.limits.staleHaltMs) {
        this.risk.halt('market data stale for too long', 'manual_reset', now);
      }
    } else {
      this.staleSince = null;
    }

    if (!this.stateCertain) {
      const ok = await this.reconcile();
      if (!ok) return;
    }

    if (!(await this.syncOpenOrders())) return;

    if (!stale && this.book && now - this.lastSnapshot >= this.opts.balanceSnapshotMs) {
      const bal = await this.adapter.fetchBalance();
      this.store.insertBalance(now, bal, this.book.bid);
      this.lastSnapshot = now;
    }

    const entry = this.store.openOrders().find((o) => o.purpose === 'entry');
    if (entry) {
      await this.manageEntry(entry, now);
      return;
    }

    const pos = this.store.openPosition();
    if (pos) {
      if (stale) return; // cannot evaluate stops on stale data; the take-profit keeps resting
      await this.manageLong(pos, now);
      return;
    }

    if (!stale) await this.maybeEnter(now, dataAge);
  }

  private dataAgeMs(now: number): number {
    if (!this.book) return Number.POSITIVE_INFINITY;
    const bookAge = now - this.book.ts;
    const last = this.candles.at(-1);
    // A closed 1m bar should never be more than ~2 minutes old.
    const candleAge = last ? now - (last.ts + 60_000) : Number.POSITIVE_INFINITY;
    return candleAge > 150_000 ? Math.max(bookAge, candleAge) : bookAge;
  }

  // ---------- entries ----------

  private async maybeEnter(now: number, dataAge: number): Promise<void> {
    const last = this.candles.at(-1);
    if (!last || last.ts <= this.lastEvaluatedBar || !this.book) return;
    this.lastEvaluatedBar = last.ts;

    const { bid, ask } = this.book;
    const spreadBps = ((ask - bid) / ((ask + bid) / 2)) * 10_000;
    const prepared = this.strategy.prepare(this.candles);
    const sig = this.strategy.signalAt(prepared, this.candles.length - 1, spreadBps);
    if (!sig.enter) return;
    const veto = this.opts.entryVeto?.(now, this.book);
    if (veto) {
      this.event('warn', 'entry signal vetoed by market-context check', { reason: veto });
      return;
    }

    const m = this.adapter.marketInfo();
    const price = roundToStep(bid, m.priceTick);
    const notional = this.risk.limits.maxOrderValueUsd * this.opts.sizeFraction;
    const amount = floorToStep(notional / price, m.amountStep);
    const value = amount * price;
    const decision = this.risk.evaluateEntry({
      now,
      symbol: m.symbol,
      side: 'buy',
      orderValueUsd: value,
      exchangeMinValueUsd: Math.max(m.minCost, m.minAmount * price),
      worstCaseLossUsd: worstCaseLossUsd(value, sig.exits.stopLossPct, this.costs),
      dataAgeMs: dataAge,
      stateCertain: this.stateCertain,
      hasOpenPosition: !!this.store.openPosition(),
      openOrderCount: this.store.openOrders().length,
    });
    if (!decision.ok) {
      this.event('info', 'entry signal blocked by risk engine', { reasons: decision.reasons });
      return;
    }
    const bal = await this.adapter.fetchBalance();
    if (value * (1 + this.costs.fees.maker) > bal.usd) {
      this.event('warn', 'entry skipped: insufficient USD', { usd: bal.usd, value });
      return;
    }
    this.event('info', `entry signal (${this.strategy.name})`, { price, amount, exits: sig.exits, metrics: sig.metrics });
    const tradeId = newTradeId();
    this.store.setKv(EXITS_KEY(tradeId), sig.exits, now);
    await this.submit(tradeId, 'entry', 'buy', 'limit', amount, price, true);
  }

  private async manageEntry(entry: OrderRecord, now: number): Promise<void> {
    const timeoutMs = this.strategy.execution.entryTimeoutSec * 1000;
    if (entry.status === 'open' && now - entry.createdAt >= timeoutMs) {
      this.event('info', 'entry timed out unfilled; canceling', { clientOrderId: entry.clientOrderId, filled: entry.filled });
      await this.cancelAndSync(entry);
    }
  }

  // ---------- open position ----------

  private exitFilled(tradeId: string): { amount: number; notional: number; fee: number } {
    let amount = 0;
    let notional = 0;
    let fee = 0;
    for (const o of this.store.ordersForTrade(tradeId)) {
      if (o.side !== 'sell' || o.filled <= 0) continue;
      amount += o.filled;
      notional += o.filled * (o.avgPrice ?? 0);
      fee += o.fee;
    }
    return { amount, notional, fee };
  }

  private async manageLong(pos: PositionRecord, now: number): Promise<void> {
    if (!this.book) return;
    const m = this.adapter.marketInfo();
    const remaining = pos.amount - this.exitFilled(pos.tradeId).amount;
    if (remaining <= EPS) return;
    if (remaining < m.minAmount) {
      this.risk.halt(`position remainder ${remaining} BTC is below exchange minimum; manual action needed`, 'manual_reset', now);
      return;
    }

    const bid = this.book.bid;
    const unrealized = remaining * bid * (1 - this.costs.fees.taker) - remaining * pos.entryPrice - pos.entryFee * (remaining / pos.amount);
    const riskCheck = this.risk.evaluateOpenPosition(now, unrealized);

    let reason: ExitReason | null = null;
    if (riskCheck.mustFlatten) reason = 'risk_flatten';
    else if (bid <= pos.stopPrice) reason = 'stop_loss';
    else if (now - pos.openedAt >= this.strategy.execution.maxHoldMinutes * 60_000) reason = 'max_hold';

    const tp = this.store.openOrders().find((o) => o.purpose === 'take_profit');
    if (reason) {
      await this.exitPosition(pos, reason);
      return;
    }
    if (!tp) {
      const price = roundToStep(Math.max(pos.takeProfitPrice, this.book.ask), m.priceTick);
      await this.submit(pos.tradeId, 'take_profit', 'sell', 'limit', floorToStep(remaining, m.amountStep), price, true);
    }
  }

  /** Cancel resting exits, then sell whatever remains at market. */
  private async exitPosition(pos: PositionRecord, reason: ExitReason): Promise<void> {
    this.store.setKv(EXIT_REASON_KEY(pos.tradeId), reason, this.now());
    for (const o of this.store.openOrders().filter((x) => x.tradeId === pos.tradeId && x.side === 'sell')) {
      await this.cancelAndSync(o);
    }
    if (!this.stateCertain || !this.store.openPosition()) return; // TP may have filled while canceling
    if (this.store.openOrders().some((o) => o.tradeId === pos.tradeId && o.side === 'sell')) return;
    const m = this.adapter.marketInfo();
    const remaining = floorToStep(pos.amount - this.exitFilled(pos.tradeId).amount, m.amountStep);
    if (remaining <= EPS) return;
    this.event('warn', `exiting position: ${reason}`, { tradeId: pos.tradeId, remaining });
    await this.submit(pos.tradeId, reason === 'stop_loss' ? 'stop' : 'flatten', 'sell', 'market', remaining, null, false);
  }

  // ---------- order submission & sync ----------

  private async submit(
    tradeId: string,
    purpose: OrderPurpose,
    side: Side,
    type: 'limit' | 'market',
    amount: number,
    price: number | null,
    postOnly: boolean,
  ): Promise<void> {
    const now = this.now();
    const rec: OrderRecord = {
      clientOrderId: newClientOrderId(),
      exchangeOrderId: null,
      tradeId,
      symbol: this.adapter.marketInfo().symbol,
      side,
      type,
      purpose,
      price,
      amount,
      filled: 0,
      avgPrice: null,
      fee: 0,
      status: 'pending_submit',
      postOnly,
      createdAt: now,
      updatedAt: now,
    };
    // Persist first: if we crash after sending, reconciliation finds it by client id.
    this.store.insertOrder(rec);
    try {
      const remote =
        type === 'limit'
          ? await this.adapter.createLimitOrder({ clientOrderId: rec.clientOrderId, side, amount, price: price!, postOnly })
          : await this.adapter.createMarketOrder({ clientOrderId: rec.clientOrderId, side, amount });
      this.applyRemote(rec, remote);
      this.event('info', `order placed: ${purpose} ${side} ${type}`, { clientOrderId: rec.clientOrderId, amount, price });
    } catch (e) {
      if (e instanceof OrderRejectedError) {
        this.store.updateOrder(rec.clientOrderId, { status: 'rejected' }, this.now());
        this.event('warn', `order rejected: ${purpose}`, { error: e.message });
        if (purpose !== 'entry' && purpose !== 'take_profit') {
          // A rejected exit leaves risk on; stop and let reconciliation re-check everything.
          this.stateCertain = false;
        }
      } else if (e instanceof RiskViolationError) {
        this.store.updateOrder(rec.clientOrderId, { status: 'rejected' }, this.now());
        this.risk.halt(`order guard violation: ${e.message}`, 'manual_reset', this.now());
        this.event('error', 'order blocked by guard', { error: e.message });
      } else {
        const ambiguous = e instanceof AmbiguousOrderError;
        this.store.updateOrder(rec.clientOrderId, { status: 'unknown' }, this.now());
        this.stateCertain = false;
        this.event('error', `ambiguous order response (${ambiguous ? 'timeout' : 'unexpected error'}); reconciling`, {
          clientOrderId: rec.clientOrderId,
          error: String(e),
        });
      }
    }
  }

  /** Pull status for every locally-open order. Returns false if state became uncertain. */
  private async syncOpenOrders(): Promise<boolean> {
    for (const o of this.store.openOrders()) {
      if (o.status === 'pending_submit' || o.status === 'unknown') {
        this.stateCertain = false;
        return false;
      }
      try {
        const remote = await this.adapter.fetchOrderByClientId(o.clientOrderId, o.createdAt - 60_000);
        if (!remote) {
          this.stateCertain = false;
          this.event('error', 'open order missing on exchange', { clientOrderId: o.clientOrderId });
          return false;
        }
        this.applyRemote(o, remote);
      } catch (e) {
        this.stateCertain = false;
        this.event('warn', 'order status fetch failed', { error: String(e) });
        return false;
      }
    }
    return true;
  }

  private async cancelAndSync(o: OrderRecord): Promise<void> {
    try {
      await this.adapter.cancelOrder(o.clientOrderId, o.exchangeOrderId);
    } catch (e) {
      // Already filled/canceled orders can error on cancel; the fetch below is authoritative.
      this.event('warn', 'cancel returned error; verifying', { clientOrderId: o.clientOrderId, error: String(e) });
    }
    try {
      const remote = await this.adapter.fetchOrderByClientId(o.clientOrderId, o.createdAt - 60_000);
      if (!remote) throw new Error('order not found after cancel');
      this.applyRemote(this.store.getOrder(o.clientOrderId)!, remote);
      if (remote.status === 'open') throw new Error('order still open after cancel');
    } catch (e) {
      this.stateCertain = false;
      this.event('error', 'could not confirm cancel; state uncertain', { clientOrderId: o.clientOrderId, error: String(e) });
    }
  }

  /** Merge an exchange view of an order into local state and derive position/trade changes. */
  private applyRemote(local: OrderRecord, remote: import('../core/types').AdapterOrder): void {
    const now = this.now();
    const delta = remote.filled - local.filled;
    if (delta > EPS) {
      const prevNotional = (local.avgPrice ?? 0) * local.filled;
      const deltaPrice = ((remote.avgPrice ?? remote.price ?? 0) * remote.filled - prevNotional) / delta;
      this.store.insertFill({
        clientOrderId: local.clientOrderId,
        tradeId: local.tradeId,
        ts: now,
        side: local.side,
        price: deltaPrice,
        amount: delta,
        fee: Math.max(0, remote.fee - local.fee),
      });
    }
    const status =
      remote.status === 'open'
        ? 'open'
        : remote.status === 'closed'
          ? 'filled'
          : remote.status === 'canceled'
            ? 'canceled'
            : 'rejected';
    this.store.updateOrder(
      local.clientOrderId,
      {
        exchangeOrderId: remote.exchangeOrderId,
        filled: remote.filled,
        avgPrice: remote.avgPrice ?? local.avgPrice,
        fee: remote.fee,
        status,
      },
      now,
    );
    const updated = this.store.getOrder(local.clientOrderId)!;
    if (updated.purpose === 'entry' && updated.filled > EPS) this.onEntryFill(updated);
    if (updated.side === 'sell' && status !== 'open') this.maybeCloseTrade(updated.tradeId);
  }

  private onEntryFill(o: OrderRecord): void {
    const existing = this.store.openPosition();
    const avg = o.avgPrice ?? o.price ?? 0;
    let exits = this.store.getKv<Exits>(EXITS_KEY(o.tradeId));
    if (!exits) {
      // Should not happen (exits are persisted before the entry is sent); fall back to a tight stop.
      exits = { takeProfitPct: 1, stopLossPct: 0.5 };
      this.event('warn', 'exit plan missing for trade; using fallback 1% / 0.5%', { tradeId: o.tradeId });
    }
    const levels = exitLevels(avg, exits);
    this.store.upsertPosition({
      tradeId: o.tradeId,
      symbol: o.symbol,
      amount: o.filled,
      entryPrice: avg,
      entryFee: o.fee,
      openedAt: existing?.tradeId === o.tradeId ? existing.openedAt : this.now(),
      stopPrice: levels.stop,
      takeProfitPrice: levels.takeProfit,
    });
  }

  private maybeCloseTrade(tradeId: string): void {
    const pos = this.store.openPosition();
    if (!pos || pos.tradeId !== tradeId) return;
    if (this.store.openOrders().some((o) => o.tradeId === tradeId)) return;
    const ex = this.exitFilled(tradeId);
    if (ex.amount < pos.amount - this.adapter.marketInfo().amountStep / 2) return;
    const lastSell = this.store
      .ordersForTrade(tradeId)
      .filter((o) => o.side === 'sell' && o.filled > 0)
      .at(-1);
    const reason: ExitReason =
      lastSell?.purpose === 'take_profit'
        ? 'take_profit'
        : (this.store.getKv<ExitReason>(EXIT_REASON_KEY(tradeId)) ?? 'risk_flatten');
    const exitPrice = ex.notional / ex.amount;
    const gross = ex.notional - pos.amount * pos.entryPrice;
    const trade: TradeRecord = {
      tradeId,
      symbol: pos.symbol,
      amount: pos.amount,
      entryPrice: pos.entryPrice,
      exitPrice,
      entryFee: pos.entryFee,
      exitFee: ex.fee,
      grossPnl: gross,
      netPnl: gross - pos.entryFee - ex.fee,
      openedAt: pos.openedAt,
      closedAt: this.now(),
      exitReason: reason,
      mode: this.opts.mode,
    };
    this.store.closePositionWithTrade(trade);
    this.store.deleteKv(EXIT_REASON_KEY(tradeId));
    this.store.deleteKv(EXITS_KEY(tradeId));
    this.event('info', `trade closed: ${reason}`, { tradeId, netPnl: Number(trade.netPnl.toFixed(4)) });
    this.risk.onTradeClosed(trade, this.now());
  }

  // ---------- reconciliation ----------

  /**
   * Bring local state in line with the exchange. Called at startup, after
   * disconnects and after any ambiguous response. Returns true when state is
   * certain again.
   */
  async reconcile(): Promise<boolean> {
    const now = this.now();
    try {
      for (const o of this.store.openOrders()) {
        const remote = await this.adapter.fetchOrderByClientId(o.clientOrderId, o.createdAt - 60_000);
        if (remote) {
          this.applyRemote(o, remote);
          continue;
        }
        if (o.status === 'open') {
          this.event('error', 'locally open order unknown to exchange', { clientOrderId: o.clientOrderId });
          this.risk.halt('order state mismatch: open order missing on exchange', 'manual_reset', now);
          return false;
        }
        if (now - o.createdAt < this.opts.ambiguousGraceMs) return false; // exchange may not have indexed it yet
        this.store.updateOrder(o.clientOrderId, { status: 'rejected' }, now);
        this.event('warn', 'ambiguous order confirmed never placed', { clientOrderId: o.clientOrderId });
      }

      const known = new Set(this.store.recentOrders(200).map((o) => o.clientOrderId));
      const remoteOpen = await this.adapter.fetchOpenOrders();
      const orphans = remoteOpen.filter((r) => !known.has(r.clientOrderId));
      if (orphans.length > 0) {
        this.risk.halt(`${orphans.length} unrecognized open order(s) on exchange`, 'manual_reset', now);
        this.event('error', 'unrecognized open orders on exchange', { ids: orphans.map((o) => o.exchangeOrderId) });
        return false;
      }

      const bal = await this.adapter.fetchBalance();
      let baseline = this.store.getKv<number>(BASELINE_BTC_KEY);
      const pos = this.store.openPosition();
      if (baseline === undefined) {
        baseline = pos ? Math.max(0, bal.btc - pos.amount) : bal.btc;
        this.store.setKv(BASELINE_BTC_KEY, baseline, now);
      }
      const expected = baseline + (pos ? pos.amount - this.exitFilled(pos.tradeId).amount : 0);
      const tol = this.adapter.marketInfo().minAmount / 2;
      if (Math.abs(bal.btc - expected) > tol) {
        this.risk.halt(`BTC balance ${bal.btc} != expected ${expected.toFixed(8)}`, 'manual_reset', now);
        this.event('error', 'balance mismatch during reconciliation', { btc: bal.btc, expected });
        return false;
      }
      if (!this.stateCertain) this.event('info', 'reconciliation complete; state certain', { usd: bal.usd, btc: bal.btc });
      this.stateCertain = true;
      return true;
    } catch (e) {
      this.stateCertain = false;
      this.event('warn', 'reconciliation failed; will retry', { error: String(e) });
      return false;
    }
  }

  // ---------- shutdown ----------

  /**
   * Cancel every open order and, if `flatten`, market-sell any position.
   * Used by the kill switch and graceful shutdown.
   */
  async shutdown(reason: ExitReason, flatten: boolean): Promise<void> {
    if (this.stopped) return;
    this.event('warn', `shutdown requested: ${reason}`, { flatten });
    if (reason === 'kill_switch') this.risk.halt('emergency kill switch', 'manual_reset', this.now());
    if (!this.stateCertain) await this.reconcile();
    for (const o of this.store.openOrders()) {
      if (o.status === 'open') await this.cancelAndSync(o);
    }
    const pos = this.store.openPosition();
    if (pos && flatten) {
      if (!this.book || this.dataAgeMs(this.now()) > this.risk.limits.staleDataMs) {
        this.event('error', 'cannot flatten: no fresh market data. MANUAL ACTION REQUIRED.', { tradeId: pos.tradeId });
      } else {
        await this.exitPosition(pos, reason);
        await this.syncOpenOrders();
        if (this.store.openPosition()) {
          this.event('error', 'position still open after flatten attempt. MANUAL ACTION REQUIRED.', { tradeId: pos.tradeId });
        }
      }
    } else if (pos) {
      this.event('warn', 'shutdown leaving position open without engine-side stop protection', { tradeId: pos.tradeId });
    }
    this.stopped = true;
  }
}
