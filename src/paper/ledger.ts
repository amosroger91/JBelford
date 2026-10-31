import type { TradingStore } from './store';
import type { ApprovedOrder, BalanceView, FillRecord, OrderStatus } from './domain';
import { ORDER_TRANSITIONS, assertTransition } from './domain';
import { ZERO, dec, div, mul, str, type Dec } from './money';

/**
 * Exact double-entry style portfolio accounting.
 *
 * Accounts per session: usd_available, usd_reserved, btc_available, btc_reserved.
 * Supplementary tallies (not cash): btc_cost_basis (weighted average, buy fees
 * included), realized_pnl, fees_paid. Every change is a ledger entry; the
 * `balances` row is a projection that `verify()` rebuilds from entries.
 *
 * Cost basis: weighted average including buy fees. Realized PnL on a sell =
 * proceeds - sell fee - average cost of the quantity sold.
 */
export interface Balances {
  usdAvailable: Dec;
  usdReserved: Dec;
  btcAvailable: Dec;
  btcReserved: Dec;
  btcCostBasis: Dec;
  realizedPnl: Dec;
  feesPaid: Dec;
}

const CASH_ACCOUNTS = ['usd_available', 'usd_reserved', 'btc_available', 'btc_reserved'] as const;
type Account = (typeof CASH_ACCOUNTS)[number] | 'btc_cost_basis' | 'realized_pnl' | 'fees_paid';

export class LedgerError extends Error {
  override name = 'LedgerError';
}

export class Ledger {
  constructor(private readonly s: TradingStore) {}

  balances(sessionId: string): Balances {
    const r = this.s.get('SELECT * FROM balances WHERE session_id = ?', sessionId);
    if (!r) throw new LedgerError(`no balances for session ${sessionId}`);
    return {
      usdAvailable: dec(r.usd_available as string),
      usdReserved: dec(r.usd_reserved as string),
      btcAvailable: dec(r.btc_available as string),
      btcReserved: dec(r.btc_reserved as string),
      btcCostBasis: dec(r.btc_cost_basis as string),
      realizedPnl: dec(r.realized_pnl as string),
      feesPaid: dec(r.fees_paid as string),
    };
  }

  view(sessionId: string): BalanceView {
    const b = this.balances(sessionId);
    return {
      usdAvailable: str(b.usdAvailable),
      usdReserved: str(b.usdReserved),
      btcAvailable: str(b.btcAvailable),
      btcReserved: str(b.btcReserved),
    };
  }

  private post(
    sessionId: string,
    time: number,
    ordinal: number,
    refType: string,
    refId: string,
    deltas: Partial<Record<Account, Dec>>,
    memo?: string,
  ): void {
    const b = this.balances(sessionId);
    const next: Balances = { ...b };
    const map: Record<Account, keyof Balances> = {
      usd_available: 'usdAvailable',
      usd_reserved: 'usdReserved',
      btc_available: 'btcAvailable',
      btc_reserved: 'btcReserved',
      btc_cost_basis: 'btcCostBasis',
      realized_pnl: 'realizedPnl',
      fees_paid: 'feesPaid',
    };
    for (const [acct, amt] of Object.entries(deltas) as [Account, Dec][]) {
      if (amt === ZERO) continue;
      next[map[acct]] = next[map[acct]] + amt;
      this.s.run(
        'INSERT INTO ledger_entries (session_id, time, event_ordinal, ref_type, ref_id, account, amount, memo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        sessionId,
        time,
        ordinal,
        refType,
        refId,
        acct,
        str(amt),
        memo ?? null,
      );
    }
    for (const a of CASH_ACCOUNTS) {
      if (next[map[a]] < ZERO) throw new LedgerError(`${a} would become negative (${str(next[map[a]])}) on ${refType} ${refId}`);
    }
    if (next.btcCostBasis < ZERO) throw new LedgerError('cost basis would become negative');
    this.s.run(
      'UPDATE balances SET usd_available = ?, usd_reserved = ?, btc_available = ?, btc_reserved = ?, btc_cost_basis = ?, realized_pnl = ?, fees_paid = ? WHERE session_id = ?',
      str(next.usdAvailable),
      str(next.usdReserved),
      str(next.btcAvailable),
      str(next.btcReserved),
      str(next.btcCostBasis),
      str(next.realizedPnl),
      str(next.feesPaid),
      sessionId,
    );
  }

