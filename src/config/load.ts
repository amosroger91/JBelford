import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppConfigSchema, StrategyParamsSchema, type AppConfig, type StrategyParams } from './schema';

export const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
export const APP_CONFIG_PATH = resolve(PROJECT_ROOT, 'config', 'default.json');
export const STRATEGY_CONFIG_PATH = resolve(PROJECT_ROOT, 'config', 'strategy.json');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadAppConfig(path = APP_CONFIG_PATH): AppConfig {
  return AppConfigSchema.parse(readJson(path));
}

export function loadStrategyParams(path = STRATEGY_CONFIG_PATH): StrategyParams {
  return StrategyParamsSchema.parse(readJson(path));
}

export function resolvePath(p: string): string {
  return resolve(PROJECT_ROOT, p);
}

export function ensureDir(p: string): string {
  const abs = resolvePath(p);
  mkdirSync(abs, { recursive: true });
  return abs;
}
