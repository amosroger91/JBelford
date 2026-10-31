import type { ApprovedOrder, FeedHealth, Side, TradeIntent } from './domain';
import type { PaperConfig } from './config';
import type { ProductMeta } from './market/coinbase';
import { ONE, ZERO, abs, bps, dec, div, max, min, mul, quantize, str, type Dec } from './money';

export interface RiskCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface RiskContext {
  sessionId: string;
  now: number;
  /** Decision completion time; simulated arrival = this + execution delay. */
  decisionCompletedAt: number;
  generation: number;
  currentGeneration: number;
  expectedSnapshotId: string;
  feed: FeedHealth;
  bookSynced: boolean;
  bestBid: Dec | null;
  bestAsk: Dec | null;
  touchDepthUsd: { bid: Dec; ask: Dec };
  usdAvailable: Dec;
  btcAvailable: Dec;
  btcHeld: Dec;
  /** BTC quantity of open (pending) buy orders not yet filled. */
  pendingBuyQty: Dec;
  pendingSellQty: Dec;
  equity: Dec;
  dayStartEquity: Dec;
  hwmEquity: Dec;
  openOrders: number;
  ordersLastHour: number;
  knownOperatingCostUsd: Dec;
  operatingCostUnknown: boolean;
  usesPaidModel: boolean;
  paused: boolean;
}

export interface RiskResult {
  order: Omit<ApprovedOrder, 'orderId' | 'clientOrderId'> | null;
  checks: RiskCheck[];
  /** Why no order was produced (hold, below threshold, rejected...). */
  noOrderReason: string | null;
}

/**
 * Authoritative, deterministic sizing and risk (plan section 6). A strategy
 * proposes only a target BTC weight; this code alone decides whether an order
 * exists, its side and quantity. Limits include pending orders and fees. The
 * model/strategy cannot override a rejection.
 */
