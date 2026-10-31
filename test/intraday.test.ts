import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VwapReversionStrategy } from '../src/strategy/vwapReversion';
import { VolBreakoutStrategy } from '../src/strategy/volBreakout';
import { MomentumStrategy } from '../src/strategy/momentum';
import { createStrategy } from '../src/strategy/registry';
import { loadStrategyConfig } from '../src/config/load';
import type { Signal, Strategy } from '../src/strategy/types';
import type { VolBreakoutParams, VwapReversionParams } from '../src/config/schema';
import type { Candle } from '../src/core/types';
import { randomEntryTest } from '../src/backtest/nullTest';
import { gateBlockers, gateResultPath, GATE_CRITERIA } from '../src/backtest/gate';
import { divergenceVeto } from '../src/data/context/service';
import { coinpaprikaTicker, krakenTrades } from '../src/data/context/providers';
import { makeRng } from '../src/core/util';
import { ALL_HOURS, FEES, MARKET, PARAMS, T0 } from './helpers';

const VWAP: VwapReversionParams = {
  vwapBars: 120,
  minDevPct: 1.0,
  rsiPeriod: 7,
  rsiMax: 25,
  volLookback: 30,
  volMult: 2,
  crashLookbackBars: 120,
  maxCrashPct: 6,
  revertFraction: 0.7,
  minTakeProfitPct: 1.2,
  maxTakeProfitPct: 3,
  stopLossPct: 1.2,
  entryTimeoutSec: 120,
  maxHoldMinutes: 240,
  maxSpreadBps: 5,
  minNetTargetPct: 0.2,
  allowedHoursUtc: ALL_HOURS,
};

const BREAKOUT: VolBreakoutParams = {
  barMinutes: 15,
  bbPeriod: 20,
  squeezeLookback: 60,
  squeezePercentile: 25,
  breakoutBars: 16,
  volLookback: 20,
  volMult: 1.5,
  atrPeriod: 14,
  tpAtr: 4,
  slAtr: 1.5,
  minTakeProfitPct: 1.5,
  maxStopLossPct: 1.5,
  trendEmaBars: 0,
  entryTimeoutSec: 120,
  maxHoldMinutes: 360,
  maxSpreadBps: 5,
  minNetTargetPct: 0.3,
  allowedHoursUtc: ALL_HOURS,
};

function bar(ts: number, open: number, close: number, volume = 1, wick = 0.0002): Candle {
  return { ts, open, high: Math.max(open, close) * (1 + wick), low: Math.min(open, close) * (1 - wick), close, volume };
}

/** Flat market, then a sharp high-volume dump, then one green reversal bar. */
function dumpThenReversal(): Candle[] {
  const out: Candle[] = [];
  let px = 77000;
  for (let i = 0; i < 300; i++) {
    const next = 77000 * (1 + 0.0003 * Math.sin(i / 5));
    out.push(bar(T0 + i * 60_000, px, next));
    px = next;
  }
  for (let i = 0; i < 6; i++) {
    const next = px * 0.996;
    out.push(bar(T0 + out.length * 60_000, px, next, 6));
    px = next;
  }
  out.push(bar(T0 + out.length * 60_000, px, px * 1.001, 3));
  return out;
}

/** Long tight range on 15m bars, then a high-volume breakout bar. */
function squeezeThenBreakout(): Candle[] {
  const out: Candle[] = [];
  const rng = makeRng(3);
  let px = 77000;
  const n = 15 * 140;
  for (let i = 0; i < n; i++) {
    // volatility shrinks over time -> the latest bandwidth is the tightest
    const amp = 0.004 * (1 - i / n) + 0.0003;
    const next = 77000 * (1 + amp * Math.sin(i / 40) + (rng() - 0.5) * amp * 0.2);
    out.push(bar(T0 + i * 60_000, px, next, 1));
    px = next;
  }
  // last 15m bucket: strong breakout with volume
  for (let k = 0; k < 15; k++) {
    const next = px * 1.0012;
    out.push(bar(T0 + out.length * 60_000, px, next, 4));
    px = next;
  }
  return out;
}

describe('VWAP reversion strategy', () => {
  it('buys the first reversal bar after a stretched, high-volume sell-off', () => {
    const s = new VwapReversionStrategy(VWAP, FEES);
    const c = dumpThenReversal();
    const sig = s.signalAt(s.prepare(c), c.length - 1, 1);
    expect(sig.reasons).toEqual([]);
    expect(sig.enter).toBe(true);
    // target sized to the stretch, clamped to [min, max]
    expect(sig.exits.takeProfitPct).toBeGreaterThanOrEqual(VWAP.minTakeProfitPct);
    expect(sig.exits.takeProfitPct).toBeLessThanOrEqual(VWAP.maxTakeProfitPct);
  });

  it('does not buy the falling bar itself', () => {
    const s = new VwapReversionStrategy(VWAP, FEES);
    const c = dumpThenReversal().slice(0, -1);
    expect(s.signalAt(s.prepare(c), c.length - 1, 1).reasons).toContain('no reversal bar');
  });

  it('respects the crash guard', () => {
    const s = new VwapReversionStrategy({ ...VWAP, maxCrashPct: 1 }, FEES);
    const c = dumpThenReversal();
    expect(s.signalAt(s.prepare(c), c.length - 1, 1).reasons).toContain('crash guard');
  });
});

