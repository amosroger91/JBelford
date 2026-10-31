import { describe, expect, it } from 'vitest';
import {
  deflatedSharpe,
  expectedMaxSharpe,
  moments,
  normCdf,
  normInv,
  periodReturns,
  probabilisticSharpe,
  probabilityOfBacktestOverfitting,
} from '../src/backtest/overfitting';
import { makeRng } from '../src/core/util';
import { T0, trade } from './helpers';

/** Box-Muller normal samples from the deterministic PRNG. */
function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

function noiseMatrix(T: number, N: number, seed: number, drift: (n: number) => number = () => 0): number[][] {
  const rng = makeRng(seed);
  return Array.from({ length: T }, () => Array.from({ length: N }, (_, n) => drift(n) + gaussian(rng)));
}

describe('normal distribution helpers', () => {
  it('normCdf matches known values', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1.645)).toBeCloseTo(0.05, 3);
  });

  it('normInv inverts normCdf', () => {
    for (const p of [0.001, 0.025, 0.3, 0.5, 0.8, 0.975, 0.999]) expect(normCdf(normInv(p))).toBeCloseTo(p, 6);
    expect(normInv(0.975)).toBeCloseTo(1.959964, 5);
  });

  it('moments of a known series', () => {
    const m = moments([1, 2, 3, 4, 5]);
    expect(m.mean).toBe(3);
    expect(m.skew).toBeCloseTo(0, 12);
    expect(m.kurt).toBeCloseTo(1.7, 9);
    expect(moments([2, 2, 2])).toMatchObject({ std: 0, skew: 0, kurt: 3 });
  });
});

describe('periodReturns', () => {
  it('buckets trade P&L by close time and fills empty periods with 0', () => {
    const day = 86_400_000;
    const r = periodReturns(
      [
        trade({ netPnl: 0.1, closedAt: T0 + 1000 }),
        trade({ netPnl: -0.3, closedAt: T0 + 2000 }),
        trade({ netPnl: 0.2, closedAt: T0 + 2 * day + 5 }),
      ],
      T0,
      T0 + 3 * day,
      day,
    );
    expect(r.map((v) => Number(v.toFixed(6)))).toEqual([-0.2, 0, 0.2]);
  });
});

describe('probability of backtest overfitting (CSCV)', () => {
  it('is near 50% when every trial is pure noise', () => {
    const r = probabilityOfBacktestOverfitting(noiseMatrix(200, 50, 11), 8);
    expect(r.splits).toBe(70); // C(8,4)
    expect(r.pbo).toBeGreaterThan(0.25);
    expect(r.pbo).toBeLessThan(0.75);
  });

  it('is near 0 when one trial has a genuine, persistent edge', () => {
    const r = probabilityOfBacktestOverfitting(
      noiseMatrix(200, 50, 12, (n) => (n === 7 ? 0.5 : 0)),
      8,
    );
    expect(r.pbo).toBeLessThan(0.05);
    expect(r.probOosLoss).toBeLessThan(0.05);
  });

  it('validates its inputs', () => {
    expect(() => probabilityOfBacktestOverfitting([[1], [2]], 2)).toThrow(/2 trials/);
    expect(() => probabilityOfBacktestOverfitting(noiseMatrix(20, 3, 1), 3)).toThrow(/even/);
    expect(() => probabilityOfBacktestOverfitting(noiseMatrix(5, 3, 1), 8)).toThrow(/periods/);
  });
});

describe('probabilistic & deflated Sharpe', () => {
  it('PSR is 50% at the benchmark and rises with sample length', () => {
    expect(probabilisticSharpe(0.1, 0.1, 100, 0, 3)).toBeCloseTo(0.5, 6);
    expect(probabilisticSharpe(0.1, 0, 400, 0, 3)).toBeGreaterThan(probabilisticSharpe(0.1, 0, 50, 0, 3));
  });

  it('negative skew and fat tails reduce confidence', () => {
    expect(probabilisticSharpe(0.2, 0, 100, -2, 10)).toBeLessThan(probabilisticSharpe(0.2, 0, 100, 0, 3));
  });

  it('the luck benchmark grows with the number of trials', () => {
    expect(expectedMaxSharpe(1000, 0.01)).toBeGreaterThan(expectedMaxSharpe(10, 0.01));
    expect(expectedMaxSharpe(1, 0.01)).toBe(0);
  });

  it('shows the best of many noise trials is not significant once deflated', () => {
    const d = deflatedSharpe(noiseMatrix(60, 200, 5));
    // Undeflated, the luckiest trial looks highly significant...
    expect(d.psr).toBeGreaterThan(0.99);
    // ...deflated for 200 trials it is roughly a coin flip, far from the 95% bar.
    expect(d.dsr).toBeLessThan(0.9);
    expect(d.sharpe).toBeCloseTo(d.benchmarkSharpe, 0);
  });

  it('keeps a strong genuine edge significant', () => {
    const d = deflatedSharpe(noiseMatrix(250, 30, 6, (n) => (n === 3 ? 0.6 : 0)));
    expect(d.bestTrial).toBe(3);
    expect(d.dsr).toBeGreaterThan(0.95);
  });
});