  /** Create the balance projection and opening entries for a new session. */
  open(sessionId: string, usd: Dec, btc: Dec, time: number, btcCostBasis: Dec = ZERO): void {
    this.s.tx(() => {
      this.s.run(
        "INSERT INTO balances (session_id, usd_available, usd_reserved, btc_available, btc_reserved, btc_cost_basis, realized_pnl, fees_paid) VALUES (?, '0', '0', '0', '0', '0', '0', '0')",
        sessionId,
      );
      this.post(
        sessionId,
        time,
        0,
        'open',
        sessionId,
        { usd_available: usd, btc_available: btc, btc_cost_basis: btcCostBasis },
        'opening balances',
      );
    });
  }

  /** Insert the order and reserve funds atomically. Duplicate client order ids are rejected by the database. */
  submit(o: ApprovedOrder, ordinal: number): void {
    this.s.tx(() => {
      const existing = this.s.get('SELECT order_id FROM orders WHERE client_order_id = ?', o.clientOrderId);
      if (existing) throw new LedgerError(`duplicate client order id ${o.clientOrderId}`);
      const reserved = dec(o.reserved);
      const b = this.balances(o.sessionId);
      if (o.side === 'buy' && reserved > b.usdAvailable) throw new LedgerError('insufficient available USD for reservation');
      if (o.side === 'sell' && reserved > b.btcAvailable) throw new LedgerError('insufficient available BTC for reservation');
      this.s.run(
        `INSERT INTO orders (order_id, client_order_id, session_id, decision_id, side, purpose, qty, guard_price, reserved, reserved_remaining,
          status, submitted_at, arrival_at, valid_until, policy_version, snapshot_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?, ?)`,
        o.orderId,
        o.clientOrderId,
        o.sessionId,
        o.decisionId,
        o.side,
        o.purpose,
        o.qty,
        o.guardPrice,
        o.reserved,
        o.reserved,
        o.submittedAt,
        o.arrivalAt,
        o.validUntil,
        o.policyVersion,
        o.snapshotId,
        o.submittedAt,
      );
      this.s.fault('submit:after-insert');
      this.post(
        o.sessionId,
        o.submittedAt,
        ordinal,
        'reserve',
        o.orderId,
        o.side === 'buy' ? { usd_available: -reserved, usd_reserved: reserved } : { btc_available: -reserved, btc_reserved: reserved },
      );
      this.transition(o.sessionId, o.orderId, 'accepted', o.submittedAt);
    });
  }

  /** Order ids are deterministic and unique per session (not globally). */
  order(sessionId: string, orderId: string) {
    const r = this.s.get('SELECT * FROM orders WHERE session_id = ? AND order_id = ?', sessionId, orderId);
    if (!r) return undefined;
    return {
      orderId: r.order_id as string,
      clientOrderId: r.client_order_id as string,
      sessionId: r.session_id as string,
      decisionId: r.decision_id as string,
      side: r.side as 'buy' | 'sell',
      purpose: r.purpose as string,
      qty: dec(r.qty as string),
      filledQty: dec(r.filled_qty as string),
      notional: dec(r.notional as string),
      fees: dec(r.fees as string),
      guardPrice: dec(r.guard_price as string),
      reserved: dec(r.reserved as string),
      reservedRemaining: dec(r.reserved_remaining as string),
      status: r.status as OrderStatus,
      submittedAt: r.submitted_at as number,
      arrivalAt: r.arrival_at as number,
      validUntil: r.valid_until as number,
      rejectReason: (r.reject_reason as string | null) ?? null,
    };
  }

  openOrders(sessionId: string) {
    return this.s
      .all(
        "SELECT order_id FROM orders WHERE session_id = ? AND status IN ('submitted','accepted','partially_filled','cancel_pending') ORDER BY submitted_at, order_id",
        sessionId,
      )
      .map((r) => this.order(sessionId, r.order_id as string)!);
  }

