import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { appContext, openModeStore } from './common';
import { RiskEngine } from '../risk/engine';
import { buildSnapshot } from '../dashboard/snapshot';
import { renderDashboard } from '../dashboard/render';
import { readKill } from '../safety/killSwitch';

/**
 * Read-only terminal dashboard. Run it in a second PowerShell window while
 * the paper (or live) runner is going:
 *   npm run dashboard
 *   npm run dashboard -- --mode live
 *   npm run dashboard -- --once        print one frame and exit
 */
const { values } = parseArgs({
  options: {
    mode: { type: 'string', default: 'paper' },
    once: { type: 'boolean', default: false },
    interval: { type: 'string', default: '2' },
    'no-color': { type: 'boolean', default: false },
  },
});

const mode = values.mode === 'live' ? 'live' : 'paper';
const { cfg, stateDir } = appContext();
if (!existsSync(join(stateDir, `${mode}.db`))) {
  console.log(`No ${mode} database yet (state/${mode}.db). Start the runner first: npm run ${mode}`);
  process.exit(0);
}
const store = openModeStore(stateDir, mode);
const risk = new RiskEngine(store);

function frame(): string {
  return renderDashboard(buildSnapshot(store, risk, mode, readKill(stateDir), cfg.exchange.fees.taker), !values['no-color']);
}

if (values.once) {
  console.log(frame());
  store.db.close();
} else {
  const draw = () => process.stdout.write('\x1b[2J\x1b[H' + frame() + '\n');
  draw();
  const t = setInterval(draw, Math.max(1, Number(values.interval)) * 1000);
  process.on('SIGINT', () => {
    clearInterval(t);
    store.db.close();
    process.exit(0);
  });
}
