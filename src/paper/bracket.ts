import type { PaperConfig } from './config';
import type { ApprovedOrder, BracketSpec } from './domain';
import type { Ledger } from './ledger';
import type { OrderBook } from './market/book';
import type { ProductMeta } from './market/coinbase';
import { ONE, ZERO, dec, div, mul, quantize, str, type Dec } from './money';
import type { TradingStore } from './store';

/**
 * Bracket position manager: a post-only limit entry, then a post-only
 * take-profit, an engine-side stop and a max-hold exit (the last two are
 * market IOC sells). Driven only by recorded events, so replay is exact, and
 * persisted in `brackets`, so restarts recover it.
 *
 * Order identity per bracket (decision id `d-...`):
 *   entry  o-<id>              purpose strategy
 *   TP     o-<id>:tpN          purpose take_profit (N increments if re-armed after a pause)
 *   exit   o-<id>:xN           purpose stop | max_hold (N increments on retries)
 */
export interface BracketRow {
  bracketId: string;
  entryOrderId: string;
  tpPct: Dec;
  slPct: Dec;
  maxHoldMs: number;
  status: 'entry_pending' | 'open' | 'exiting' | 'closed';
  entryPrice: Dec | null;
  qty: Dec;
  tpPrice: Dec | null;
  stopPrice: Dec | null;
  openedAt: number | null;
  exitReason: string | null;
}

export class BracketManager {
  constructor(
    private readonly store: TradingStore,
    private readonly ledger: Ledger,
    private readonly cfg: PaperConfig,
    private readonly product: ProductMeta,
    private readonly sessionId: string,
  ) {}

  active(): BracketRow[] {
    return this.store
      .all("SELECT * FROM brackets WHERE session_id = ? AND status <> 'closed' ORDER BY bracket_id", this.sessionId)
      .map((r) => ({
        bracketId: r.bracket_id as string,
        entryOrderId: r.entry_order_id as string,
        tpPct: dec(r.tp_pct as string),
        slPct: dec(r.sl_pct as string),
        maxHoldMs: r.max_hold_ms as number,
        status: r.status as BracketRow['status'],
        entryPrice: r.entry_price ? dec(r.entry_price as string) : null,
        qty: dec(r.qty as string),
        tpPrice: r.tp_price ? dec(r.tp_price as string) : null,
        stopPrice: r.stop_price ? dec(r.stop_price as string) : null,
        openedAt: (r.opened_at as number | null) ?? null,
        exitReason: (r.exit_reason as string | null) ?? null,
      }));
  }

  /** Turn an approved strategy order into a post-only limit entry and register the bracket. */
  submitEntry(
    order: Omit<ApprovedOrder, 'orderId' | 'clientOrderId'>,
    spec: BracketSpec,
    book: OrderBook,
    time: number,
    ordinal: number,
  ): void {
    const tick = dec(this.product.price_increment ?? this.product.quote_increment);
    const bid = book.bestBid()!.price;
    const limit = quantize(mul(bid, ONE - dec(String(spec.entryOffsetBps / 10_000))), tick, 'floor');
    const maker = dec(this.cfg.fees.makerRate);
    const qty = dec(order.qty);
    const reserved = quantize(mul(mul(qty, limit, 'ceil'), ONE + maker, 'ceil'), dec('0.00000001'), 'ceil');
    const id = order.decisionId;
    this.store.tx(() => {
      this.ledger.submit(
        {
          ...order,
          orderId: `o-${id}`,
          clientOrderId: `${this.sessionId}:${id}`,
          orderType: 'limit',
          postOnly: true,
          limitPrice: str(limit),
          guardPrice: str(limit),
          reserved: str(reserved),
          validUntil: time + spec.entryValidMs,
        },
        ordinal,
      );
      this.store.run(
        "INSERT INTO brackets (session_id, bracket_id, entry_order_id, tp_pct, sl_pct, max_hold_ms, status) VALUES (?, ?, ?, ?, ?, ?, 'entry_pending')",
        this.sessionId,
        id,
        `o-${id}`,
        spec.tpPct,
        spec.slPct,
        spec.maxHoldMs,
      );
      this.store.audit(this.sessionId, time, ordinal, 'bracket_entry', { bracketId: id, limit: str(limit), qty: order.qty, spec });
    });
  }

