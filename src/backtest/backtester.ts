import type { Candle, ExitReason, Fees, MarketInfo, TradeRecord } from '../core/types';
import { exitLevels, type Strategy } from '../strategy/types';
import { RiskEngine } from '../risk/engine';
import { HARD_LIMITS } from '../risk/limits';
import { openDb } from '../persistence/db';
import { Store } from '../persistence/store';
import { worstCaseLossUsd, type CostModel } from '../economics/costs';
import { floorToStep, roundToStep, utcDayStart } from '../core/util';

export interface BacktestOptions {
  strategy: Strategy;
  /** Reuse a `strategy.prepare(candles)` result (must be for the same candles). */
  prepared?: object;
  /**
   * Random-entry null test: enter at exactly these bar indices instead of on
   * signals, still subject to the risk engine and using the strategy's own
   * exit sizing at that bar.
   */
  forcedEntries?: Set<number>;
  fees: Fees;
  spreadBps: number;
  takerSlippageBps: number;
  startingUsd: number;
  market: MarketInfo;
  /** Fraction of max order value used per entry (same as live engine). */
  sizeFraction?: number;
  /**
   * In live trading a consecutive-loss shutdown waits for a human reset. In a
   * backtest we resume on the next UTC day and count the shutdowns instead.
   */
  resumeAfterShutdown?: boolean;
}

export interface BacktestResult {
  trades: TradeRecord[];
  bars: number;
  startTs: number;
  endTs: number;
  signals: number;
  entriesPlaced: number;
  entriesFilled: number;
  entriesBlocked: number;
  shutdowns: number;
  netPnl: number;
  grossPnl: number;
  fees: number;
  winRate: number;
  profitFactor: number;
  avgNetPerTrade: number;
  maxDrawdownUsd: number;
  finalEquity: number;
  exitReasons: Record<string, number>;
}

/**
 * Bar-by-bar simulation on 1m candles using the SAME strategy, risk engine and
 * conservative fill model as the paper adapter:
 *  - entry: post-only bid at (close - half spread); fills only if a later
 *    bar's low trades strictly below it within the entry timeout (non-fills
 *    and adverse selection are modelled, not assumed away)
 *  - on the fill bar only the stop is checked (worst case)
 *  - stop: taker at stop (or the bar open if it gapped through) minus half
 *    spread and slippage; if stop and target are both touched in one bar the
 *    stop is assumed to have hit first
 *  - take profit: maker fill only when the high trades strictly above target
 *  - max hold / risk flatten: taker at the close
 */
