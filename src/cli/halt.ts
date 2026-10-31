import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { appContext, openModeStore, requireTypedConfirmation } from './common';
import { RiskEngine } from '../risk/engine';
import { clearKill, readKill } from '../safety/killSwitch';

/**
 * npm run halt:status   show halts and kill switch
 * npm run halt:reset    human-only: clear kill switch, halts and loss streak
 */
const cmd = process.argv[2];
const { stateDir } = appContext();
const now = Date.now();

async function main() {
  const kill = readKill(stateDir);
  console.log(`Kill switch: ${kill ? `ACTIVE since ${kill.at} (${kill.reason})` : 'off'}`);
  const modes = (['paper', 'live'] as const).filter((m) => existsSync(join(stateDir, `${m}.db`)));
  for (const mode of modes) {
    const store = openModeStore(stateDir, mode);
    const risk = new RiskEngine(store);
    const h = risk.activeHalt(now);
    const s = risk.dailyStats(now);
    console.log(
      `[${mode}] halt: ${h ? `${h.kind} - ${h.reason}` : 'none'} | today trades ${s.tradesToday}, realized $${s.realizedTodayUsd.toFixed(4)}, loss streak ${s.consecutiveLosses}`,
    );
    store.db.close();
  }
  if (cmd !== 'reset') return;
  const ok = await requireTypedConfirmation('Clear the kill switch, all halts and the consecutive-loss streak?', 'RESET HALTS');
  if (!ok) {
    console.error('Not reset.');
    process.exit(1);
  }
  clearKill(stateDir);
  for (const mode of modes) {
    const store = openModeStore(stateDir, mode);
    new RiskEngine(store).resetHalt(now, process.env.USERNAME ?? 'operator');
    store.db.close();
  }
  console.log('Halts cleared. Daily limits (trades, loss) still apply for today.');
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