export function evaluateIntent(intent: TradeIntent | null, ctx: RiskContext, cfg: PaperConfig, product: ProductMeta): RiskResult {
  const checks: RiskCheck[] = [];
  const add = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });
  const fail = (reason: string): RiskResult => ({ order: null, checks, noOrderReason: reason });
  const r = cfg.risk;

  if (!intent) return fail('no valid intent (strategy output rejected or unavailable): hold');
  add(
    'generation',
    intent && ctx.generation === ctx.currentGeneration,
    `decision gen ${ctx.generation}, session gen ${ctx.currentGeneration}`,
  );
  if (ctx.generation !== ctx.currentGeneration) return fail('stale decision from an older session generation');
  add('snapshot', intent.snapshotId === ctx.expectedSnapshotId, `intent ${intent.snapshotId} vs expected ${ctx.expectedSnapshotId}`);
  if (intent.snapshotId !== ctx.expectedSnapshotId) return fail('intent references an unknown snapshot');
  add('expiry', ctx.now <= intent.validUntil, `now ${ctx.now} validUntil ${intent.validUntil}`);
  if (ctx.now > intent.validUntil) return fail('intent expired');
  if (intent.action === 'hold') return fail('strategy holds');
  if (ctx.paused) return fail('session paused: no new orders');

  let target: Dec;
  try {
    target = dec(intent.targetWeight ?? 'x');
  } catch {
    add('target', false, `invalid target weight ${String(intent.targetWeight)}`);
    return fail('invalid target weight');
  }
  if (target < ZERO) target = ZERO;
  const maxExp = dec(r.maxExposure);
  if (target > maxExp) {
    add('exposure_clamp', true, `target ${str(target)} clamped to max exposure ${r.maxExposure}`);
    target = maxExp;
  }

  const feedOk = ctx.feed === 'healthy' && ctx.bookSynced && !!ctx.bestBid && !!ctx.bestAsk && ctx.bestBid < ctx.bestAsk;
  add('feed', feedOk, `feed ${ctx.feed}, synced ${ctx.bookSynced}`);
  if (!feedOk) return fail('market data not healthy');
  const bid = ctx.bestBid!;
  const ask = ctx.bestAsk!;
  const mid = (bid + ask) / 2n;
  const spreadBps = bps(ask - bid, mid);
  add('spread', spreadBps <= r.maxSpreadBps, `${spreadBps.toFixed(3)} bps (max ${r.maxSpreadBps})`);
  if (spreadBps > r.maxSpreadBps) return fail('spread too wide');

  if (ctx.equity <= ZERO) return fail('no equity');
  const exposureQty = ctx.btcHeld + ctx.pendingBuyQty - ctx.pendingSellQty;
  const currentWeight = div(mul(exposureQty, mid), ctx.equity);
  let deltaUsd = mul(target - currentWeight, ctx.equity);
  const side: Side = deltaUsd > ZERO ? 'buy' : 'sell';
  add('exposure', true, `current ${str(currentWeight)} (incl. pending) target ${str(target)}`);

  const threshold = mul(dec(r.minRebalancePctEquity), ctx.equity);
  if (abs(deltaUsd) < threshold) {
    add('rebalance_threshold', false, `|delta| ${str(abs(deltaUsd))} < ${str(threshold)}`);
    return fail('change below minimum rebalance threshold');
  }

  if (side === 'buy') {
    const dayLoss = ctx.dayStartEquity > ZERO ? div(ctx.dayStartEquity - ctx.equity, ctx.dayStartEquity) : ZERO;
    const dd = ctx.hwmEquity > ZERO ? div(ctx.hwmEquity - ctx.equity, ctx.hwmEquity) : ZERO;
    const dayOk = dayLoss < dec(r.dailyLossPausePct);
    const ddOk = dd < dec(r.drawdownPausePct);
    add('daily_loss', dayOk, `UTC-day loss ${str(dayLoss)} (pause at ${r.dailyLossPausePct})`);
    add('drawdown', ddOk, `drawdown from high-water mark ${str(dd)} (pause at ${r.drawdownPausePct})`);
    if (!dayOk || !ddOk) return fail('loss limit reached: new risk paused (holdings retained)');
    const budget = dec(r.operatingCostBudgetUsd);
    const costOk = !ctx.usesPaidModel || (!ctx.operatingCostUnknown && (budget === ZERO || ctx.knownOperatingCostUsd <= budget));
    add(
      'operating_cost',
      costOk,
      ctx.usesPaidModel ? `known ${str(ctx.knownOperatingCostUsd)} unknown=${ctx.operatingCostUnknown}` : 'no paid model',
    );
    if (!costOk) return fail('operating cost budget exceeded or costs unknown');
    const depthOk = ctx.touchDepthUsd.ask >= dec(r.minTouchDepthUsd);
    add('touch_depth', depthOk, `ask touch $${str(ctx.touchDepthUsd.ask)} (min ${r.minTouchDepthUsd})`);
    if (!depthOk) return fail('insufficient touch depth');
  } else {
    const depthOk = ctx.touchDepthUsd.bid >= dec(r.minTouchDepthUsd);
    add('touch_depth', depthOk, `bid touch $${str(ctx.touchDepthUsd.bid)} (min ${r.minTouchDepthUsd})`);
    if (!depthOk) return fail('insufficient touch depth');
  }

  add('open_orders', ctx.openOrders < r.maxOpenOrders, `${ctx.openOrders} open (max ${r.maxOpenOrders})`);
  if (ctx.openOrders >= r.maxOpenOrders) return fail('maximum open orders reached');
  add('order_rate', ctx.ordersLastHour < r.maxOrdersPerHour, `${ctx.ordersLastHour} in last hour (max ${r.maxOrdersPerHour})`);
  if (ctx.ordersLastHour >= r.maxOrdersPerHour) return fail('order rate limit reached');

  const cap = mul(dec(r.maxOrderPctEquity), ctx.equity);
  if (abs(deltaUsd) > cap) {
    add('order_notional_cap', true, `|delta| ${str(abs(deltaUsd))} capped at ${str(cap)}`);
    deltaUsd = side === 'buy' ? cap : -cap;
  }

  const rate = dec(cfg.fees.takerRate);
  const g = dec(String(cfg.execution.guardBps / 10_000));
  const priceStep = dec(product.price_increment ?? product.quote_increment);
  const baseStep = dec(product.base_increment);
  let qty: Dec;
  let guard: Dec;
  let reserved: Dec;
  if (side === 'buy') {
    guard = quantize(mul(ask, ONE + g, 'floor'), priceStep, 'floor');
    // Size at the guard price so the reservation always covers notional + fee.
    const affordable = div(ctx.usdAvailable, mul(guard, ONE + rate, 'ceil'), 'floor');
    qty = quantize(min(div(abs(deltaUsd), ask, 'floor'), affordable), baseStep, 'floor');
    reserved = quantize(mul(mul(qty, guard, 'ceil'), ONE + rate, 'ceil'), dec('0.00000001'), 'ceil');
    reserved = min(reserved, ctx.usdAvailable);
    add('funds', qty > ZERO, `USD available ${str(ctx.usdAvailable)}, reserve ${str(reserved)}`);
  } else {
    guard = quantize(mul(bid, ONE - g, 'ceil'), priceStep, 'ceil');
    qty = quantize(min(div(abs(deltaUsd), bid, 'floor'), ctx.btcAvailable), baseStep, 'floor');
    reserved = qty;
    add('funds', qty > ZERO, `BTC available ${str(ctx.btcAvailable)}`);
  }
  if (qty <= ZERO) return fail('insufficient available funds');
  const notional = mul(qty, side === 'buy' ? ask : bid);
  const minsOk = qty >= dec(product.base_min_size) && qty <= dec(product.base_max_size) && notional >= dec(product.quote_min_size);
  add('product_limits', minsOk, `qty ${str(qty)} notional ${str(notional)} (min ${product.quote_min_size} USD)`);
  if (!minsOk) return fail('below product minimum size/notional');

  return {
    checks,
    noOrderReason: null,
    order: {
      sessionId: ctx.sessionId,
      decisionId: intent.decisionId,
      side,
      qty: str(qty),
      guardPrice: str(guard),
      reserved: str(max(reserved, ZERO)),
      submittedAt: ctx.now,
      arrivalAt: ctx.decisionCompletedAt + cfg.execution.delayMs,
      validUntil: intent.validUntil,
      policyVersion: r.version,
      snapshotId: intent.snapshotId,
      purpose: 'strategy',
    },
  };
}
