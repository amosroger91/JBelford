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
import { loadAppConfig, loadStrategyConfig } from '../src/config/load';

describe('live gate', () => {
  it('live stage is disabled in this build', () => {
    expect(LIVE_STAGE_ENABLED).toBe(false);
  });

  it('refuses even with mode, credentials and no kill switch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jb-'));
    const r = verifyLiveGate({
      stateDir: dir,
      exchangeId: 'kraken',
      env: { JB_TRADING_MODE: 'live', JB_API_KEY: 'k', JB_API_SECRET: 's' },
    });
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
    const out = redact({ apiKey: 'abc', nested: { secret: 'x', msg: 'auth failed for SUPERSECRETKEY123' }, price: 1 }) as Record<
      string,
      unknown
    >;
    expect(out.apiKey).toBe('[REDACTED]');
    expect((out.nested as Record<string, unknown>).secret).toBe('[REDACTED]');
    expect(JSON.stringify(out)).not.toContain('SUPERSECRETKEY123');
    expect(out.price).toBe(1);
  });
});

describe('Claude proposals cannot touch risk or mode', () => {
  const current = loadStrategyConfig();
  const p = (changes: Record<string, number | number[]>, extra: Record<string, unknown> = {}) => ({
    author: 'claude',
    createdAt: '2026-10-31',
    rationale: 'testing proposal bounds',
    strategy: 'momentum',
    changes,
    ...extra,
  });

  it('accepts in-bounds strategy changes', () => {
    const r = checkProposal(p({ minRocPct: 0.2, volMult: 2 }), current);
    expect(r.ok).toBe(true);
    expect(r.merged?.momentum.minRocPct).toBe(0.2);
    expect(r.merged?.active).toBe(current.active);
  });

  it('can switch the active strategy and edit allowed hours', () => {
    const r = checkProposal(p({ allowedHoursUtc: [13, 14, 15] }, { strategy: 'volBreakout', activate: true }), current);
    expect(r.ok).toBe(true);
    expect(r.merged?.active).toBe('volBreakout');
    expect(r.merged?.volBreakout.allowedHoursUtc).toEqual([13, 14, 15]);
  });

  it.each(['maxOrderValueUsd', 'maxDailyLossUsd', 'maxConsecutiveLosses', 'cooldownMs', 'liveTrading', 'leverage', 'minDeflatedSharpe'])(
    'rejects %s',
    (key) => {
      const r = checkProposal(p({ [key]: 999 }), current);
      expect(r.ok).toBe(false);
      expect(r.errors.join()).toMatch(/not a momentum parameter/);
    },
  );

  it('rejects out-of-bounds values, multi-day holds, unknown strategies and extra top-level fields', () => {
    expect(checkProposal(p({ stopLossPct: 50 }), current).ok).toBe(false);
    expect(checkProposal(p({ maxHoldMinutes: 2880 }), current).ok).toBe(false);
    expect(checkProposal(p({ minRocPct: 0.2 }, { strategy: 'martingale' }), current).ok).toBe(false);
    expect(checkProposal({ ...p({ minRocPct: 0.2 }), mode: 'live' }, current).ok).toBe(false);
  });

  it('app config has no risk-limit or live-mode settings at all', () => {
    const cfg = loadAppConfig();
    expect(JSON.stringify(cfg)).not.toMatch(/maxOrder|maxDaily|leverage|live/i);
    expect(AppConfigSchema.safeParse({ ...cfg, risk: { maxOrderValueUsd: 1000 } }).success).toBe(false);
  });
});