export function runBacktest(candles: Candle[], o: BacktestOptions): BacktestResult {
  const store = new Store(openDb(':memory:'));
  const risk = new RiskEngine(store, HARD_LIMITS);
  const strategy = o.strategy;
  const ex = strategy.execution;
  const costs: CostModel = { fees: o.fees, spreadBps: o.spreadBps, takerSlippageBps: o.takerSlippageBps };
  const prepared = o.prepared ?? strategy.prepare(candles);
  const halfSpread = o.spreadBps / 2 / 10_000;
  const slip = o.takerSlippageBps / 10_000;
  const timeoutBars = Math.max(1, Math.ceil(ex.entryTimeoutSec / 60));
  const sizeFraction = o.sizeFraction ?? 0.98;
  const resume = o.resumeAfterShutdown ?? true;

  let usd = o.startingUsd;
  let btc = 0;
  let pos: { tradeId: string; amount: number; entryPrice: number; entryFee: number; openedAt: number; stop: number; tp: number } | null =
    null;
  let pending: { price: number; amount: number; placedIdx: number; exits: { takeProfitPct: number; stopLossPct: number } } | null = null;
  let tradeSeq = 0;
  let signals = 0;
  let placed = 0;
  let filled = 0;
  let blocked = 0;
  let shutdowns = 0;
  let peak = usd;
  let maxDd = 0;
  let curDay = 0;
  let dayRealized = 0;
  const trades: TradeRecord[] = [];

  const closeTrade = (exitPrice: number, feeRate: number, now: number, reason: ExitReason) => {
    const p = pos!;
    const proceeds = p.amount * exitPrice;
    const exitFee = proceeds * feeRate;
    usd += proceeds - exitFee;
    btc -= p.amount;
    const gross = proceeds - p.amount * p.entryPrice;
    const t: TradeRecord = {
      tradeId: p.tradeId,
      symbol: o.market.symbol,
      amount: p.amount,
      entryPrice: p.entryPrice,
      exitPrice,
      entryFee: p.entryFee,
      exitFee,
      grossPnl: gross,
      netPnl: gross - p.entryFee - exitFee,
      openedAt: p.openedAt,
      closedAt: now,
      exitReason: reason,
      mode: 'backtest',
    };
    trades.push(t);
    dayRealized += t.netPnl;
    store.closePositionWithTrade(t);
    risk.onTradeClosed(t, now);
    pos = null;
  };

  const start = strategy.warmupBars();
  for (let i = start; i < candles.length; i++) {
    const c = candles[i]!;
    const now = c.ts + 60_000; // decisions happen at bar close

    const day = utcDayStart(now);
    if (day !== curDay) {
      curDay = day;
      dayRealized = 0;
      const h = risk.activeHalt(now);
      if (h?.kind === 'manual_reset' && resume) {
        shutdowns++;
        risk.resetHalt(now, 'backtest day rollover');
      }
    }

    if (pending) {
      if (c.low < pending.price) {
        filled++;
        const fee = pending.amount * pending.price * o.fees.maker;
        usd -= pending.amount * pending.price + fee;
        btc += pending.amount;
        const lv = exitLevels(pending.price, pending.exits);
        pos = {
          tradeId: `bt-${++tradeSeq}`,
          amount: pending.amount,
          entryPrice: pending.price,
          entryFee: fee,
          openedAt: now,
          stop: lv.stop,
          tp: lv.takeProfit,
        };
        pending = null;
        if (c.low <= pos.stop) closeTrade(pos.stop * (1 - halfSpread - slip), o.fees.taker, now, 'stop_loss');
      } else if (i - pending.placedIdx >= timeoutBars) {
        pending = null;
      }
    } else if (pos) {
      const p: NonNullable<typeof pos> = pos;
      const unrealized = p.amount * c.close * (1 - halfSpread - slip) * (1 - o.fees.taker) - p.amount * p.entryPrice - p.entryFee;
      const mustFlatten =
        dayRealized + unrealized <= -HARD_LIMITS.maxDailyLossUsd && risk.evaluateOpenPosition(now, unrealized).mustFlatten;
      if (c.open <= p.stop) closeTrade(c.open * (1 - halfSpread - slip), o.fees.taker, now, 'stop_loss');
      else if (c.low <= p.stop) closeTrade(p.stop * (1 - halfSpread - slip), o.fees.taker, now, 'stop_loss');
      else if (c.high > p.tp) closeTrade(p.tp, o.fees.maker, now, 'take_profit');
      else if (now - p.openedAt >= ex.maxHoldMinutes * 60_000) closeTrade(c.close * (1 - halfSpread - slip), o.fees.taker, now, 'max_hold');
      else if (mustFlatten) closeTrade(c.close * (1 - halfSpread - slip), o.fees.taker, now, 'risk_flatten');
    } else {
      const forced = o.forcedEntries;
      const sig = !forced || forced.has(i) ? strategy.signalAt(prepared, i, o.spreadBps) : null;
      if (sig && (forced || sig.enter)) {
        signals++;
        const price = roundToStep(c.close * (1 - halfSpread), o.market.priceTick);
        const amount = floorToStep((HARD_LIMITS.maxOrderValueUsd * sizeFraction) / price, o.market.amountStep);
        const value = amount * price;
        const d = risk.evaluateEntry({
          now,
          symbol: o.market.symbol,
          side: 'buy',
          orderValueUsd: value,
          exchangeMinValueUsd: Math.max(o.market.minCost, o.market.minAmount * price),
          worstCaseLossUsd: worstCaseLossUsd(value, sig.exits.stopLossPct, costs),
          dataAgeMs: 0,
          stateCertain: true,
          hasOpenPosition: false,
          openOrderCount: 0,
        });
        if (d.ok && value * (1 + o.fees.maker) <= usd) {
          placed++;
          pending = { price, amount, placedIdx: i, exits: sig.exits };
        } else {
          blocked++;
        }
      }
    }

    const equity = usd + btc * c.close;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }

  const last = candles.at(-1);
  if (pos && last) closeTrade(last.close * (1 - halfSpread - slip), o.fees.taker, last.ts + 60_000, 'shutdown');

  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl <= 0);
  const sumWin = wins.reduce((s, t) => s + t.netPnl, 0);
  const sumLoss = -losses.reduce((s, t) => s + t.netPnl, 0);
  const net = trades.reduce((s, t) => s + t.netPnl, 0);
  const exitReasons: Record<string, number> = {};
  for (const t of trades) exitReasons[t.exitReason] = (exitReasons[t.exitReason] ?? 0) + 1;
  return {
    trades,
    bars: candles.length,
    startTs: candles[0]?.ts ?? 0,
    endTs: last?.ts ?? 0,
    signals,
    entriesPlaced: placed,
    entriesFilled: filled,
    entriesBlocked: blocked,
    shutdowns,
    netPnl: net,
    grossPnl: trades.reduce((s, t) => s + t.grossPnl, 0),
    fees: trades.reduce((s, t) => s + t.entryFee + t.exitFee, 0),
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: sumLoss > 0 ? sumWin / sumLoss : sumWin > 0 ? Infinity : 0,
    avgNetPerTrade: trades.length ? net / trades.length : 0,
    maxDrawdownUsd: maxDd,
    finalEquity: usd + btc * (last?.close ?? 0),
    exitReasons,
  };
}
