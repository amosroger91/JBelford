import { describe, expect, it } from 'vitest';
import type { MarketEvent } from '../../../src/paper/domain';
import { LlmStrategy, type LlmClient, type LlmReply } from '../../../src/paper/strategies/llm';
import type { StrategyInput } from '../../../src/paper/strategies/types';
import { DeterministicStrategy } from '../../../src/paper/strategies/types';
import { ScriptedStrategy, T0, started } from '../harness';

function input(over: Partial<StrategyInput> = {}): StrategyInput {
  return {
    snapshotId: 'snap-1',
    sessionId: 's',
    generation: 1,
    asOf: T0,
    bars: [],
    bestBid: '79999',
    bestAsk: '80000',
    feedHealth: 'healthy',
    balances: { usdAvailable: '10000', usdReserved: '0', btcAvailable: '0', btcReserved: '0' },
    exposureWeight: '0',
    openOrders: 0,
    limits: { maxExposure: '0.2', maxOrderPctEquity: '0.05' },
    fees: { takerRate: '0.009' },
    positionSince: null,
    weight: 0,
    ...over,
  };
}

class FakeClient implements LlmClient {
  readonly provider = 'fake';
  release: (() => void) | null = null;
  constructor(private readonly reply: (signal: AbortSignal) => Promise<LlmReply>) {}
  complete(_req: { model: string; system: string; user: string }, signal: AbortSignal): Promise<LlmReply> {
    return this.reply(signal);
  }
}

const ok = (p: Partial<LlmReply> = {}): LlmReply => ({
  parsed: { snapshotId: 'snap-1', action: 'target', targetWeight: 1, rationale: 'go all in' },
  model: 'claude-opus-5-5',
  stopReason: 'end_turn',
  inputTokens: 100,
  outputTokens: 20,
  responseText: '{}',
  ...p,
});

describe('11. model outputs cannot bypass risk', () => {
  it('a slow model times out into a recorded no-intent outcome', async () => {
    const s = new LlmStrategy(
      new FakeClient((signal) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))))),
      'claude-opus-5-5',
      50,
      60_000,
    );
    const r = await s.decide(input(), new AbortController().signal);
    expect(r).toMatchObject({ intent: null, outcome: 'timeout' });
  });
  it('malformed JSON, invented snapshot ids, refusals and silent model failover produce no intent', async () => {
    const cases: [Partial<LlmReply>, RegExp][] = [
      [{ parsed: null }, /malformed/],
      [{ parsed: { snapshotId: 'snap-INVENTED', action: 'target', targetWeight: 0.1, rationale: 'x' } }, /mismatched snapshot/],
      [{ stopReason: 'refusal', parsed: null }, /refused/],
      [{ model: 'some-other-model' }, /unexpected model/],
      [{ parsed: { snapshotId: 'snap-1', action: 'target', targetWeight: 7 as unknown as number, rationale: 'x' } }, /malformed/],
    ];
    for (const [reply, re] of cases) {
      const s = new LlmStrategy(new FakeClient(async () => ok(reply)), 'claude-opus-5-5', 1000, 60_000);
      const r = await s.decide(input(), new AbortController().signal);
      expect(r.intent).toBeNull();
      expect(r.detail).toMatch(re);
    }
  });
  it('an extreme target weight is clamped by deterministic risk code', () => {
    const strat = new DeterministicStrategy('buyHold', {}, 60_000); // target 1.0
    const h = started({ strategy: strat });
    h.snapshot([['79999', '5']], [['80000', '5']]);
    h.completeBar();
    expect(h.store.get("SELECT detail FROM risk_events WHERE check_name = 'exposure_clamp'")!.detail).toMatch(
      /clamped to max exposure 0.20/,
    );
    const o = h.store.get('SELECT qty FROM orders')!;
    expect(Number(o.qty) * 80000).toBeLessThanOrEqual(500.01); // 5% order cap, not 100%
  });
  it('a stale (expired) intent is rejected', () => {
    const strat = new ScriptedStrategy();
    strat.target = 0.2;
    strat.ttlMs = -1; // intent already expired when it reaches risk
    const h = started({ strategy: strat });
    h.snapshot([['79999', '5']], [['80000', '5']]);
    h.completeBar(); // decision completes at end+grace, after validUntil
    expect(h.store.get("SELECT detail FROM risk_events WHERE check_name = 'no_order'")!.detail).toMatch(/expired/);
    expect(h.store.all('SELECT * FROM orders')).toHaveLength(0);
  });
});

describe('19. a blocked model call never stalls ingestion or controls; late responses cannot trade', () => {
  it('book updates and pause are processed while the model is pending; the late answer is ignored', async () => {
    let release!: (r: LlmReply) => void;
    const client = new FakeClient(() => new Promise<LlmReply>((res) => (release = res)));
    const strat = new LlmStrategy(client, 'claude-opus-5-5', 60_000, 600_000);
    Object.defineProperty(strat, 'warmupBars', { value: 0 });
    const h = started({ strategy: strat });
    h.snapshot([['79999', '5']], [['80000', '5']]);
    h.completeBar();
    expect(h.rt.snapshotStatus().inFlightDecision).not.toBeNull();
    // Ingestion continues while the model is "thinking".
    h.update('ask', '80000', '2'); // absolute size at the best ask
    expect(h.rt.book.bestAsk()!.qty).toBe(2_000_000_000_000n);
    h.ev({ kind: 'control', action: 'pause', requestId: 'p' } as MarketEvent);
    expect(h.rt.snapshotStatus().status).toBe('paused');
    const snapId = (h.store.get('SELECT 1 AS x') && h.rt.snapshotStatus().inFlightDecision) || null;
    expect(snapId).toBeNull(); // pause cleared the in-flight slot (generation bumped)
    // The model finally answers; its decision re-enters as an event with the OLD generation.
    const pendingSnapshot = (strat as unknown as { lastSnapshot?: string }).lastSnapshot;
    void pendingSnapshot;
    release(ok({ parsed: { snapshotId: 'will-be-replaced', action: 'target', targetWeight: 0.2, rationale: 'late' } }));
    await new Promise((r) => setTimeout(r, 10));
    h.tick(0); // drains the queued decision_ready event
    expect(h.store.all('SELECT * FROM orders')).toHaveLength(0);
    const d = h.store.get('SELECT outcome FROM decisions')!;
    expect(['invalid', 'ok']).toContain(d.outcome);
    expect(
      h.store.get("SELECT detail FROM risk_events WHERE check_name IN ('lifecycle','generation','no_order') ORDER BY id DESC")!.detail,
    ).toMatch(/paused|older session generation|no valid intent/);
  });

  it('a second bar arriving during an in-flight decision is skipped and audited (no backlog)', async () => {
    const client = new FakeClient(() => new Promise<LlmReply>(() => {}));
    const strat = new LlmStrategy(client, 'claude-opus-5-5', 600_000, 600_000);
    Object.defineProperty(strat, 'warmupBars', { value: 0 });
    const h = started({ strategy: strat });
    h.snapshot([['79999', '5']], [['80000', '5']]);
    h.completeBar();
    h.completeBar();
    h.completeBar();
    expect(h.store.all("SELECT * FROM audit WHERE kind = 'decision_skipped'")).toHaveLength(2);
  });
});