  private transition(sessionId: string, orderId: string, to: OrderStatus, time: number, reason?: string): void {
    const o = this.order(sessionId, orderId)!;
    if (o.status === to && to === 'partially_filled') return;
    assertTransition(ORDER_TRANSITIONS, o.status, to, 'order');
    this.s.run(
      'UPDATE orders SET status = ?, updated_at = ?, reject_reason = COALESCE(?, reject_reason) WHERE session_id = ? AND order_id = ?',
      to,
      time,
      reason ?? null,
      sessionId,
      orderId,
    );
  }

  /**
   * Settle one fill atomically and idempotently: fill record, balance postings,
   * reservation change, order transition and audit event. Re-delivering the
   * same fillId is a no-op that returns false.
   */
  applyFill(f: FillRecord): boolean {
    return this.s.tx(() => {
      if (this.s.get('SELECT 1 FROM fills WHERE session_id = ? AND fill_id = ?', f.sessionId, f.fillId)) return false;
      const o = this.order(f.sessionId, f.orderId);
      if (!o) throw new LedgerError(`fill for unknown order ${f.orderId}`);
      if (!['accepted', 'partially_filled', 'cancel_pending'].includes(o.status))
        throw new LedgerError(`fill on ${o.status} order ${o.orderId}`);
      const qty = dec(f.qty);
      const price = dec(f.price);
      const fee = dec(f.fee);
      if (qty <= ZERO || price <= ZERO || fee < ZERO) throw new LedgerError('invalid fill amounts');
      if (o.filledQty + qty > o.qty) throw new LedgerError('fill exceeds order quantity');
      const notional = mul(price, qty, 'halfEven');

      this.s.run(
        'INSERT INTO fills (fill_id, order_id, session_id, side, price, qty, fee, time, event_ordinal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        f.fillId,
        f.orderId,
        f.sessionId,
        f.side,
        f.price,
        f.qty,
        f.fee,
        f.time,
        f.eventOrdinal,
      );
      this.s.fault('fill:after-insert');

      let reservedUsed: Dec;
      if (o.side === 'buy') {
        reservedUsed = notional + fee;
        if (reservedUsed > o.reservedRemaining) throw new LedgerError('buy fill exceeds reserved USD');
        this.post(o.sessionId, f.time, f.eventOrdinal, 'fill', f.fillId, {
          usd_reserved: -reservedUsed,
          btc_available: qty,
          btc_cost_basis: notional + fee,
          fees_paid: fee,
        });
      } else {
        reservedUsed = qty;
        if (qty > o.reservedRemaining) throw new LedgerError('sell fill exceeds reserved BTC');
        const b = this.balances(o.sessionId);
        const held = b.btcAvailable + b.btcReserved;
        const costOut = held === ZERO ? ZERO : held === qty ? b.btcCostBasis : mul(b.btcCostBasis, div(qty, held, 'halfEven'), 'halfEven');
        const proceeds = notional - fee;
        this.post(o.sessionId, f.time, f.eventOrdinal, 'fill', f.fillId, {
          btc_reserved: -qty,
          usd_available: proceeds,
          btc_cost_basis: -costOut,
          realized_pnl: proceeds - costOut,
          fees_paid: fee,
        });
      }
      this.s.fault('fill:after-post');
      const filled = o.filledQty + qty;
      this.s.run(
        'UPDATE orders SET filled_qty = ?, notional = ?, fees = ?, reserved_remaining = ? WHERE session_id = ? AND order_id = ?',
        str(filled),
        str(o.notional + notional),
        str(o.fees + fee),
        str(o.reservedRemaining - reservedUsed),
        o.sessionId,
        o.orderId,
      );
      this.transition(o.sessionId, o.orderId, filled === o.qty ? 'filled' : 'partially_filled', f.time);
      this.s.audit(o.sessionId, f.time, f.eventOrdinal, 'fill', {
        fillId: f.fillId,
        orderId: o.orderId,
        side: o.side,
        price: f.price,
        qty: f.qty,
        fee: f.fee,
      });
      this.s.fault('fill:before-commit');
      if (filled === o.qty) this.releaseRemainder(o.sessionId, o.orderId, f.time, f.eventOrdinal);
      return true;
    });
  }

