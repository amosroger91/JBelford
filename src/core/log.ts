/**
 * Minimal structured logger with secret redaction. Any field whose key looks
 * like a credential is replaced, and strings that look like the configured
 * API key/secret are scrubbed, so credentials never reach stdout or the DB.
 */
const SECRET_KEY = /(api[-_]?key|secret|token|password|passphrase|signature|authorization)/i;

const sensitiveValues = new Set<string>();

/** Register a value (e.g. an API key read from env) that must never be printed. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 6) sensitiveValues.add(value);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') {
    let out = value;
    for (const s of sensitiveValues) out = out.split(s).join('[REDACTED]');
    return out;
  }
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message, depth + 1) };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogSink = (level: LogLevel, msg: string, data?: Record<string, unknown>) => void;

let quiet = false;
const extraSinks: LogSink[] = [];

export function setQuiet(q: boolean): void {
  quiet = q;
}

export function addLogSink(sink: LogSink): void {
  extraSinks.push(sink);
}

function emit(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
  const safeMsg = redact(msg) as string;
  const safeData = data ? (redact(data) as Record<string, unknown>) : undefined;
  for (const s of extraSinks) s(level, safeMsg, safeData);
  if (quiet && level !== 'error') return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${safeMsg}${safeData ? ' ' + JSON.stringify(safeData) : ''}`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

export const log = {
  debug: (m: string, d?: Record<string, unknown>) => {
    if (process.env.JB_DEBUG) emit('debug', m, d);
  },
  info: (m: string, d?: Record<string, unknown>) => emit('info', m, d),
  warn: (m: string, d?: Record<string, unknown>) => emit('warn', m, d),
  error: (m: string, d?: Record<string, unknown>) => emit('error', m, d),
};
