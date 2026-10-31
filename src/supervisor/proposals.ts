import { z } from 'zod';
import { STRATEGY_PARAM_KEYS as STRATEGY_KEYS, StrategyParamsSchema, type StrategyParams } from '../config/schema';

/**
 * Claude acts as a strategy SUPERVISOR: it may research markets (via CCXT
 * MCP), read reports, and write proposal files. A proposal may only change
 * strategy parameters. It cannot touch risk limits, trading mode, exchange,
 * fees, or credentials: those keys do not exist in the schema, and unknown
 * keys are rejected. Applying a proposal is a separate, human-only step.
 */
export const ProposalSchema = z
  .object({
    author: z.string().min(1),
    createdAt: z.string().min(1),
    rationale: z.string().min(10),
    changes: z.record(z.string(), z.number()),
    evidence: z.unknown().optional(),
  })
  .strict();

export type Proposal = z.infer<typeof ProposalSchema>;

export interface ProposalCheck {
  ok: boolean;
  errors: string[];
  merged?: StrategyParams;
  diff: { key: string; from: number; to: number }[];
}

export function checkProposal(raw: unknown, current: StrategyParams): ProposalCheck {
  const errors: string[] = [];
  const parsed = ProposalSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`), diff: [] };
  }
  const diff: ProposalCheck['diff'] = [];
  for (const [k, v] of Object.entries(parsed.data.changes)) {
    if (!(STRATEGY_KEYS as string[]).includes(k)) {
      errors.push(`"${k}" is not a strategy parameter; proposals cannot change it`);
      continue;
    }
    diff.push({ key: k, from: current[k as keyof StrategyParams], to: v });
  }
  if (diff.length === 0 && errors.length === 0) errors.push('proposal contains no changes');
  if (errors.length) return { ok: false, errors, diff };
  const mergedRaw = { ...current, ...parsed.data.changes };
  const merged = StrategyParamsSchema.safeParse(mergedRaw);
  if (!merged.success) {
    return { ok: false, errors: merged.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`), diff };
  }
  return { ok: true, errors: [], merged: merged.data, diff };
}
