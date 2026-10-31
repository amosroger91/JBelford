import { randomUUID } from 'node:crypto';

/**
 * Client order ids are UUIDv4 strings. Kraken accepts a UUID as `cl_ord_id`,
 * Coinbase requires a unique `client_order_id`. The id is persisted BEFORE the
 * order is sent so a retry after an ambiguous response can be matched to the
 * original order instead of creating a duplicate.
 */
export function newClientOrderId(): string {
  return randomUUID();
}

export function newTradeId(): string {
  return 't-' + randomUUID().slice(0, 8);
}

/** Round down to a step (amounts: never exceed intended size/limit). */
export function floorToStep(value: number, step: number): number {
  const n = Math.floor(value / step + 1e-9);
  return roundDecimals(n * step, decimalsOf(step));
}

export function roundToStep(value: number, step: number): number {
  const n = Math.round(value / step);
  return roundDecimals(n * step, decimalsOf(step));
}

export function ceilToStep(value: number, step: number): number {
  const n = Math.ceil(value / step - 1e-9);
  return roundDecimals(n * step, decimalsOf(step));
}

function decimalsOf(step: number): number {
  if (step >= 1) return 0;
  return Math.min(12, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
}

function roundDecimals(v: number, d: number): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

export const MINUTE = 60_000;

export function utcDayStart(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Deterministic PRNG (mulberry32) for reproducible simulations. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fmtUsd(v: number, digits = 2): string {
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toFixed(digits)}`;
}
