import { describe, expect, it } from 'vitest';
import { strategyVersionHash } from '../../../src/paper/config';
import { evaluateReadiness } from '../../../src/paper/evaluation/readiness';
import { controls, sessionMetrics } from '../../../src/paper/evaluation/metrics';
import { simulate } from '../../../src/paper/research/historical';
import type { Candle } from '../../../src/paper/domain';
import { ScriptedStrategy, started, testConfig } from '../harness';

const PASS = { acceptance: { passed: true, detail: 'fixture' }, replay: { matched: true, detail: 'fixture' } };

/** Synthetic candles: a straight line from p0 to p1 (synthetic fixture; never presented as market data). */
function line(n: number, p0: number, p1: number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const p = p0 + ((p1 - p0) * i) / (n - 1);
    return {
      start: Date.UTC(2026, 0, 1) + i * 300_000,
      open: String(p),
      high: String(p * 1.0005),
      low: String(p * 0.9995),
      close: String(p),
      volume: '1',
    };
  });
}

describe('3. losing candidates are identified against controls', () => {
  it('a churning candidate loses while buy-and-hold wins in a rising market', () => {
    const cfg = testConfig();
    const bars = line(3000, 70000, 77000); // +10%
    const churn = simulate(bars, 0, bars.length, 'smokeProbe', { weight: 0.2 }, cfg, {
      takerRate: 0.009,
      halfSpreadBps: 0.5,
      slippageBps: 2,
    });
    const hold = simulate(bars, 0, bars.length, 'buyHold', {}, cfg, { takerRate: 0.009, halfSpreadBps: 0.5, slippageBps: 2 });
    expect(churn.netReturn).toBeLessThan(0);
    expect(hold.netReturn).toBeGreaterThan(0); // 20% exposure x ~10% rise minus entry/exit costs
  });
  it('vice versa: in a falling market cash beats buy-and-hold', () => {
    const cfg = testConfig();
    const bars = line(3000, 77000, 70000);
    const cash = simulate(bars, 0, bars.length, 'cash', {}, cfg, { takerRate: 0.009, halfSpreadBps: 0.5, slippageBps: 2 });
    const hold = simulate(bars, 0, bars.length, 'buyHold', {}, cfg, { takerRate: 0.009, halfSpreadBps: 0.5, slippageBps: 2 });
    expect(cash.netReturn).toBe(0);
    expect(hold.netReturn).toBeLessThan(cash.netReturn);
  });
  it('session controls use the same entry-at-ask / exit-at-bid and fee convention', () => {
    const strat = new ScriptedStrategy();
    const h = started({ strategy: strat });
    h.snapshot([['79999', '5']], [['80000', '5']]);
    h.freshTick(0); // first fresh valuation
    h.snapshot([['87999', '5']], [['88000', '5']], 2);
    h.freshTick(60_000);
    const c = controls(h.store, h.sessionId, h.cfg);
    // entry ask 80000*1.009, exit bid 87999*0.991 -> 8.02%...
    expect(c.buyHold.ret!).toBeCloseTo((87999 * 0.991) / (80000 * 1.009) - 1, 9);
    expect(c.matchedExposure.ret!).toBeCloseTo(0.2 * c.buyHold.ret!, 9);
  });
});

describe('13. changing strategy, model, fees or risk policy creates a new experiment version', () => {
  it('versions differ and stored sessions keep their original identity', () => {
    const a = testConfig();
    const variants = [
      testConfig({ fees: { takerRate: '0.012' } }),
      testConfig({ risk: { maxExposure: '0.25' } }),
      testConfig({ strategy: { id: 'emaTrend', params: {} } }),
      testConfig({ strategy: { id: 'llm', params: { model: 'claude-opus-5-5' } } }),
    ];
    const hashes = new Set([strategyVersionHash(a), ...variants.map(strategyVersionHash)]);
    expect(hashes.size).toBe(5);
    const h = started();
    const stored = h.store.get('SELECT strategy_version FROM sessions')!.strategy_version;
    expect(stored).toBe(strategyVersionHash(h.cfg));
  });
});

describe('14. unknown costs are never reported as zero', () => {
  it('a model call with unknown cost blocks all-in PnL and the all-in gate', () => {
    const h = started();
    h.store.run(
      "INSERT INTO model_calls (session_id, decision_id, provider, model, request_hash, response_hash, latency_ms, input_tokens, output_tokens, cost_usd) VALUES (?, 'd', 'x', 'm', 'a', 'b', 1, NULL, NULL, NULL)",
      h.sessionId,
    );
    const m = sessionMetrics(h.store, h.sessionId, h.cfg);
    expect(m.operatingCosts.complete).toBe(false);
    expect(m.allInOperatingPnl).toBeNull();
    const r = evaluateReadiness(h.store, h.sessionId, h.cfg, PASS);
    expect(r.gates.find((g) => g.gate.startsWith('all-in'))).toMatchObject({ passed: false });
  });
});

describe('17. a short profitable run stays insufficient evidence; nothing can override failed gates', () => {
  it('profit over a few minutes is classified insufficient_evidence', () => {
    const strat = new ScriptedStrategy();
    const h = started({ strategy: strat });
    h.snapshot([['79999', '50']], [['80000', '50']]);
    h.freshTick(0);
    strat.target = 0.2;
    h.completeBar();
    h.t += 1000;
    h.update('ask', '80000', '50');
    h.snapshot([['99999', '50']], [['100000', '50']], 2); // +25% jump: very profitable
    h.freshTick(60_000);
    const r = evaluateReadiness(h.store, h.sessionId, h.cfg, PASS);
    expect(r.metrics.netTradingPnl!).toBeGreaterThan(0);
    expect(r.operationalCorrectness).toBe('pass');
    expect(r.strategyEvidence).toBe('insufficient_evidence');
    expect(r.gates.find((g) => g.gate === 'observation floor: days')!.passed).toBe(false);
  });
  it('without acceptance and replay evidence the verdict is not_ready', () => {
    const h = started();
    expect(evaluateReadiness(h.store, h.sessionId, h.cfg).strategyEvidence).toBe('not_ready');
  });
});
