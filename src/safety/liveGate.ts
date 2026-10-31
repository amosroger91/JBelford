import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PROJECT_ROOT, APP_CONFIG_PATH, STRATEGY_CONFIG_PATH, loadStrategyConfig } from '../config/load';
import { gateBlockers } from '../backtest/gate';
import { isKillActive } from './killSwitch';

/**
 * DEPLOYMENT-STAGE SWITCH.
 *
 * Live trading code exists but is unreachable while this is `false`. Changing
 * it is part of the explicit live deployment stage, which requires the
 * owner's written authorization. Changing it alone is not enough: the
 * authorization file, env vars and credentials are also required.
 * See docs/LIVE_ACTIVATION.md.
 */
export const LIVE_STAGE_ENABLED = false;

export const MAX_AUTHORIZATION_HOURS = 24;

export function authorizationPhrase(exchangeId: string): string {
  return `I AUTHORIZE LIVE TRADING ON ${exchangeId.toUpperCase()} BTC/USD WITH REAL MONEY`;
}

/** Files whose exact content the authorization is bound to. */
export const FINGERPRINTED_FILES = [
  'src/risk/limits.ts',
  'src/risk/engine.ts',
  'src/exec/guardedAdapter.ts',
  'src/exec/engine.ts',
  'src/exec/liveAdapter.ts',
  'src/safety/liveGate.ts',
  'src/backtest/gate.ts',
] as const;

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function computeFingerprints(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of FINGERPRINTED_FILES) out[f] = sha256File(resolve(PROJECT_ROOT, f));
  out['config/default.json'] = sha256File(APP_CONFIG_PATH);
  out['config/strategy.json'] = sha256File(STRATEGY_CONFIG_PATH);
  return out;
}

export interface LiveAuthorizationFile {
  version: 1;
  exchange: string;
  symbol: 'BTC/USD';
  operator: string;
  phrase: string;
  createdAt: string;
  expiresAt: string;
  fingerprints: Record<string, string>;
}

export function authorizationPath(stateDir: string): string {
  return join(stateDir, 'live-authorization.json');
}

export function writeAuthorization(stateDir: string, exchange: string, operator: string, hours: number, now = Date.now()): LiveAuthorizationFile {
  if (!(hours > 0 && hours <= MAX_AUTHORIZATION_HOURS)) throw new Error(`hours must be in (0, ${MAX_AUTHORIZATION_HOURS}]`);
  const auth: LiveAuthorizationFile = {
    version: 1,
    exchange,
    symbol: 'BTC/USD',
    operator,
    phrase: authorizationPhrase(exchange),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + hours * 3_600_000).toISOString(),
    fingerprints: computeFingerprints(),
  };
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(authorizationPath(stateDir), JSON.stringify(auth, null, 2));
  return auth;
}

/** Proof object: only obtainable from verifyLiveGate when every condition holds. */
export class LiveAuthorization {
  private constructor(
    readonly exchange: string,
    readonly expiresAt: number,
  ) {}

  /** @internal used only by verifyLiveGate */
  static issue(exchange: string, expiresAt: number): LiveAuthorization {
    return new LiveAuthorization(exchange, expiresAt);
  }

  isValid(now = Date.now()): boolean {
    return LIVE_STAGE_ENABLED && now < this.expiresAt;
  }
}

export interface GateResult {
  ok: boolean;
  reasons: string[];
  authorization?: LiveAuthorization;
}

export function verifyLiveGate(opts: { stateDir: string; exchangeId: string; env?: NodeJS.ProcessEnv; now?: number }): GateResult {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const reasons: string[] = [];

  if (!LIVE_STAGE_ENABLED) reasons.push('LIVE_STAGE_ENABLED is false (live deployment stage not authorized)');
  if (env.JB_TRADING_MODE !== 'live') reasons.push('JB_TRADING_MODE is not "live"');
  if (!env.JB_API_KEY || !env.JB_API_SECRET) reasons.push('JB_API_KEY / JB_API_SECRET not set in environment');
  if (isKillActive(opts.stateDir)) reasons.push('kill switch is active');
  try {
    reasons.push(...gateBlockers(opts.stateDir, loadStrategyConfig().active, sha256File(STRATEGY_CONFIG_PATH), now));
  } catch (e) {
    reasons.push(`strategy config invalid: ${String(e)}`);
  }

  const path = authorizationPath(opts.stateDir);
  let expiresAt = 0;
  if (!existsSync(path)) {
    reasons.push('no live authorization file (run `npm run live:authorize` in an interactive terminal)');
  } else {
    try {
      const a = JSON.parse(readFileSync(path, 'utf8')) as LiveAuthorizationFile;
      expiresAt = Date.parse(a.expiresAt);
      if (a.version !== 1) reasons.push('unknown authorization version');
      if (a.exchange !== opts.exchangeId) reasons.push(`authorization is for ${a.exchange}, config uses ${opts.exchangeId}`);
      if (a.phrase !== authorizationPhrase(a.exchange)) reasons.push('authorization phrase mismatch');
      if (!(now < expiresAt)) reasons.push('authorization expired');
      if (expiresAt - Date.parse(a.createdAt) > MAX_AUTHORIZATION_HOURS * 3_600_000) reasons.push('authorization window too long');
      const current = computeFingerprints();
      for (const [file, hash] of Object.entries(current)) {
        if (a.fingerprints?.[file] !== hash) reasons.push(`${file} changed since authorization`);
      }
    } catch (e) {
      reasons.push(`authorization file unreadable: ${String(e)}`);
    }
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, reasons, authorization: LiveAuthorization.issue(opts.exchangeId, expiresAt) };
}