describe('volatility breakout strategy', () => {
  it('enters on a high-volume breakout after a squeeze, on the bar-completing minute only', () => {
    const s = new VolBreakoutStrategy(BREAKOUT, FEES);
    const c = squeezeThenBreakout();
    const p = s.prepare(c);
    const sig = s.signalAt(p, c.length - 1, 1);
    expect(sig.reasons).toEqual([]);
    expect(sig.enter).toBe(true);
    expect(sig.exits.takeProfitPct).toBeGreaterThanOrEqual(BREAKOUT.minTakeProfitPct);
    expect(sig.exits.stopLossPct).toBeLessThanOrEqual(BREAKOUT.maxStopLossPct);
    expect(s.signalAt(p, c.length - 2, 1).reasons).toEqual(['mid-bar']);
  });
});

describe('all strategies', () => {
  const cfg = loadStrategyConfig();
  const names = ['momentum', 'vwapReversion', 'volBreakout'] as const;

  it.each(names)('%s: signal at bar i is unaffected by later bars (no look-ahead)', (name) => {
    const s = createStrategy(name, cfg[name], FEES);
    const rng = makeRng(9);
    const c: Candle[] = [];
    let px = 77000;
    for (let i = 0; i < 3000; i++) {
      const next = px * (1 + (rng() - 0.5) * 0.003);
      c.push(bar(T0 + i * 60_000, px, next, 0.5 + rng()));
      px = next;
    }
    const cut = 2400;
    const a = s.prepare(c.slice(0, cut + 1));
    const b = s.prepare(c);
    for (let i = cut - 200; i <= cut; i++) {
      const x = s.signalAt(a, i, 1);
      const y = s.signalAt(b, i, 1);
      expect(y.enter).toBe(x.enter);
      expect(y.exits).toEqual(x.exits);
    }
  });

  it.each(names)('%s: blocks entries outside allowed UTC hours', (name) => {
    const c = squeezeThenBreakout(); // ~35h of data starting 00:00 UTC
    const closeHour = new Date(c.at(-1)!.ts + 60_000).getUTCHours();
    const params = { ...cfg[name], allowedHoursUtc: [(closeHour + 12) % 24] };
    const s = createStrategy(name, params as never, FEES);
    const p = s.prepare(c);
    // find a bar the strategy evaluates (volBreakout skips mid-bar minutes)
    let i = c.length - 1;
    while (s.signalAt(p, i, 1).reasons[0] === 'mid-bar') i--;
    expect(s.signalAt(p, i, 1).reasons).toContain('outside allowed hours');
  });

  it('intraday cap: no strategy can hold longer than 12 hours', () => {
    for (const n of names) expect(cfg[n].maxHoldMinutes).toBeLessThanOrEqual(720);
  });
});

describe('random-entry null test', () => {
  const rng = makeRng(21);
  const candles: Candle[] = [];
  let px = 77000;
  for (let i = 0; i < 12_000; i++) {
    const next = px * (1 + (rng() - 0.5) * 0.002);
    candles.push(bar(T0 + i * 60_000, px, next, 1, 0.0006));
    px = next;
  }
  const opts = { fees: { maker: 0, taker: 0 }, spreadBps: 0, takerSlippageBps: 0, startingUsd: 50, market: MARKET };

  /** Test-only cheat: enters right before the price rises 1% within the next hour. */
  class Oracle implements Strategy {
    readonly name = 'momentum' as const;
    readonly execution = { ...PARAMS, entryTimeoutSec: 600, maxHoldMinutes: 60, minNetTargetPct: 0 };
    readonly fees = { maker: 0, taker: 0 };
    warmupBars() {
      return 30;
    }
    prepare(c: Candle[]) {
      return { c };
    }
    signalAt(p: object, i: number): Signal {
      const c = (p as { c: Candle[] }).c;
      const entry = c[i]!.close;
      let hit = false;
      for (let k = i + 2; k < Math.min(c.length, i + 55); k++) {
        if (c[k]!.low <= entry * 0.993) break;
        if (c[k]!.high > entry * 1.01) {
          hit = true;
          break;
        }
      }
      return { enter: hit, reasons: [], metrics: {}, exits: { takeProfitPct: 1, stopLossPct: 0.8 } };
    }
  }

  it('detects a genuine (look-ahead) edge with a small p-value', () => {
    const r = randomEntryTest(candles, new Oracle(), opts, 40, 2);
    expect(r.strategyTrades).toBeGreaterThan(10);
    expect(r.pValue).toBeLessThan(0.05);
  });

  it('a signal-free strategy is indistinguishable from random entries', () => {
    const always = new MomentumStrategy({ ...PARAMS, minRocPct: 0.01, volMult: 0.5, maxExtensionPct: 5, minNetTargetPct: 0 }, { maker: 0, taker: 0 });
    const r = randomEntryTest(candles, always, opts, 40, 3);
    expect(r.pValue).toBeGreaterThan(0.05);
  });
});

