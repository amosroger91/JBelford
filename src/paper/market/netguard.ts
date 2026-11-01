/**
 * Paper-mode network allowlist: method + host + path (plan section 5).
 * Public and private Coinbase APIs share api.coinbase.com, so the host alone is
 * not enough. Only these public GET resources and the public WebSocket are
 * reachable. Requests never carry credentials, even if exchange-credential
 * environment variables are present.
 */
const ALLOWED: { method: 'GET'; host: string; path: RegExp }[] = [
  { method: 'GET', host: 'api.coinbase.com', path: /^\/api\/v3\/brokerage\/market\/products\/BTC-USD$/ },
  { method: 'GET', host: 'api.coinbase.com', path: /^\/api\/v3\/brokerage\/market\/product_book$/ },
  { method: 'GET', host: 'api.coinbase.com', path: /^\/api\/v3\/brokerage\/market\/products\/BTC-USD\/ticker$/ },
  { method: 'GET', host: 'api.coinbase.com', path: /^\/api\/v3\/brokerage\/market\/products\/BTC-USD\/candles$/ },
  // Binance.US public market data (research venue; no account endpoints)
  { method: 'GET', host: 'api.binance.us', path: /^\/api\/v3\/(klines|depth|exchangeInfo|ticker\/24hr)$/ },
];

export const PUBLIC_WS_URL = 'wss://advanced-trade-ws.coinbase.com';
/** Every public WebSocket the paper subsystem may open (exact URLs). */
const ALLOWED_WS = new Set([PUBLIC_WS_URL, 'wss://stream.binance.us:9443/stream?streams=btcusd@depth@100ms/btcusd@trade/btcusd@kline_5m']);

export class NetworkPolicyError extends Error {
  override name = 'NetworkPolicyError';
}

/** Audit trail of every outbound request attempt (tests assert on it). */
export const networkLog: { method: string; url: string; allowed: boolean; authenticated: boolean }[] = [];

export function checkRequest(method: string, url: string): void {
  const u = new URL(url);
  const ok =
    u.protocol === 'https:' && ALLOWED.some((a) => a.method === method.toUpperCase() && a.host === u.host && a.path.test(u.pathname));
  networkLog.push({ method: method.toUpperCase(), url: u.origin + u.pathname, allowed: ok, authenticated: false });
  if (!ok) throw new NetworkPolicyError(`paper mode blocks ${method.toUpperCase()} ${u.host}${u.pathname}`);
}

export function checkWebSocket(url: string): void {
  const ok = ALLOWED_WS.has(url);
  networkLog.push({ method: 'WS', url, allowed: ok, authenticated: false });
  if (!ok) throw new NetworkPolicyError(`paper mode blocks WebSocket ${url}`);
}

/** Subscribe messages must never include auth fields (jwt/api_key/signature). */
export function checkSubscribeMessage(msg: Record<string, unknown>): void {
  for (const k of ['jwt', 'api_key', 'signature', 'passphrase', 'timestamp_auth']) {
    if (k in msg) throw new NetworkPolicyError(`paper mode refuses authenticated WebSocket field "${k}"`);
  }
  if (msg.channel === 'user' || msg.channel === 'futures_balance_summary') {
    throw new NetworkPolicyError(`paper mode refuses private channel "${String(msg.channel)}"`);
  }
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

/** The ONLY HTTP client the paper subsystem uses. No auth headers are ever attached. */
export async function guardedGet(url: string, opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {}): Promise<unknown> {
  checkRequest('GET', url);
  const res = await (opts.fetchImpl ?? (fetch as FetchLike))(url, {
    method: 'GET',
    headers: { accept: 'application/json', 'user-agent': 'jbelford-paper/1.0' },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  if (!res.ok) throw new Error(`GET ${new URL(url).pathname} -> HTTP ${res.status}`);
  return res.json();
}
