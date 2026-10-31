import { z } from 'zod';
import { STRATEGY_NAMES, STRATEGY_PARAM_SCHEMAS, StrategyConfigSchema, type StrategyConfig } from '../config/schema';

/**
 * Claude acts as a strategy SUPERVISOR: it may research markets (via CCXT
 * MCP and the market-context feeds), read reports, and write proposal files.
 * A proposal may only change one strategy's parameters and optionally make it
 * the active strategy. It cannot touch risk limits, promotion criteria, mode,
 * exchange, fees or credentials: those keys do not exist in the schema, and
 * unknown keys are rejected. Applying a proposal is a separate, human-only step.
 */
export const ProposalSchema = z
  .object({
    author: z.string().min(1),
    createdAt: z.string().min(1),
    rationale: z.string().min(10),
    strategy: z.enum(STRATEGY_NAMES),
    changes: z.record(z.string(), z.union([z.number(), z.array(z.number())])),
    activate: z.boolean().optional(),
    evidence: z.unknown().optional(),
  })
  .strict();

export type Proposal = z.infer<typeof ProposalSchema>;

export interface ProposalCheck {
  ok: boolean;
  errors: string[];
  merged?: StrategyConfig;
  diff: { key: string; from: unknown; to: unknown }[];
}

export function checkProposal(raw: unknown, current: StrategyConfig): ProposalCheck {
  const parsed = ProposalSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`), diff: [] };
  }
  const { strategy, changes, activate } = parsed.data;
  const keys = Object.keys(STRATEGY_PARAM_SCHEMAS[strategy].object.shape);
  const errors: string[] = [];
  const diff: ProposalCheck['diff'] = [];
  const currentParams = current[strategy] as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(changes)) {
    if (!keys.includes(k)) {
      errors.push(`"${k}" is not a ${strategy} parameter; proposals cannot change it`);
      continue;
    }
    diff.push({ key: `${strategy}.${k}`, from: currentParams[k], to: v });
  }
  if (activate && current.active !== strategy) diff.push({ key: 'active', from: current.active, to: strategy });
  if (diff.length === 0 && errors.length === 0) errors.push('proposal contains no changes');
  if (errors.length) return { ok: false, errors, diff };
  const mergedRaw = {
    ...current,
    active: activate ? strategy : current.active,
    [strategy]: { ...currentParams, ...changes },
  };
  const merged = StrategyConfigSchema.safeParse(mergedRaw);
  if (!merged.success) {
    return { ok: false, errors: merged.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`), diff };
  }
  return { ok: true, errors: [], merged: merged.data, diff };
}
