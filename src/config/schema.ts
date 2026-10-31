import { z } from 'zod';

/**
 * Strategy parameters: the ONLY settings Claude may propose changes to.
 * Every object is `.strict()`, so a proposal cannot smuggle in risk, mode or
 * exchange settings. Bounds keep values in an intraday (minutes to hours) range.
 */

/** Execution settings shared by every intraday strategy. */
const executionShape = {
  entryTimeoutSec: z.number().int().min(10).max(600),
  /** Intraday by design: positions are always closed within 12 hours. */
  maxHoldMinutes: z.number().int().min(5).max(720),
  maxSpreadBps: z.number().min(0.1).max(50),
  /** Minimum take-profit left after maker fees on both sides, percent. */
  minNetTargetPct: z.number().min(0).max(5),
  /** UTC hours (0-23) in which new entries are allowed. */
  allowedHoursUtc: z.array(z.number().int().min(0).max(23)).min(1).max(24),
};

export const MomentumParamsObject = z
  .object({
    emaFast1m: z.number().int().min(3).max(50),
    rocBars: z.number().int().min(1).max(10),
    minRocPct: z.number().min(0.01).max(2),
    volLookback: z.number().int().min(5).max(100),
    volMult: z.number().min(0.5).max(10),
    trendEmaFast5m: z.number().int().min(3).max(50),
    trendEmaSlow5m: z.number().int().min(5).max(200),
    maxExtensionPct: z.number().min(0).max(5),
    takeProfitPct: z.number().min(0.1).max(8),
    stopLossPct: z.number().min(0.1).max(5),
    ...executionShape,
  })
  .strict();

export const MomentumParamsSchema = MomentumParamsObject.refine((p) => p.trendEmaFast5m < p.trendEmaSlow5m, {
  message: 'trendEmaFast5m must be less than trendEmaSlow5m',
});
export type MomentumParams = z.infer<typeof MomentumParamsSchema>;

/** Buy stretched sell-offs below rolling VWAP once a reversal bar prints; target partial reversion. */
export const VwapReversionParamsObject = z
  .object({
    vwapBars: z.number().int().min(30).max(1440),
    minDevPct: z.number().min(0.2).max(8),
    rsiPeriod: z.number().int().min(2).max(30),
    rsiMax: z.number().min(5).max(50),
    volLookback: z.number().int().min(5).max(200),
    volMult: z.number().min(0.5).max(10),
    crashLookbackBars: z.number().int().min(30).max(1440),
    maxCrashPct: z.number().min(0.5).max(25),
    revertFraction: z.number().min(0.1).max(1),
    minTakeProfitPct: z.number().min(0.2).max(8),
    maxTakeProfitPct: z.number().min(0.3).max(10),
    stopLossPct: z.number().min(0.2).max(5),
    ...executionShape,
  })
  .strict();

export const VwapReversionParamsSchema = VwapReversionParamsObject.refine((p) => p.minTakeProfitPct <= p.maxTakeProfitPct, {
  message: 'minTakeProfitPct must be <= maxTakeProfitPct',
});
export type VwapReversionParams = z.infer<typeof VwapReversionParamsSchema>;

/** Volatility-compression breakout on a higher intraday timeframe with ATR-scaled exits. */
export const VolBreakoutParamsObject = z
  .object({
    barMinutes: z.union([z.literal(5), z.literal(15), z.literal(30), z.literal(60)]),
    bbPeriod: z.number().int().min(5).max(100),
    squeezeLookback: z.number().int().min(20).max(500),
    squeezePercentile: z.number().min(1).max(80),
    breakoutBars: z.number().int().min(3).max(100),
    volLookback: z.number().int().min(5).max(100),
    volMult: z.number().min(0.5).max(10),
    atrPeriod: z.number().int().min(3).max(50),
    tpAtr: z.number().min(0.5).max(15),
    slAtr: z.number().min(0.3).max(8),
    minTakeProfitPct: z.number().min(0.2).max(8),
    maxStopLossPct: z.number().min(0.2).max(5),
    /** EMA period on the breakout timeframe that price must be above; 0 disables. */
    trendEmaBars: z.number().int().min(0).max(300),
    ...executionShape,
  })
  .strict();

export const VolBreakoutParamsSchema = VolBreakoutParamsObject;
export type VolBreakoutParams = z.infer<typeof VolBreakoutParamsSchema>;

export const STRATEGY_NAMES = ['momentum', 'vwapReversion', 'volBreakout'] as const;
export type StrategyName = (typeof STRATEGY_NAMES)[number];

export const STRATEGY_PARAM_SCHEMAS = {
  momentum: { object: MomentumParamsObject, schema: MomentumParamsSchema },
  vwapReversion: { object: VwapReversionParamsObject, schema: VwapReversionParamsSchema },
  volBreakout: { object: VolBreakoutParamsObject, schema: VolBreakoutParamsSchema },
} as const;

export interface StrategyParamsByName {
  momentum: MomentumParams;
  vwapReversion: VwapReversionParams;
  volBreakout: VolBreakoutParams;
}

export const StrategyConfigSchema = z
  .object({
    active: z.enum(STRATEGY_NAMES),
    momentum: MomentumParamsSchema,
    vwapReversion: VwapReversionParamsSchema,
    volBreakout: VolBreakoutParamsSchema,
  })
  .strict();
export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;

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
    marketContext: z.object({
      enabled: z.boolean(),
      binanceBaseUrl: z.string().url(),
      exchangePollMs: z.number().int().min(5_000),
      coinpaprikaPollMs: z.number().int().min(120_000),
      fearGreedPollMs: z.number().int().min(600_000),
      /** Block entries when the trading venue's mid differs from an independent reference by more than this. */
      maxDivergenceBps: z.number().min(5).max(200),
      maxReferenceAgeMs: z.number().int().min(5_000).max(600_000),
    }),
    paths: z.object({
      stateDir: z.string(),
      dataDir: z.string(),
      reportsDir: z.string(),
    }),
  })
  .strict();

export type AppConfig = z.infer<typeof AppConfigSchema>;
