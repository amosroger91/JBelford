import { createHash } from 'node:crypto';
import type { KalshiConfig } from './config';

/**
 * Deterministic Kalshi paper engine. It sees only recorded events, so a replay of a
 * recording reproduces every order, fill and settlement exactly.
 *
 * Money and prices are integers in units of $0.0001 (Kalshi quotes to 4 decimals);
 * our order sizes are whole contracts. One resting order per market at most.
 *
 * Fill model (queue-conservative, like the BTC paper broker):
 *  - We join the best bid on the favorite side, behind everything already displayed there.
 *  - A trade where the taker bought the OTHER side matched a bid on our side at
 *    (1 - taker price). At our price it consumes the queue ahead of us first; below our
 *    price it traded through our level, so we are filled completely.
 *  - Only trades stamped after our placement count. Cancellations ahead of us are assumed
 *    only when the displayed size falls below our queue estimate.
 */
export const UNIT = 10_000; // $1 = 10,000 units

export type Side = 'yes' | 'no';
export interface MarketInfo {
  ticker: string;
  series: string;
  closeTime: number;
  status: string;
  /** Kalshi fee type of the series; makers pay only on "..._maker_fees" types. */
  feeType: string;
  feeMultiplier: number;
}
export interface TradeRec {
  id: string;
  /** YES price in units. */
  yesPx: number;
  count: number;
  takerSide: Side;
  ts: number;
}
export type KalshiEvent =
  | { kind: 'markets'; t: number; markets: MarketInfo[] }
  | { kind: 'book'; t: number; ticker: string; yes: [number, number][]; no: [number, number][] }
  | { kind: 'trades'; t: number; ticker: string; trades: TradeRec[] }
  | { kind: 'result'; t: number; ticker: string; result: 'yes' | 'no' | 'void' }
  | { kind: 'stop'; t: number; reason: string };

interface Order {
  id: string;
  ticker: string;
  side: Side;
  price: number;
  qty: number;
  filled: number;
  queueAhead: number;
  placedAt: number;
}
interface Position {
  side: Side;
  qty: number;
  cost: number;
  fees: number;
}
export interface FillRow {
  t: number;
  orderId: string;
  ticker: string;
  side: Side;
  price: number;
  qty: number;
  fee: number;
  tradeId: string;
  through: boolean;
}
export interface SettlementRow {
  t: number;
  ticker: string;
  side: Side;
  qty: number;
  cost: number;
  fees: number;
  result: 'yes' | 'no' | 'void';
  pnl: number;
}
export interface OrderEventRow {
  t: number;
  orderId: string;
  ticker: string;
  action: 'place' | 'cancel';
  side: Side;
  price: number;
  qty: number;
  queueAhead: number;
  reason: string;
}

export class KalshiPaperEngine {
  cash: number;
  private readonly markets = new Map<string, MarketInfo>();
  private readonly orders = new Map<string, Order>();
  readonly positions = new Map<string, Position>();
  private readonly seen = new Set<string>();
  private seq = 0;
  stopped = false;
  readonly fills: FillRow[] = [];
  readonly settlements: SettlementRow[] = [];
  readonly orderEvents: OrderEventRow[] = [];
  events = 0;

  constructor(private readonly cfg: KalshiConfig) {
    this.cash = Math.round(cfg.bankrollUsd * UNIT);
  }

  /** Cash committed to resting orders. */
  reserved(): number {
    let r = 0;
    for (const o of this.orders.values()) r += (o.qty - o.filled) * o.price;
    return r;
  }

  free(): number {
    return this.cash - this.reserved();
  }

  /** Value with open positions marked at cost (they settle at 0 or $1). */
  equityAtCost(): number {
    let c = this.cash;
    for (const p of this.positions.values()) c += p.cost;
    return c;
  }

  openOrders(): Readonly<Order>[] {
    return [...this.orders.values()];
  }

  ingest(e: KalshiEvent): void {
    this.events++;
    switch (e.kind) {
      case 'markets':
        for (const m of e.markets) this.markets.set(m.ticker, m);
        break;
      case 'book':
        this.onBook(e);
        break;
      case 'trades':
        this.onTrades(e);
        break;
      case 'result':
        this.onResult(e);
        break;
      case 'stop':
        this.stopped = true;
        for (const o of [...this.orders.values()]) this.cancel(o, e.t, `stop: ${e.reason}`);
        break;
    }
    // Orders never outlive their market's close.
    for (const o of [...this.orders.values()]) {
      const m = this.markets.get(o.ticker);
      if (m && e.t >= m.closeTime) this.cancel(o, e.t, 'market closed');
    }
  }

  private cancel(o: Order, t: number, reason: string): void {
    this.orders.delete(o.ticker);
    this.orderEvents.push({
      t,
      orderId: o.id,
      ticker: o.ticker,
      action: 'cancel',
      side: o.side,
      price: o.price,
      qty: o.qty - o.filled,
      queueAhead: o.queueAhead,
      reason,
    });
  }

