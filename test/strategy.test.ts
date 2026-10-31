import { describe, expect, it } from 'vitest';
import { aggregate, ema, rocPct, sma } from '../src/strategy/indicators';
import { MomentumStrategy } from '../src/strategy/momentum';
import { candlesFromCloses, FEES, PARAMS, T0 } from './helpers';

describe('indicators', () => {
  it('sma and ema', () => {
    expect(sma([1, 2, 3, 4], 2).slice(1)).toEqual([1.5, 2.5, 3.5]);
    const e = ema([1, 1, 1, 1, 1], 3);
    expect(Number.isNaN(e[1]!)).toBe(true);
    expect(e[4]).toBe(1);
    expect(rocPct([100, 101, 102], 2)[2]).toBeCloseTo(2, 9);
  });

  it('aggregate emits only completed 5m buckets (no look-ahead)', () => {
    const c = candlesFromCloses([1, 2, 3, 4, 5, 6, 7], T0);
    const a = aggregate(c, 5);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ ts: T0, open: 1, close: 5, volume: 5 });
  });

  it('maps each 1m bar to the last COMPLETED 5m bar', () => {
    const s = new MomentumStrategy(PARAMS, FEES);
    const p = s.prepare(candlesFromCloses(Array.from({ length: 12 }, (_, i) => 100 + i), T0));
    // bars 0..3 -> no complete 5m bar; bar 4 closes the first bucket
    expect(Array.from(p.map5.slice(0, 6))).toEqual([-1, -1, -1, -1, 0, 0]);
    expect(p.map5[9]).toBe(1);
  });
});

function trendWithBreakout(): ReturnType<typeof candlesFromCloses> {
  const closes: number[] = [];
  let px = 77000;
  for (let i = 0; i < 200; i++) {
    px *= 1.0002; // steady uptrend
    closes.push(px);
  }
  // momentum burst on the last 3 bars
  for (let i = 0; i < 3; i++) {
    px *= 1.0007;
    closes.push(px);
  }
  const volumes = closes.map((_, i) => (i === closes.length - 1 ? 5 : 1));
  return candlesFromCloses(closes, T0, 1, volumes);
}

describe('MomentumStrategy', () => {
  it('enters on trend + momentum + volume + tight spread', () => {
    const s = new MomentumStrategy(PARAMS, FEES);
    const c = trendWithBreakout();
    const sig = s.signalAt(s.prepare(c), c.length - 1, 1);
    expect(sig.reasons).toEqual([]);
    expect(sig.enter).toBe(true);
  });

  it('rejects wide spreads', () => {
    const s = new MomentumStrategy(PARAMS, FEES);
    const c = trendWithBreakout();
    const sig = s.signalAt(s.prepare(c), c.length - 1, 20);
    expect(sig.enter).toBe(false);
    expect(sig.reasons).toContain('spread too wide');
  });

  it('rejects without a volume spike', () => {
    const s = new MomentumStrategy(PARAMS, FEES);
    const c = trendWithBreakout().map((x) => ({ ...x, volume: 1 }));
    expect(s.signalAt(s.prepare(c), c.length - 1, 1).reasons).toContain('volume filter');
  });

  it('rejects in a downtrend', () => {
    const s = new MomentumStrategy(PARAMS, FEES);
    const closes = Array.from({ length: 200 }, (_, i) => 80000 * (1 - 0.0003 * i));
    closes.push(closes.at(-1)! * 1.003);
    const c = candlesFromCloses(closes, T0, 1, closes.map((_, i) => (i === closes.length - 1 ? 5 : 1)));
    expect(s.signalAt(s.prepare(c), c.length - 1, 1).reasons).toContain('5m trend not up');
  });

  it('refuses entries when the net target after fees is too small', () => {
    const s = new MomentumStrategy({ ...PARAMS, takeProfitPct: 0.8, minNetTargetPct: 0.05 }, FEES);
    const c = trendWithBreakout();
    expect(s.signalAt(s.prepare(c), c.length - 1, 1).reasons).toContain('net target after fees too small');
  });

  it('signal at bar i does not change when future bars are appended', () => {
    const s = new MomentumStrategy(PARAMS, FEES);
    const c = trendWithBreakout();
    const i = c.length - 1;
    const before = s.signalAt(s.prepare(c), i, 1);
    const more = [...c, ...candlesFromCloses([60000, 59000, 58000], c.at(-1)!.ts + 60_000)];
    const after = s.signalAt(s.prepare(more), i, 1);
    expect(after.enter).toBe(before.enter);
    expect(after.metrics.roc).toBeCloseTo(before.metrics.roc!, 12);
  });
});
