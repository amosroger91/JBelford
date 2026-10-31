import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIVE_STAGE_ENABLED, LiveAuthorization, verifyLiveGate } from '../src/safety/liveGate';
import { LiveAdapter } from '../src/exec/liveAdapter';
import { clearKill, isKillActive, triggerKill } from '../src/safety/killSwitch';
import { redact, registerSecret } from '../src/core/log';
import { checkProposal } from '../src/supervisor/proposals';
import { AppConfigSchema } from '../src/config/schema';
import { loadAppConfig } from '../src/config/load';
import { PARAMS } from './helpers';

describe('live gate', () => {
  it('live stage is disabled in this build', () => {
    expect(LIVE_STAGE_ENABLED).toBe(false);
  });

  it('refuses even with mode, credentials and no kill switch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jb-'));
    const r = verifyLiveGate({ stateDir: dir, exchangeId: 'kraken', env: { JB_TRADING_MODE: 'live', JB_API_KEY: 'k', JB_API_SECRET: 's' } });
    expect(r.ok).toBe(false);
    expect(r.authorization).toBeUndefined();
    expect(r.reasons.join()).toMatch(/LIVE_STAGE_ENABLED/);
    expect(r.reasons.join()).toMatch(/no live authorization file/);
  });

  it('LiveAdapter cannot be constructed without a valid authorization', () => {
    const fake = LiveAuthorization.issue('kraken', Date.now() + 3_600_000);
    expect(fake.isValid()).toBe(false); // stage disabled
    expect(() => new LiveAdapter(fake, 'kraken', 'BTC/USD')).toThrow(/not authorized/);
    expect(() => new LiveAdapter({} as LiveAuthorization, 'kraken', 'BTC/USD')).toThrow(/not authorized/);
  });
});

describe('kill switch', () => {
  it('creates and clears the KILL file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jb-'));
    expect(isKillActive(dir)).toBe(false);
    triggerKill(dir, 'test');
    expect(isKillActive(dir)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'KILL'), 'utf8')).reason).toBe('test');
    clearKill(dir);
    expect(isKillActive(dir)).toBe(false);
  });
});

describe('secret redaction', () => {
  it('redacts credential-looking keys and registered values', () => {
    registerSecret('SUPERSECRETKEY123');
    const out = redact({ apiKey: 'abc', nested: { secret: 'x', msg: 'auth failed for SUPERSECRETKEY123' }, price: 1 }) as Record<string, unknown>;
    expect(out.apiKey).toBe('[REDACTED]');
    expect((out.nested as Record<string, unknown>).secret).toBe('[REDACTED]');
    expect(JSON.stringify(out)).not.toContain('SUPERSECRETKEY123');
    expect(out.price).toBe(1);
  });
});

describe('Claude proposals cannot touch risk or mode', () => {
  const p = (changes: Record<string, number>) => ({ author: 'claude', createdAt: '2026-10-31', rationale: 'testing proposal bounds', changes });

  it('accepts in-bounds strategy changes', () => {
    const r = checkProposal(p({ minRocPct: 0.2, volMult: 2 }), PARAMS);
    expect(r.ok).toBe(true);
    expect(r.merged?.minRocPct).toBe(0.2);
  });

  it.each(['maxOrderValueUsd', 'maxDailyLossUsd', 'maxConsecutiveLosses', 'cooldownMs', 'liveTrading', 'leverage'])('rejects %s', (key) => {
    const r = checkProposal(p({ [key]: 999 }), PARAMS);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/not a strategy parameter/);
  });

  it('rejects out-of-bounds values and extra top-level fields', () => {
    expect(checkProposal(p({ stopLossPct: 50 }), PARAMS).ok).toBe(false);
    expect(checkProposal({ ...p({ minRocPct: 0.2 }), mode: 'live' }, PARAMS).ok).toBe(false);
  });

  it('app config has no risk-limit or live-mode settings at all', () => {
    const cfg = loadAppConfig();
    expect(JSON.stringify(cfg)).not.toMatch(/maxOrder|maxDaily|leverage|live/i);
    expect(AppConfigSchema.safeParse({ ...cfg, risk: { maxOrderValueUsd: 1000 } }).success).toBe(false);
  });
});
