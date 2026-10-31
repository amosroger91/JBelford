import { canonicalJson, sha256 } from '../config';
import type { TradingStore } from '../store';

/**
 * Canonical financial journal (plan acceptance test 18). Contains every
 * decision, risk outcome, order, fill, ledger posting, valuation and the final
 * balances, keyed by deterministic identities (decision/order/fill ids derive
 * from bar times and event ordinals). Run metadata is excluded: session ids,
 * client order ids (they embed the session id), audit rows, wall-clock export
 * times and machine paths. Two runs with the same events, config, recorded
 * decisions and clock rules must produce the same hash.
 */
export function canonicalJournal(store: TradingStore, sessionId: string) {
  const q = (sql: string) => store.all(sql, sessionId);
  return {
    decisions: q(
      'SELECT decision_id, snapshot_id, generation, strategy, requested_at, completed_at, outcome, intent_json, detail, event_ordinal FROM decisions WHERE session_id = ? ORDER BY event_ordinal, decision_id',
    ),
    risk: q('SELECT decision_id, check_name, passed, detail, time, event_ordinal FROM risk_events WHERE session_id = ? ORDER BY id'),
    orders: q(
      `SELECT order_id, decision_id, side, purpose, qty, filled_qty, notional, fees, guard_price, reserved, reserved_remaining, status,
        submitted_at, arrival_at, valid_until, policy_version, snapshot_id, reject_reason FROM orders WHERE session_id = ? ORDER BY submitted_at, order_id`,
    ),
    fills: q(
      'SELECT fill_id, order_id, side, price, qty, fee, time, event_ordinal FROM fills WHERE session_id = ? ORDER BY event_ordinal, fill_id',
    ),
    ledger: q(
      "SELECT time, event_ordinal, ref_type, CASE WHEN ref_type = 'open' THEN 'session' ELSE ref_id END AS ref_id, account, amount FROM ledger_entries WHERE session_id = ? ORDER BY id",
    ),
    valuations: q(
      'SELECT time, event_ordinal, mark_bid, mark_mid, equity_mid, equity_bid, liquidation_value, stale FROM valuations WHERE session_id = ? ORDER BY id',
    ),
    balances: store.get(
      'SELECT usd_available, usd_reserved, btc_available, btc_reserved, btc_cost_basis, realized_pnl, fees_paid FROM balances WHERE session_id = ?',
      sessionId,
    ),
  };
}

export function journalHash(store: TradingStore, sessionId: string): { hash: string; counts: Record<string, number> } {
  const j = canonicalJournal(store, sessionId);
  return {
    hash: sha256(canonicalJson(j)),
    counts: {
      decisions: j.decisions.length,
      risk: j.risk.length,
      orders: j.orders.length,
      fills: j.fills.length,
      ledger: j.ledger.length,
      valuations: j.valuations.length,
    },
  };
}

/** First differing section/row between two journals (for diagnosing a replay mismatch). */
export function diffJournals(a: ReturnType<typeof canonicalJournal>, b: ReturnType<typeof canonicalJournal>): string | null {
  for (const k of Object.keys(a) as (keyof typeof a)[]) {
    const x = canonicalJson(a[k]);
    const y = canonicalJson(b[k]);
    if (x === y) continue;
    if (Array.isArray(a[k]) && Array.isArray(b[k])) {
      const ra = a[k] as unknown[];
      const rb = b[k] as unknown[];
      for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
        if (canonicalJson(ra[i]) !== canonicalJson(rb[i])) return `${k}[${i}]: ${canonicalJson(ra[i])} != ${canonicalJson(rb[i])}`;
      }
    }
    return `${k} differs`;
  }
  return null;
}