  /** Move any unused reservation back to available (after fill completion, cancel, expiry or rejection). */
  private releaseRemainder(sessionId: string, orderId: string, time: number, ordinal: number): void {
    const o = this.order(sessionId, orderId)!;
    if (o.reservedRemaining === ZERO) return;
    this.post(
      o.sessionId,
      time,
      ordinal,
      'release',
      orderId,
      o.side === 'buy'
        ? { usd_reserved: -o.reservedRemaining, usd_available: o.reservedRemaining }
        : { btc_reserved: -o.reservedRemaining, btc_available: o.reservedRemaining },
    );
    this.s.run("UPDATE orders SET reserved_remaining = '0' WHERE session_id = ? AND order_id = ?", sessionId, orderId);
  }

  /** Terminate an open order (IOC remainder, cancel, expiry, rejection) and release its reservation. */
  close(sessionId: string, orderId: string, to: 'cancelled' | 'expired' | 'rejected', time: number, ordinal: number, reason: string): void {
    this.s.tx(() => {
      const o = this.order(sessionId, orderId);
      if (!o) throw new LedgerError(`unknown order ${orderId}`);
      if (['filled', 'cancelled', 'expired', 'rejected'].includes(o.status)) return;
      this.transition(sessionId, orderId, to, time, reason);
      this.releaseRemainder(sessionId, orderId, time, ordinal);
      this.s.audit(o.sessionId, time, ordinal, `order_${to}`, { orderId, reason, filledQty: str(o.filledQty) });
    });
  }

  /**
   * Rebuild every account from ledger entries and compare with the projection;
   * check non-negativity and order/fill consistency. Returns discrepancies.
   */
  verify(sessionId: string): string[] {
    const problems: string[] = [];
    const sums = new Map<string, Dec>();
    for (const r of this.s.all('SELECT account, amount FROM ledger_entries WHERE session_id = ?', sessionId)) {
      sums.set(r.account as string, (sums.get(r.account as string) ?? ZERO) + dec(r.amount as string));
    }
    const b = this.balances(sessionId);
    const expect: [string, Dec][] = [
      ['usd_available', b.usdAvailable],
      ['usd_reserved', b.usdReserved],
      ['btc_available', b.btcAvailable],
      ['btc_reserved', b.btcReserved],
      ['btc_cost_basis', b.btcCostBasis],
      ['realized_pnl', b.realizedPnl],
      ['fees_paid', b.feesPaid],
    ];
    for (const [k, v] of expect) {
      const s = sums.get(k) ?? ZERO;
      if (s !== v) problems.push(`${k}: projection ${str(v)} != ledger ${str(s)}`);
      if (CASH_ACCOUNTS.includes(k as (typeof CASH_ACCOUNTS)[number]) && v < ZERO) problems.push(`${k} negative`);
    }
    let openUsd = ZERO;
    let openBtc = ZERO;
    for (const o of this.s.all('SELECT * FROM orders WHERE session_id = ?', sessionId)) {
      const fills = this.s.all('SELECT qty FROM fills WHERE session_id = ? AND order_id = ?', sessionId, o.order_id as string);
      const fq = fills.reduce((a, f) => a + dec(f.qty as string), ZERO);
      if (fq !== dec(o.filled_qty as string)) problems.push(`order ${o.order_id}: fills ${str(fq)} != filled_qty ${o.filled_qty}`);
      if (fq > dec(o.qty as string)) problems.push(`order ${o.order_id}: overfilled`);
      const rem = dec(o.reserved_remaining as string);
      if (['filled', 'cancelled', 'expired', 'rejected'].includes(o.status as string) && rem !== ZERO) {
        problems.push(`order ${o.order_id}: terminal but still reserves ${str(rem)}`);
      }
      if (o.side === 'buy') openUsd += rem;
      else openBtc += rem;
    }
    if (openUsd !== b.usdReserved) problems.push(`reserved USD ${str(b.usdReserved)} != open order reservations ${str(openUsd)}`);
    if (openBtc !== b.btcReserved) problems.push(`reserved BTC ${str(b.btcReserved)} != open order reservations ${str(openBtc)}`);
    const dupes = this.s.all('SELECT fill_id, COUNT(*) AS n FROM fills WHERE session_id = ? GROUP BY fill_id HAVING n > 1', sessionId);
    if (dupes.length) problems.push(`duplicate fills: ${dupes.map((d) => d.fill_id).join(',')}`);
    return problems;
  }
}