  private onBook(e: Extract<KalshiEvent, { kind: 'book' }>): void {
    const m = this.markets.get(e.ticker);
    const existing = this.orders.get(e.ticker);
    const best = (lv: [number, number][]) => lv.reduce<[number, number] | null>((b, x) => (x[1] > 0 && (!b || x[0] > b[0]) ? x : b), null);
    const yes = best(e.yes);
    const no = best(e.no);
    const minFav = Math.round(this.cfg.minFavoriteBid * UNIT);
    let fav: { side: Side; price: number } | null = null;
    if (yes && yes[0] >= minFav && yes[0] < UNIT) fav = { side: 'yes', price: yes[0] };
    else if (no && no[0] >= minFav && no[0] < UNIT) fav = { side: 'no', price: no[0] };
    const levelSize = (side: Side, price: number) => (side === 'yes' ? e.yes : e.no).find((x) => x[0] === price)?.[1] ?? 0;

    if (existing) {
      // Others' displayed size at our level bounds how much can still be queued ahead of us.
      existing.queueAhead = Math.min(existing.queueAhead, levelSize(existing.side, existing.price));
      if (!fav || fav.side !== existing.side) return this.cancel(existing, e.t, 'no longer a favorite-side quote');
      if (fav.price !== existing.price && existing.filled === 0) this.cancel(existing, e.t, 're-quote to the new best bid');
      else return;
    }
    if (this.stopped || !m || m.status !== 'active' || !fav) return;
    if (e.t >= m.closeTime - this.cfg.stopPostingSecondsBeforeClose * 1000) return;
    const pos = this.positions.get(e.ticker);
    if (pos && pos.side !== fav.side) return; // never hold both sides of one market
    const cap = Math.round(this.cfg.maxCollateralPerMarketUsd * UNIT) - (pos?.cost ?? 0);
    const qty = Math.floor(Math.min(this.cfg.orderContracts, cap / fav.price, this.free() / fav.price));
    if (qty < 1) return;
    const o: Order = {
      id: `k-${++this.seq}`,
      ticker: e.ticker,
      side: fav.side,
      price: fav.price,
      qty,
      filled: 0,
      queueAhead: levelSize(fav.side, fav.price),
      placedAt: e.t,
    };
    this.orders.set(e.ticker, o);
    this.orderEvents.push({
      t: e.t,
      orderId: o.id,
      ticker: o.ticker,
      action: 'place',
      side: o.side,
      price: o.price,
      qty,
      queueAhead: o.queueAhead,
      reason: 'join best favorite bid',
    });
  }

  private onTrades(e: Extract<KalshiEvent, { kind: 'trades' }>): void {
    for (const tr of [...e.trades].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))) {
      if (this.seen.has(tr.id)) continue;
      this.seen.add(tr.id);
      const o = this.orders.get(e.ticker);
      if (!o || tr.ts <= o.placedAt || tr.takerSide === o.side) continue;
      const makerPx = o.side === 'yes' ? tr.yesPx : UNIT - tr.yesPx; // price the bid on our side traded at
      if (makerPx > o.price) continue; // matched a better bid than ours
      const through = makerPx < o.price;
      let q: number;
      if (through) q = o.qty - o.filled;
      else {
        const left = tr.count - o.queueAhead;
        o.queueAhead = Math.max(0, o.queueAhead - tr.count);
        q = Math.min(o.qty - o.filled, Math.floor(Math.max(0, left) + 1e-9));
      }
      if (q > 0) this.fill(o, q, e.t, tr.id, through);
    }
  }

  private fill(o: Order, q: number, t: number, tradeId: string, through: boolean): void {
    const m = this.markets.get(o.ticker);
    const p = o.price / UNIT;
    // Maker fee only on "*maker_fees" series; Kalshi rounds fees up to the cent.
    const fee = m && /maker/.test(m.feeType) ? Math.ceil(0.0175 * m.feeMultiplier * q * p * (1 - p) * 100) * 100 : 0;
    o.filled += q;
    const cost = q * o.price;
    this.cash -= cost + fee;
    const pos = this.positions.get(o.ticker) ?? { side: o.side, qty: 0, cost: 0, fees: 0 };
    pos.qty += q;
    pos.cost += cost;
    pos.fees += fee;
    this.positions.set(o.ticker, pos);
    this.fills.push({ t, orderId: o.id, ticker: o.ticker, side: o.side, price: o.price, qty: q, fee, tradeId, through });
    if (o.filled >= o.qty) this.orders.delete(o.ticker);
  }

  private onResult(e: Extract<KalshiEvent, { kind: 'result' }>): void {
    const o = this.orders.get(e.ticker);
    if (o) this.cancel(o, e.t, 'market settled');
    const pos = this.positions.get(e.ticker);
    if (!pos) return;
    const payout = e.result === 'void' ? pos.cost : e.result === pos.side ? pos.qty * UNIT : 0;
    this.cash += payout;
    this.positions.delete(e.ticker);
    this.settlements.push({
      t: e.t,
      ticker: e.ticker,
      side: pos.side,
      qty: pos.qty,
      cost: pos.cost,
      fees: pos.fees,
      result: e.result,
      pnl: payout - pos.cost - pos.fees,
    });
  }

  /** Canonical result hash: replaying the same recording must reproduce it. */
  hash(): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          cash: this.cash,
          fills: this.fills,
          settlements: this.settlements,
          orders: this.orderEvents,
          open: [...this.positions.entries()].sort(),
        }),
      )
      .digest('hex');
  }

  summary() {
    const settled = this.settlements;
    const pnl = settled.reduce((a, s) => a + s.pnl, 0);
    const contracts = settled.reduce((a, s) => a + s.qty, 0);
    return {
      startUsd: this.cfg.bankrollUsd,
      cashUsd: this.cash / UNIT,
      equityAtCostUsd: this.equityAtCost() / UNIT,
      realizedPnlUsd: pnl / UNIT,
      fills: this.fills.length,
      filledContracts: this.fills.reduce((a, f) => a + f.qty, 0),
      settledMarkets: settled.length,
      settledContracts: contracts,
      wins: settled.filter((s) => s.pnl > 0).length,
      losses: settled.filter((s) => s.pnl < 0).length,
      pnlPerContractCents: contracts ? (pnl / UNIT / contracts) * 100 : null,
      openPositions: this.positions.size,
      ordersPlaced: this.orderEvents.filter((x) => x.action === 'place').length,
      events: this.events,
    };
  }
}
