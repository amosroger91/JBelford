import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { appContext, openModeStore } from './common';
import { triggerKill } from '../safety/killSwitch';
import { RiskEngine } from '../risk/engine';

/**
 * EMERGENCY KILL SWITCH.
 *   npm run kill
 *   npm run kill -- --reason "something looks wrong"
 * Creates state/KILL (running engines cancel orders, flatten, and stop within
 * about a second) and writes a manual-reset halt into every mode database, so
 * nothing restarts trading until a human runs `npm run halt:reset`.
 */
const { values } = parseArgs({ options: { reason: { type: 'string', default: 'manual kill switch' } } });

const { stateDir } = appContext();
const now = Date.now();
triggerKill(stateDir, values.reason!, now);
for (const mode of ['paper', 'live'] as const) {
  if (!existsSync(join(stateDir, `${mode}.db`))) continue;
  const store = openModeStore(stateDir, mode);
  new RiskEngine(store).halt(`kill switch: ${values.reason}`, 'manual_reset', now);
  store.db.close();
}
console.log(`KILL SWITCH ACTIVATED (${values.reason}).`);
console.log('Running engines will cancel open orders, flatten any position, and stop.');
console.log('Verify on the exchange website that no orders/positions remain if trading live.');
console.log('To resume later, after investigating: npm run halt:reset');
