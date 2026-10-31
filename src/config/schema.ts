import { z } from 'zod';

/**
 * Strategy parameters: the ONLY settings Claude may propose changes to.
 * `.strict()` rejects unknown keys, so a proposal cannot smuggle in risk or
 * mode settings. Bounds keep proposals within sane testing ranges.
 */
export const StrategyParamsObject = z
  .object({
    emaFast1m: z.number().int().min(3).max(50),
    rocBars: z.number().int().min(1).max(10),
    minRocPct: z.number().min(0.01).max(2),
    volLookback: z.number().int().min(5).max(100),
    volMult: z.number().min(0.5).max(10),
    trendEmaFast5m: z.number().int().min(3).max(50),
    trendEmaSlow5m: z.number().int().min(5).max(200),
    maxSpreadBps: z.number().min(0.1).max(50),
    maxExtensionPct: z.number().min(0).max(5),
    takeProfitPct: z.number().min(0.1).max(5),
    stopLossPct: z.number().min(0.1).max(5),
    maxHoldMinutes: z.number().int().min(5).max(1440),
    entryTimeoutSec: z.number().int().min(10).max(600),
    minNetTargetPct: z.number().min(0).max(2),
  })
  .strict();

export const STRATEGY_PARAM_KEYS = Object.keys(StrategyParamsObject.shape) as (keyof z.infer<typeof StrategyParamsObject>)[];

export const StrategyParamsSchema = StrategyParamsObject.refine((p) => p.trendEmaFast5m < p.trendEmaSlow5m, {
  message: 'trendEmaFast5m must be less than trendEmaSlow5m',
});

export type StrategyParams = z.infer<typeof StrategyParamsSchema>;

export const AppConfigSchema = z
  .object({
    exchange: z.object({
      id: z.string().min(1),
      symbol: z.literal('BTC/USD'),
      fees: z.object({
        maker: z.number().min(0).max(0.02),
        taker: z.number().min(0).max(0.02),
        source: z.string(),
      }),
      fallback: z.object({
        minAmount: z.number().positive(),
        minCost: z.number().nonnegative(),
        amountStep: z.number().positive(),
        priceTick: z.number().positive(),
      }),
    }),
    marketData: z.object({
      useWebSocket: z.boolean(),
      pollIntervalMs: z.number().int().min(1000),
      candlePollIntervalMs: z.number().int().min(2000),
      bootstrapCandles: z.number().int().min(150).max(1000),
    }),
    paper: z.object({
      startingUsd: z.number().positive(),
      takerSlippageBps: z.number().min(0),
      faults: z.object({
        ambiguousCreateRate: z.number().min(0).max(1),
        rejectRate: z.number().min(0).max(1),
      }),
    }),
    backtest: z.object({
      dataExchange: z.string().min(1),
      spreadBps: z.number().min(0),
      takerSlippageBps: z.number().min(0),
      startingUsd: z.number().positive(),
      inSampleFraction: z.number().gt(0.3).lt(0.95),
    }),
    paths: z.object({
      stateDir: z.string(),
      dataDir: z.string(),
      reportsDir: z.string(),
    }),
  })
  .strict();

export type AppConfig = z.infer<typeof AppConfigSchema>;
