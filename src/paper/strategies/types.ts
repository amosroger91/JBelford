import type { DecisionSnapshot, RecordedDecision, TradeIntent } from '../domain';
import { ruleFor, type Params } from './rules';

/** What a strategy sees: the immutable snapshot plus its own position context. */
export interface StrategyInput extends DecisionSnapshot {
  positionSince: number | null;
  weight: number;
}

export interface StrategyResult {
  intent: TradeIntent | null;
  outcome: RecordedDecision['outcome'];
  detail?: string;
  model?: RecordedDecision['model'];
}

/**
 * Bounded strategy port (plan section 4). A strategy proposes `hold` or a
 * target BTC weight. It has no execution privileges: it cannot approve orders,
 * see credentials, set prices, change risk policy or choose endpoints.
 */
export interface StrategyPort {
  readonly id: string;
  readonly kind: 'deterministic' | 'llm';
  /** True if decisions incur model/data charges (cost must be tracked; unknown != 0). */
  readonly paid: boolean;
  readonly warmupBars: number;
  decide(input: StrategyInput, signal: AbortSignal): Promise<StrategyResult>;
}

export class DeterministicStrategy implements StrategyPort {
  readonly kind = 'deterministic' as const;
  readonly paid = false;
  readonly warmupBars: number;
  private readonly params: Params;

  constructor(
    readonly id: string,
    params: Params,
    private readonly intentTtlMs: number,
  ) {
    const r = ruleFor(id);
    this.params = { ...r.defaults, ...params };
    this.warmupBars = r.warmup(this.params);
  }

  /** Synchronous core, also used by historical screening. */
  decideSync(input: StrategyInput): StrategyResult {
    const out = ruleFor(this.id).rule(input.bars, { positionSince: input.positionSince, weight: input.weight }, this.params);
    const w = Math.max(0, Math.min(1, out.target));
    return {
      outcome: 'ok',
      intent: out.hold
        ? {
            decisionId: `d-${input.asOf}`,
            snapshotId: input.snapshotId,
            action: 'hold',
            validUntil: input.asOf + this.intentTtlMs,
            rationale: out.reason,
          }
        : {
            decisionId: `d-${input.asOf}`,
            snapshotId: input.snapshotId,
            action: 'target',
            targetWeight: w.toFixed(6),
            validUntil: input.asOf + this.intentTtlMs,
            rationale: out.reason,
            bracket: out.bracket,
          },
    };
  }

  async decide(input: StrategyInput): Promise<StrategyResult> {
    return this.decideSync(input);
  }
}
