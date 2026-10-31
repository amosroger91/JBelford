import { openDb } from '../src/persistence/db';
import { Store } from '../src/persistence/store';
import type { Candle, MarketInfo, TradeRecord } from '../src/core/types';
import type { StrategyParams } from '../src/config/schema';

export const FEES = { maker: 0.004, taker: 0.008 };

export const MARKET: MarketInfo = { symbol: 'BTC/USD', minAmount: 0.00006, minCost: 0.5, amountStep: 1e-8, priceTick: 0.1 };

export const PARAMS: StrategyParams = {
  emaFast1m: 9,
  rocBars: 3,
  minRocPct: 0.15,
  volLookback: 20,
  volMult: 1.5,
  trendEmaFast5m: 9,
  trendEmaSlow5m: 21,
  maxSpreadBps: 5,
  maxExtensionPct: 0.6,
  takeProfitPct: 1.0,
  stopLossPct: 0.5,
  maxHoldMinutes: 120,
  entryTimeoutSec: 60,
  minNetTargetPct: 0.05,
};

export function memStore(): Store {
  return new Store(openDb(':memory:'));
}

export const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);

export function trade(over: Partial<TradeRecord> & { netPnl: number; closedAt: number }): TradeRecord {
  return {
    tradeId: 't-' + Math.random().toString(36).slice(2, 8),
    symbol: 'BTC/USD',
    amount: 0.0001,
    entryPrice: 77000,
    exitPrice: 77000,
    entryFee: 0.03,
    exitFee: 0.03,
    grossPnl: over.netPnl + 0.06,
    openedAt: over.closedAt - 60_000,
    exitReason: over.netPnl > 0 ? 'take_profit' : 'stop_loss',
    mode: 'paper',
    ...over,
  };
}

/** Candles following a price path, with constant volume unless overridden. */
export function candlesFromCloses(closes: number[], start = T0, volume = 1, volumes?: number[]): Candle[] {
  return closes.map((c, i) => {
    const open = i === 0 ? c : closes[i - 1]!;
    return {
      ts: start + i * 60_000,
      open,
      high: Math.max(open, c) * 1.0001,
      low: Math.min(open, c) * 0.9999,
      close: c,
      volume: volumes?.[i] ?? volume,
    };
  });
}
