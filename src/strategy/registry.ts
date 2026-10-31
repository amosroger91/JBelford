import type { Fees } from '../core/types';
import {
  STRATEGY_PARAM_SCHEMAS,
  type StrategyConfig,
  type StrategyName,
  type StrategyParamsByName,
} from '../config/schema';
import { MomentumStrategy } from './momentum';
import { VwapReversionStrategy } from './vwapReversion';
import { VolBreakoutStrategy } from './volBreakout';
import type { Strategy } from './types';

export function createStrategy<N extends StrategyName>(name: N, params: StrategyParamsByName[N], fees: Fees): Strategy {
  switch (name) {
    case 'momentum':
      return new MomentumStrategy(params as StrategyParamsByName['momentum'], fees);
    case 'vwapReversion':
      return new VwapReversionStrategy(params as StrategyParamsByName['vwapReversion'], fees);
    case 'volBreakout':
      return new VolBreakoutStrategy(params as StrategyParamsByName['volBreakout'], fees);
    default:
      throw new Error(`unknown strategy ${String(name)}`);
  }
}

export function activeStrategy(cfg: StrategyConfig, fees: Fees, override?: StrategyName): Strategy {
  const name = override ?? cfg.active;
  return createStrategy(name, cfg[name], fees);
}

export function validateParams<N extends StrategyName>(name: N, params: unknown): params is StrategyParamsByName[N] {
  return STRATEGY_PARAM_SCHEMAS[name].schema.safeParse(params).success;
}

/**
 * Default optimizer grids. Kept small on purpose: every extra combination
 * raises the bar the Deflated Sharpe Ratio sets for "not luck".
 */
export const DEFAULT_GRIDS: { [N in StrategyName]: Partial<Record<keyof StrategyParamsByName[N], number[]>> } = {
  momentum: {
    minRocPct: [0.1, 0.15, 0.25],
    volMult: [1.2, 1.5, 2.5],
    takeProfitPct: [1.0, 1.5, 2.5],
    stopLossPct: [0.5, 0.8, 1.2],
    maxHoldMinutes: [60, 180],
  },
  vwapReversion: {
    minDevPct: [0.8, 1.2, 2.0],
    rsiMax: [20, 30],
    volMult: [1.5, 2.5],
    revertFraction: [0.5, 0.8],
    stopLossPct: [0.8, 1.2, 2.0],
    maxHoldMinutes: [120, 360],
  },
  volBreakout: {
    barMinutes: [15, 30],
    squeezePercentile: [15, 30],
    breakoutBars: [12, 24],
    tpAtr: [3, 5],
    slAtr: [1, 2],
    trendEmaBars: [0, 50],
  },
};
