import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * File-based emergency kill switch. Any process (or a human with a text
 * editor) can create `state/KILL`; every running engine checks it on each
 * tick, cancels open orders, flattens the position and stops. Engines also
 * refuse to start while the file exists.
 */
export function killFilePath(stateDir: string): string {
  return join(stateDir, 'KILL');
}

export function triggerKill(stateDir: string, reason: string, now = Date.now()): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(killFilePath(stateDir), JSON.stringify({ at: new Date(now).toISOString(), reason }, null, 2));
}

export function isKillActive(stateDir: string): boolean {
  return existsSync(killFilePath(stateDir));
}

export function readKill(stateDir: string): { at: string; reason: string } | null {
  if (!isKillActive(stateDir)) return null;
  try {
    return JSON.parse(readFileSync(killFilePath(stateDir), 'utf8'));
  } catch {
    return { at: 'unknown', reason: 'KILL file present' };
  }
}

export function clearKill(stateDir: string): void {
  rmSync(killFilePath(stateDir), { force: true });
}
