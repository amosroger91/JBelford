import { describe, expect, it } from 'vitest';
import { BATCHES, simulateBracket, type BracketParams, type Series, type Venue } from '../../src/paper/research/bracket';

/** Synthetic bars (fixture, not market data). Each tuple: [open, high, low, close]. */
function series(bars: [number, number, number, number][]): Series {
  const n = bars.length;
  const s: Series = {
    t: new Float64Array(n),
    o: new Float64Array(n),
    h: new Float64Array(n),
    l: new Float64Array(n),
    c: new Float64Array(n),
    v: new Float64Array(n).fill(1),
  };
  bars.forEach(([o, h, l, c], i) => {
    s.t[i] = Date.UTC(2026, 0, 1) + i * 300_000;
    s.o[i] = o;
    s.h[i] = h;
    s.l[i] = l;
    s.c[i] = c;
  });
  return s;
}

const venue: Venue = { name: 't', maker: 0.001, taker: 0.002, halfSpreadBps: 0, slippageBps: 0 };
const params = (o: Partial<BracketParams> = {}): BracketParams => ({
  family: 't',
  signal: {},
  tpPct: 2,
  slPct: 1,
  maxHoldBars: 10,
  entry: 'maker',
  offsetBps: 0,
  entryValidBars: 3,
  ...o,
});

describe('bracket simulator (hand-calculated)', () => {
  it('maker entry fills only on trade-through; take-profit pays maker on both legs', () => {
    // signal at bar 0 (close 100). Bar 1 touches 100 but does not trade below: no fill. Bar 2 trades 99.9 < 100: fill at 100.
    const s = series([
      [100, 100, 100, 100],
      [100, 100.5, 100, 100.2],
      [100.2, 100.3, 99.9, 100],
      [100, 102.5, 100, 102],
      [102, 102, 102, 102],
    ]);
    const sig = new Uint8Array(5);
    sig[0] = 1;
    const r = simulateBracket(s, sig, 0, 5, params(), venue, 1);
    expect(r.trades).toBe(1);
    expect(r.exits).toEqual({ take_profit: 1 });
    // entry 100 * 1.001 = 100.1 ; exit 102 * 0.999 = 101.898 ; r = 101.898/100.1 - 1
    expect(r.netReturn).toBeCloseTo(101.898 / 100.1 - 1, 12);
  });

  it('stop beats target in the same bar, and pays taker', () => {
    const s = series([
      [100, 100, 100, 100],
      [100, 100, 99.5, 99.8], // fills at 100
      [99.8, 103, 98, 100], // both 102 target and 99 stop touched -> stop
      [100, 100, 100, 100],
    ]);
    const sig = new Uint8Array(4);
    sig[0] = 1;
    const r = simulateBracket(s, sig, 0, 4, params(), venue, 1);
    expect(r.exits).toEqual({ stop: 1 });
    expect(r.netReturn).toBeCloseTo((99 * 0.998) / (100 * 1.001) - 1, 12);
  });

  it('a gap through the stop exits at the open, not the stop price', () => {
    const s = series([
      [100, 100, 100, 100],
      [100, 100, 99.5, 99.8],
      [97, 97.5, 96, 97],
      [97, 97, 97, 97],
    ]);
    const sig = new Uint8Array(4);
    sig[0] = 1;
    const r = simulateBracket(s, sig, 0, 4, params(), venue, 1);
    expect(r.exits).toEqual({ stop_gap: 1 });
    expect(r.netReturn).toBeCloseTo((97 * 0.998) / (100 * 1.001) - 1, 12);
  });

  it('unfilled maker entries are counted as non-fills, and exposure scales the return', () => {
    const s = series([
      [100, 100, 100, 100],
      [100, 101, 100, 101],
      [101, 102, 101, 102],
      [102, 103, 102, 103],
      [103, 103, 103, 103],
    ]);
    const sig = new Uint8Array(5);
    sig[0] = 1;
    const r = simulateBracket(s, sig, 0, 5, params(), venue, 0.2);
    expect(r).toMatchObject({ trades: 0, entriesSignalled: 1, entriesFilled: 0, netReturn: 0 });
  });

  it('batch definitions are predeclared and batch-01 keeps its original five families', () => {
    expect(Object.keys(BATCHES)).toEqual(['batch-01', 'batch-02', 'batch-03', 'batch-04']);
    expect(BATCHES['batch-01']!.families.map((f) => f.family)).toEqual([
      'dipInUptrend',
      'capitulation',
      'zScoreReversion',
      'breakout',
      'hourOfDay',
    ]);
  });
});
