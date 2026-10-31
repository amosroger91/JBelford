import { describe, expect, it } from 'vitest';
import { expectedValuePct, netTargetPct, roundTripEconomics, worstCaseLossUsd } from '../src/economics/costs';
import { FEES } from './helpers';

describe('round-trip economics', () => {
  const costs = { fees: FEES, spreadBps: 1, takerSlippageBps: 5 };

  it('nets the 1% target down to ~0.196% at Kraken tier-1 maker fees', () => {
    const e = roundTripEconomics(1.0, 0.5, costs);
    // 1% - 0.4% entry - 0.4% * 1.01 exit
    expect(e.winNetPct).toBeCloseTo(0.196, 3);
    expect(netTargetPct(1.0, FEES)).toBeCloseTo(0.196, 3);
  });

  it('makes a 0.5% stop cost far more than 0.5%', () => {
    const e = roundTripEconomics(1.0, 0.5, costs);
    expect(e.lossNetPct).toBeLessThan(-1.7);
    expect(e.lossNetPct).toBeGreaterThan(-1.8);
  });

  it('requires a very high win rate to break even', () => {
    const e = roundTripEconomics(1.0, 0.5, costs);
    expect(e.breakevenWinRate).toBeGreaterThan(0.89);
    expect(expectedValuePct(e.breakevenWinRate, e)).toBeCloseTo(0, 9);
  });

  it('reports breakeven 100% when fees exceed the target', () => {
    expect(roundTripEconomics(0.5, 0.5, costs).breakevenWinRate).toBe(1);
  });

  it('computes worst-case dollar loss on a $9.80 position', () => {
    const w = worstCaseLossUsd(9.8, 0.5, costs);
    expect(w).toBeGreaterThan(0.16);
    expect(w).toBeLessThan(0.18);
  });

  it('zero fees leaves only spread/slippage drag', () => {
    const e = roundTripEconomics(1, 0.5, { fees: { maker: 0, taker: 0 }, spreadBps: 0, takerSlippageBps: 0 });
    expect(e.winNetPct).toBeCloseTo(1, 9);
    expect(e.lossNetPct).toBeCloseTo(-0.5, 9);
    expect(e.breakevenWinRate).toBeCloseTo(1 / 3, 9);
  });
});