  private ordersOf(b: BracketRow) {
    return this.store
      .all(
        'SELECT order_id FROM orders WHERE session_id = ? AND (order_id = ? OR order_id LIKE ?) ORDER BY submitted_at, order_id',
        this.sessionId,
        b.entryOrderId,
        `${b.entryOrderId}:%`,
      )
      .map((r) => this.ledger.order(this.sessionId, r.order_id as string)!);
  }

  private update(b: BracketRow, fields: Record<string, string | number | null>): void {
    const keys = Object.keys(fields);
    this.store.run(
      `UPDATE brackets SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE session_id = ? AND bracket_id = ?`,
      ...keys.map((k) => fields[k]!),
      this.sessionId,
      b.bracketId,
    );
  }

  /**
   * Advance every active bracket. Call after market events while the session runs
   * and the book is healthy (`canTrade`); bookkeeping (closing finished brackets)
   * always runs.
   */
  manage(book: OrderBook, time: number, ordinal: number, canTrade: boolean): void {
    for (const b of this.active()) {
      const orders = this.ordersOf(b);
      const entry = orders.find((o) => o.orderId === b.entryOrderId)!;
      const sells = orders.filter((o) => o.side === 'sell');
      const sold = sells.reduce((a, o) => a + o.filledQty, ZERO);
      const held = entry.filledQty - sold;
      const entryDone = ['filled', 'cancelled', 'expired', 'rejected'].includes(entry.status);
      const openSells = sells.filter((o) => ['accepted', 'partially_filled', 'cancel_pending'].includes(o.status));
      const tpOpen = openSells.find((o) => o.purpose === 'take_profit');

      if (entry.filledQty > ZERO && b.entryPrice === null) {
        const avg = div(entry.notional, entry.filledQty);
        const firstFill =
          (this.store.get('SELECT MIN(time) AS t FROM fills WHERE session_id = ? AND order_id = ?', this.sessionId, entry.orderId)!
            .t as number) ?? time;
        const tick = dec(this.product.price_increment ?? this.product.quote_increment);
        b.entryPrice = avg;
        b.openedAt = firstFill;
        b.tpPrice = quantize(mul(avg, ONE + b.tpPct / 100n), tick, 'ceil');
        b.stopPrice = quantize(mul(avg, ONE - b.slPct / 100n), tick, 'floor');
        b.status = 'open';
        this.update(b, {
          status: 'open',
          entry_price: str(avg),
          opened_at: firstFill,
          tp_price: str(b.tpPrice),
          stop_price: str(b.stopPrice),
        });
      }
      if (entryDone && entry.filledQty === ZERO) {
        this.update(b, { status: 'closed', closed_at: time, exit_reason: `entry ${entry.status} without a fill` });
        this.store.audit(this.sessionId, time, ordinal, 'bracket_closed', { bracketId: b.bracketId, reason: 'not filled' });
        continue;
      }
      if (b.status !== 'entry_pending' && entryDone && held === ZERO && openSells.length === 0) {
        const lastSell = [...sells].reverse().find((o) => o.filledQty > ZERO);
        const reason = lastSell?.purpose === 'take_profit' ? 'take_profit' : (b.exitReason ?? lastSell?.purpose ?? 'closed');
        this.update(b, { status: 'closed', closed_at: time, exit_reason: reason, qty: str(entry.filledQty) });
        this.store.audit(this.sessionId, time, ordinal, 'bracket_closed', { bracketId: b.bracketId, reason });
        continue;
      }
      if (!canTrade || b.status === 'entry_pending' || held <= ZERO || b.stopPrice === null) continue;

      const bid = book.bestBid()?.price;
      const stopHit = !!bid && bid <= b.stopPrice;
      const timeUp = b.openedAt !== null && time - b.openedAt >= b.maxHoldMs;
      if ((stopHit || timeUp) && b.status !== 'exiting') {
        const reason = stopHit ? 'stop' : 'max_hold';
        if (!entryDone)
          this.ledger.close(this.sessionId, entry.orderId, 'cancelled', time, ordinal, `bracket ${reason}: entry remainder cancelled`);
        for (const o of openSells) this.ledger.close(this.sessionId, o.orderId, 'cancelled', time, ordinal, `bracket ${reason}`);
        const remaining = this.ledger.order(this.sessionId, entry.orderId)!.filledQty - sold;
        if (remaining > ZERO) this.submitSell(b, reason, remaining, 'market', null, time, ordinal);
        b.status = 'exiting';
        this.update(b, { status: 'exiting', exit_reason: reason });
        continue;
      }
      if (b.status === 'exiting') {
        // A rejected or partially filled exit leaves inventory: retry at market.
        if (openSells.length === 0 && held > ZERO)
          this.submitSell(b, (b.exitReason as 'stop' | 'max_hold') ?? 'stop', held, 'market', null, time, ordinal);
        continue;
      }
      if (entryDone && !tpOpen && b.tpPrice !== null) {
        const ask = book.bestAsk()?.price;
        if (bid && bid >= b.tpPrice) {
          // Already through the target: a post-only sell would take liquidity, so exit at market.
          this.submitSell(b, 'take_profit', held, 'market', null, time, ordinal);
        } else {
          void ask;
          this.submitSell(b, 'take_profit', held, 'limit', b.tpPrice, time, ordinal);
        }
      }
    }
  }

