import type { z } from 'zod';

/**
 * Minimal JSON GET client for keyless public APIs: timeout, a per-host
 * minimum interval (polite rate limiting), retries with backoff, and schema
 * validation so a changed or malformed response is rejected instead of
 * silently feeding bad numbers into the system.
 */
const lastCall = new Map<string, number>();

export class ContextFetchError extends Error {
  override name = 'ContextFetchError';
}

export interface FetchOpts {
  timeoutMs?: number;
  retries?: number;
  /** Minimum ms between calls to the same host. */
  minIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

export async function getJson<S extends z.ZodTypeAny>(url: string, schema: S, o: FetchOpts = {}): Promise<z.infer<S>> {
  const host = new URL(url).host;
  const retries = o.retries ?? 2;
  const f = o.fetchImpl ?? fetch;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const wait = (lastCall.get(host) ?? 0) + (o.minIntervalMs ?? 1000) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall.set(host, Date.now());
    try {
      const res = await f(url, {
        signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
        headers: { accept: 'application/json', 'user-agent': 'jbelford-research/0.3' },
      });
      if (res.status === 451 || res.status === 403) {
        // Geo/eligibility block: retrying will not help.
        throw new ContextFetchError(`${host} refused access (HTTP ${res.status})`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = schema.safeParse(await res.json());
      if (!parsed.success) throw new ContextFetchError(`${host} response failed validation: ${parsed.error.issues[0]?.message}`);
      return parsed.data;
    } catch (e) {
      lastErr = e;
      if (e instanceof ContextFetchError) throw e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw new ContextFetchError(`${url}: ${String(lastErr)}`);
}
