import type { Fees } from '../core/types';

export interface CostModel {
  fees: Fees;
  /** Full bid/ask spread in basis points. */
  spreadBps: number;
  /** Extra adverse price movement on taker (market) exits, bps. */
  takerSlippageBps: number;
  /** Extra buffer for a stop executing beyond its trigger (gaps), percent. */
  stopGapBufferPct?: number;
}

export interface RoundTripEconomics {
  /** Net return on notional when the take-profit (maker exit) is hit, percent. */
  winNetPct: number;
  /** Net return on notional when the stop (taker exit) is hit, percent (negative). */
  lossNetPct: number;
  /** Total fees + spread + slippage drag for a winning trade, percent. */
  winCostPct: number;
  /** Total fees + spread + slippage drag for a losing trade, percent. */
  lossCostPct: number;
  /** Win rate needed to break even after all costs. */
  breakevenWinRate: number;
}

/**
 * Entry is a post-only limit buy (maker) at the bid, so it pays the maker fee
 * and no spread. A take-profit exit is a post-only limit sell (maker). A stop
 * or timed exit is a market sell (taker) that crosses half the spread and
 * suffers slippage.
 */
export function roundTripEconomics(takeProfitPct: number, stopLossPct: number, c: CostModel): RoundTripEconomics {
  const tp = takeProfitPct / 100;
  const sl = stopLossPct / 100;
  const halfSpread = c.spreadBps / 2 / 10_000;
  const slip = c.takerSlippageBps / 10_000;
  const gap = (c.stopGapBufferPct ?? 0) / 100;

  const winCost = c.fees.maker + c.fees.maker * (1 + tp);
  const winNet = tp - winCost;

  const exitPx = 1 - sl - halfSpread - slip - gap;
  const lossCost = c.fees.maker + c.fees.taker * exitPx + halfSpread + slip + gap;
  const lossNet = -sl - lossCost;

  const breakeven = winNet <= 0 ? 1 : -lossNet / (winNet - lossNet);
  return {
    winNetPct: winNet * 100,
    lossNetPct: lossNet * 100,
    winCostPct: winCost * 100,
    lossCostPct: lossCost * 100,
    breakevenWinRate: breakeven,
  };
}

export function expectedValuePct(winRate: number, e: RoundTripEconomics): number {
  return winRate * e.winNetPct + (1 - winRate) * e.lossNetPct;
}

/** Dollar loss if the stop is hit on a position of `notionalUsd`. Positive. */
export function worstCaseLossUsd(notionalUsd: number, stopLossPct: number, c: CostModel): number {
  return (-roundTripEconomics(0, stopLossPct, c).lossNetPct / 100) * notionalUsd;
}

/** Net take-profit after maker fees on both sides, percent. */
export function netTargetPct(takeProfitPct: number, fees: Fees): number {
  const tp = takeProfitPct / 100;
  return (tp - fees.maker - fees.maker * (1 + tp)) * 100;
}
