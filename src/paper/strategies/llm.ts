import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { canonicalJson, sha256 } from '../config';
import type { StrategyInput, StrategyPort, StrategyResult } from './types';

/**
 * Optional LLM strategy candidate (plan section 7).
 *
 * The model gets API access only: no tools, shell, files, URLs, credentials or
 * exchange access. It receives a bounded snapshot and returns a strictly
 * validated proposal. Timeouts, malformed output, refusals, a mismatched
 * snapshot reference, an unexpected responding model or any error produce
 * `hold` with a recorded reason. Deterministic risk code still decides
 * whether any order exists.
 *
 * Server-side model fallback is deliberately NOT enabled: the plan requires the
 * model route to stay frozen for an experiment, and a silent fallback would mix
 * results from different models.
 */
export const LlmProposalSchema = z.object({
  snapshotId: z.string(),
  action: z.enum(['hold', 'target']),
  targetWeight: z.number().min(0).max(1),
  rationale: z.string().max(600),
});
export type LlmProposal = z.infer<typeof LlmProposalSchema>;

export interface LlmReply {
  parsed: LlmProposal | null;
  model: string;
  stopReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  responseText: string;
}

/** Transport seam: the real Anthropic client or a fake in tests. */
export interface LlmClient {
  readonly provider: string;
  complete(req: { model: string; system: string; user: string }, signal: AbortSignal, timeoutMs: number): Promise<LlmReply>;
}

/** USD per million tokens, from the Claude API model table (cached 2026-10-06). Unknown models -> cost unknown. */
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};

export function estimateCostUsd(model: string, inputTokens: number | null, outputTokens: number | null): string | null {
  const p = PRICES[model];
  if (!p || inputTokens === null || outputTokens === null) return null;
  return ((inputTokens * p.input + outputTokens * p.output) / 1_000_000).toFixed(8);
}

export class AnthropicLlmClient implements LlmClient {
  readonly provider = 'anthropic';
  private readonly client = new Anthropic();

  async complete(req: { model: string; system: string; user: string }, signal: AbortSignal, timeoutMs: number): Promise<LlmReply> {
    const response = await this.client.messages.parse(
      {
        model: req.model,
        max_tokens: 2000,
        system: req.system,
        output_config: { format: zodOutputFormat(LlmProposalSchema), effort: 'low' },
        messages: [{ role: 'user', content: req.user }],
      },
      { signal, timeout: timeoutMs, maxRetries: 0 },
    );
    const text = response.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return {
      parsed: response.stop_reason === 'refusal' ? null : (response.parsed_output ?? null),
      model: response.model,
      stopReason: response.stop_reason,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      responseText: text,
    };
  }
}

const SYSTEM = [
  'You are a constrained strategy component in a PAPER (simulated) BTC-USD trading experiment.',
  'Propose either "hold" or a target BTC portfolio weight between 0 and 1 based only on the snapshot provided.',
  'A deterministic risk engine clamps the weight to the session exposure limit and decides whether any order is placed.',
  'You cannot place orders, change balances, prices, limits or execution mode.',
  'Echo the snapshotId exactly. Keep the rationale under 600 characters.',
].join(' ');

export class LlmStrategy implements StrategyPort {
  readonly kind = 'llm' as const;
  readonly paid = true;
  readonly id = 'llm';
  readonly warmupBars = 48;

  constructor(
    private readonly client: LlmClient,
    readonly model: string,
    private readonly timeoutMs: number,
    private readonly intentTtlMs: number,
  ) {}

  /** The bounded, causal view the model receives. */
  static buildUserPrompt(input: StrategyInput): string {
    return canonicalJson({
      snapshotId: input.snapshotId,
      asOf: new Date(input.asOf).toISOString(),
      completedBars5m: input.bars
        .slice(-48)
        .map((b) => [new Date(b.start).toISOString().slice(11, 16), b.open, b.high, b.low, b.close, b.volume]),
      bestBid: input.bestBid,
      bestAsk: input.bestAsk,
      feedHealth: input.feedHealth,
      balances: input.balances,
      currentBtcWeight: input.weight.toFixed(4),
      openOrders: input.openOrders,
      limits: input.limits,
      fees: input.fees,
      executionModel: 'market IOC against the live order book after a conservative delay; fees and spread are paid on every trade',
    });
  }

  async decide(input: StrategyInput, signal: AbortSignal): Promise<StrategyResult> {
    const user = LlmStrategy.buildUserPrompt(input);
    const requestHash = sha256(this.model + SYSTEM + user);
    const started = Date.now();
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const reply = await this.client.complete({ model: this.model, system: SYSTEM, user }, ctrl.signal, this.timeoutMs);
      const model = {
        provider: this.client.provider,
        model: reply.model,
        requestHash,
        responseHash: sha256(reply.responseText),
        latencyMs: Date.now() - started,
        inputTokens: reply.inputTokens ?? undefined,
        outputTokens: reply.outputTokens ?? undefined,
      };
      if (reply.model !== this.model)
        return { intent: null, outcome: 'invalid', detail: `unexpected model ${reply.model} (frozen: ${this.model})`, model };
      if (reply.stopReason === 'refusal') return { intent: null, outcome: 'invalid', detail: 'model refused', model };
      const parsed = LlmProposalSchema.safeParse(reply.parsed);
      if (!parsed.success) return { intent: null, outcome: 'invalid', detail: 'malformed or missing structured output', model };
      if (parsed.data.snapshotId !== input.snapshotId)
        return { intent: null, outcome: 'invalid', detail: 'invented or mismatched snapshot reference', model };
      return {
        outcome: 'ok',
        model,
        intent: {
          decisionId: `d-${input.asOf}`,
          snapshotId: input.snapshotId,
          action: parsed.data.action,
          targetWeight: parsed.data.action === 'target' ? parsed.data.targetWeight.toFixed(6) : undefined,
          validUntil: input.asOf + this.intentTtlMs,
          rationale: parsed.data.rationale,
        },
      };
    } catch (e) {
      const timedOut = ctrl.signal.aborted && !signal.aborted;
      return {
        intent: null,
        outcome: timedOut ? 'timeout' : 'error',
        detail: timedOut ? `no response within ${this.timeoutMs}ms` : String(e).slice(0, 300),
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
}