  private submitSell(
    b: BracketRow,
    purpose: 'take_profit' | 'stop' | 'max_hold',
    qty: Dec,
    type: 'market' | 'limit',
    limit: Dec | null,
    time: number,
    ordinal: number,
  ): void {
    const step = dec(this.product.base_increment);
    const q = quantize(qty, step, 'floor');
    if (q <= ZERO || q < dec(this.product.base_min_size)) {
      this.store.audit(this.sessionId, time, ordinal, 'bracket_dust', { bracketId: b.bracketId, qty: str(qty) });
      return;
    }
    const prefix = purpose === 'take_profit' ? 'tp' : 'x';
    const n =
      (this.store.get(
        'SELECT COUNT(*) AS n FROM orders WHERE session_id = ? AND order_id LIKE ?',
        this.sessionId,
        `${b.entryOrderId}:${prefix}%`,
      )!.n as number) + 1;
    const orderId = `${b.entryOrderId}:${prefix}${n}`;
    const g = dec(String(this.cfg.execution.guardBps / 10_000));
    const ref = limit ?? b.stopPrice ?? b.entryPrice!;
    try {
      this.ledger.submit(
        {
          orderId,
          clientOrderId: `${this.sessionId}:${orderId}`,
          sessionId: this.sessionId,
          decisionId: orderId.slice(2),
          side: 'sell',
          qty: str(q),
          guardPrice: str(type === 'limit' ? limit! : mul(ref, ONE - g, 'ceil')),
          reserved: str(q),
          submittedAt: time,
          arrivalAt: time + this.cfg.execution.delayMs,
          validUntil: type === 'limit' ? time + b.maxHoldMs + 3_600_000 : time + this.cfg.decision.intentTtlMs,
          policyVersion: this.cfg.risk.version,
          snapshotId: b.bracketId,
          purpose,
          orderType: type,
          limitPrice: limit ? str(limit) : undefined,
          postOnly: type === 'limit',
        },
        ordinal,
      );
    } catch (e) {
      this.store.audit(this.sessionId, time, ordinal, 'bracket_submit_failed', { bracketId: b.bracketId, purpose, error: String(e) });
    }
  }
}
