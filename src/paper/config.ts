import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { PaperOnlyError } from './domain';

const decStr = z.string().regex(/^\d+(\.\d+)?$/, 'expected a non-negative decimal string');
const fraction = decStr.refine((s) => Number(s) <= 1, 'must be <= 1');

export const STRATEGY_IDS = [
  'cash',
  'buyHold',
  'matchedExposure',
  'smokeProbe',
  'emaTrend',
  'donchianBreakout',
  'rsiReversion',
  'sessionMomentum',
  'llm',
] as const;
export type StrategyId = (typeof STRATEGY_IDS)[number];

export const PaperConfigSchema = z
  .object({
    /** Only "paper" exists in this release. Anything else is rejected before parsing the rest. */
    mode: z.literal('paper'),
    venue: z.literal('coinbase'),
    product: z.literal('BTC-USD'),
    purpose: z.string().min(3),
    initialBalances: z.object({ usd: decStr, btc: decStr }).strict(),
    strategy: z
      .object({
        id: z.enum(STRATEGY_IDS),
        params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).default({}),
      })
      .strict(),
    decision: z
      .object({
        barSeconds: z.literal(300),
        timeoutMs: z.number().int().min(100).max(120_000),
        intentTtlMs: z.number().int().min(1_000).max(600_000),
        /** One in-flight decision per session; bars arriving meanwhile are skipped and audited. */
        coalesce: z.literal('skip'),
      })
      .strict(),
    execution: z
      .object({
        model: z.literal('ioc-depth-walk-v1'),
        delayMs: z.number().int().min(0).max(60_000),
        /** Max fraction of each displayed level our simulated orders may consume. */
        participation: fraction,
        /** Execution guard: never fill worse than this many bps from the touch at arrival. */
        guardBps: z.number().min(1).max(1000),
      })
      .strict(),
    fees: z
      .object({
        version: z.string().min(1),
        takerRate: decStr,
        makerRate: decStr,
        source: z.string().min(1),
        asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        verified: z.boolean(),
      })
      .strict(),
    risk: z
      .object({
        version: z.string().min(1),
        maxExposure: fraction,
        maxOrderPctEquity: fraction,
        dailyLossPausePct: fraction,
        drawdownPausePct: fraction,
        maxSpreadBps: z.number().min(0.1).max(500),
        minTouchDepthUsd: decStr,
        maxOrdersPerHour: z.number().int().min(1).max(1000),
        maxOpenOrders: z.number().int().min(1).max(10),
        minRebalancePctEquity: fraction,
        /** USD; known model/data costs above this pause new orders. Unknown costs never count as zero. */
        operatingCostBudgetUsd: decStr,
      })
      .strict(),
    feed: z
      .object({
        staleMs: z.number().int().min(500).max(120_000),
        maxClockSkewMs: z.number().int().min(100).max(120_000),
        tickMs: z.number().int().min(100).max(10_000),
        reconnectMinMs: z.number().int().min(100),
        reconnectMaxMs: z.number().int().min(1000),
      })
      .strict(),
    recording: z.object({ dir: z.string().min(1), segmentSeconds: z.number().int().min(10).max(3600) }).strict(),
    storage: z.object({ db: z.string().min(1) }).strict(),
    readiness: z
      .object({
        version: z.string().min(1),
        minDays: z.number().min(1),
        minRoundTrips: z.number().int().min(1),
        minCoveragePct: z.number().min(0).max(100),
        minContinuousHours: z.number().min(0),
        bootstrapBlockDays: z.number().int().min(1),
        bootstrapSamples: z.number().int().min(100),
        confidence: z.number().min(0.5).max(0.999),
      })
      .strict(),
  })
  .strict();

export type PaperConfig = z.infer<typeof PaperConfigSchema>;

/**
 * Parse and validate a config object. Any request for live execution fails
 * with PaperOnlyError, regardless of other fields or environment variables.
 */
export function parsePaperConfig(raw: unknown): PaperConfig {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') throw new Error('config must be an object');
  if (r.mode !== 'paper') {
    throw new PaperOnlyError(`mode "${String(r.mode)}" is not supported: this release is paper-only (live execution is disabled)`);
  }
  for (const k of ['live', 'liveTrading', 'apiKey', 'apiSecret', 'credentials', 'broker']) {
    if (k in r) throw new PaperOnlyError(`config key "${k}" is not allowed in paper mode`);
  }
  return Object.freeze(PaperConfigSchema.parse(raw)) as PaperConfig;
}

export function loadPaperConfig(path: string): PaperConfig {
  return parsePaperConfig(parseYaml(readFileSync(path, 'utf8')));
}

/** Deterministic JSON with sorted keys (for hashing identities). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function configHash(c: PaperConfig): string {
  return sha256(canonicalJson(c));
}

/**
 * Experiment identity: anything that changes what the strategy would do or how
 * results are measured. Editing any of these creates a new experiment version
 * (plan acceptance test 13).
 */
export function strategyVersionHash(c: PaperConfig): string {
  return sha256(
    canonicalJson({
      strategy: c.strategy,
      decision: c.decision,
      execution: c.execution,
      fees: c.fees,
      risk: c.risk,
      readiness: c.readiness,
      product: c.product,
      venue: c.venue,
    }),
  );
}