describe('promotion gate result binding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jb-gate-'));
  const now = Date.UTC(2026, 9, 31);
  const write = (over: Record<string, unknown>) =>
    writeFileSync(
      gateResultPath(dir),
      JSON.stringify({ pass: true, strategy: 'volBreakout', strategyConfigSha256: 'abc', createdAt: new Date(now).toISOString(), checks: [], ...over }),
    );

  it('blocks when no gate has run', () => {
    expect(gateBlockers(mkdtempSync(join(tmpdir(), 'jb-gate-')), 'volBreakout', 'abc', now)[0]).toMatch(/no promotion gate/);
  });

  it('accepts a fresh passing result for the exact config', () => {
    write({});
    expect(gateBlockers(dir, 'volBreakout', 'abc', now)).toEqual([]);
  });

  it('blocks failed, stale, mismatched-strategy or changed-config results', () => {
    write({ pass: false, checks: [{ name: 'deflated Sharpe (grid)', pass: false }] });
    expect(gateBlockers(dir, 'volBreakout', 'abc', now).join()).toMatch(/FAILED: deflated Sharpe/);
    write({});
    expect(gateBlockers(dir, 'momentum', 'abc', now).join()).toMatch(/active strategy is momentum/);
    expect(gateBlockers(dir, 'volBreakout', 'changed', now).join()).toMatch(/changed since/);
    expect(gateBlockers(dir, 'volBreakout', 'abc', now + (GATE_CRITERIA.maxAgeDays + 1) * 86_400_000).join()).toMatch(/older than/);
  });
});

describe('market context', () => {
  it('vetoes entries only on FRESH references that diverge beyond the limit', () => {
    const now = 1_000_000;
    const ok = divergenceVeto(77000, [{ source: 'binance.us', price: 77030, ts: now - 1000 }], now, 50, 60_000);
    expect(ok.veto).toBeNull();
    const bad = divergenceVeto(77000, [{ source: 'binance.us', price: 77600, ts: now - 1000 }], now, 50, 60_000);
    expect(bad.veto).toMatch(/binance.us by 77bps/);
    const stale = divergenceVeto(77000, [{ source: 'binance.us', price: 77600, ts: now - 120_000 }], now, 50, 60_000);
    expect(stale.veto).toBeNull();
    expect(divergenceVeto(77000, [], now, 50, 60_000).veto).toBeNull();
  });

  const fakeFetch = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

  it('parses CoinPaprika tickers and rejects malformed responses', async () => {
    const body = {
      id: 'btc-bitcoin',
      last_updated: '2026-10-31T08:18:12Z',
      quotes: { USD: { price: 77315.5, volume_24h: 2.3e10, percent_change_15m: 0.1, percent_change_1h: 0.2, percent_change_24h: -0.3, market_cap: 1.5e12 } },
    };
    const t = await coinpaprikaTicker({ fetchImpl: fakeFetch(200, body), minIntervalMs: 0 });
    expect(t.price).toBe(77315.5);
    await expect(coinpaprikaTicker({ fetchImpl: fakeFetch(200, { id: 'eth-ethereum' }), minIntervalMs: 0, retries: 0 })).rejects.toThrow(/validation/);
  });

  it('does not retry geo-blocked (451) endpoints', async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response('{}', { status: 451 });
    }) as unknown as typeof fetch;
    await expect(coinpaprikaTicker({ fetchImpl: f, minIntervalMs: 0, retries: 3 })).rejects.toThrow(/451/);
    expect(calls).toBe(1);
  });

  it('parses Kraken public trades', async () => {
    const body = { error: [], result: { XXBTZUSD: [['77299.0', '0.0099', 1793434951.8, 's', 'l', '', 1]], last: '1' } };
    const t = await krakenTrades(1, { fetchImpl: fakeFetch(200, body), minIntervalMs: 0 });
    expect(t[0]).toEqual({ price: 77299, qty: 0.0099, ts: 1793434951800, side: 'sell' });
  });
});
