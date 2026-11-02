import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { PaperOnlyError } from '../paper/domain';

/**
 * Kalshi paper test of research candidate A (batch K-01): rest maker bids on the
 * favorite side (best bid >= minFavoriteBid) in 15-minute commodity markets, i.e.
 * sell the longshot to takers. Parameters are frozen from the research; changing
 * any of them is a new experiment.
 */
export const KalshiConfigSchema = z
  .object({
    mode: z.literal('paper'),
    purpose: z.string().min(3),
    series: z.array(z.string().regex(/^KX[A-Z0-9]+$/)).min(1),
    bankrollUsd: z.number().positive().max(1_000_000),
    /** Join the favorite side only when its best bid is at least this (longshot <= 1 - this). */
    minFavoriteBid: z.number().min(0.5).max(0.999),
    maxCollateralPerMarketUsd: z.number().positive(),
    orderContracts: z.number().int().min(1).max(10_000),
    /** Stop posting this many seconds before a market closes (0 = post until close). */
    stopPostingSecondsBeforeClose: z.number().int().min(0).max(900),
    pollMs: z.number().int().min(1000).max(60_000),
    marketsRefreshMs: z.number().int().min(5000).max(300_000),
    /** After the run ends, keep checking results of open positions for at most this long. */
    settleWaitMs: z.number().int().min(0).max(3_600_000),
    recordingDir: z.string().min(1),
  })
  .strict();

export type KalshiConfig = z.infer<typeof KalshiConfigSchema>;

export function parseKalshiConfig(raw: unknown): KalshiConfig {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') throw new Error('config must be an object');
  if (r.mode !== 'paper') throw new PaperOnlyError(`mode "${String(r.mode)}" is not supported: Kalshi support is paper-only`);
  for (const k of ['apiKey', 'apiKeyId', 'privateKey', 'credentials', 'live', 'email', 'password']) {
    if (k in r) throw new PaperOnlyError(`config key "${k}" is not allowed: Kalshi paper mode never uses an account`);
  }
  return Object.freeze(KalshiConfigSchema.parse(raw)) as KalshiConfig;
}

export function loadKalshiConfig(path: string): KalshiConfig {
  return parseKalshiConfig(parseYaml(readFileSync(path, 'utf8')));
}
