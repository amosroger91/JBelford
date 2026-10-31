import { parseArgs } from 'node:util';
import { appContext, requireTypedConfirmation } from './common';
import { loadStrategyConfig } from '../config/load';
import { HARD_LIMITS } from '../risk/limits';
import { LIVE_STAGE_ENABLED, MAX_AUTHORIZATION_HOURS, authorizationPhrase, writeAuthorization } from '../safety/liveGate';
import { roundTripEconomics } from '../economics/costs';
import { activeStrategy } from '../strategy/registry';

/**
 * Human-only live authorization. Must be run in an interactive terminal by
 * the account owner. Writes state/live-authorization.json bound (by SHA-256)
 * to the current risk code, engine code and configs, valid for at most 24h.
 */
const { values } = parseArgs({ options: { hours: { type: 'string', default: '8' }, operator: { type: 'string' } } });

async function main() {
  const { cfg, stateDir } = appContext();
  if (!LIVE_STAGE_ENABLED) {
    console.error('Live deployment stage is not enabled in this build (LIVE_STAGE_ENABLED = false).');
    console.error('See docs/LIVE_ACTIVATION.md. Nothing was written.');
    process.exit(1);
  }
  const hours = Number(values.hours);
  if (!(hours > 0 && hours <= MAX_AUTHORIZATION_HOURS)) throw new Error(`--hours must be between 0 and ${MAX_AUTHORIZATION_HOURS}`);
  if (!values.operator) throw new Error('--operator "<your name>" is required');
  const strategy = activeStrategy(loadStrategyConfig(), cfg.exchange.fees);
  // Exits are sized per trade by the strategy; show a reference 1.5% target / 1% stop.
  const econ = roundTripEconomics(1.5, 1.0, {
    fees: cfg.exchange.fees,
    spreadBps: cfg.backtest.spreadBps,
    takerSlippageBps: cfg.backtest.takerSlippageBps,
  });
  console.log('You are about to authorize LIVE trading with REAL MONEY.\n');
  console.log(`Exchange: ${cfg.exchange.id}  Symbol: ${cfg.exchange.symbol}  Strategy: ${strategy.name}  Window: ${hours}h`);
  console.log(`Hard limits: max order $${HARD_LIMITS.maxOrderValueUsd}, max daily loss $${HARD_LIMITS.maxDailyLossUsd}, ` +
    `${HARD_LIMITS.maxConsecutiveLosses} losses -> shutdown, ${HARD_LIMITS.maxTradesPerDay} trades/day, ${HARD_LIMITS.cooldownMs / 60000} min cooldown`);
  console.log(`Fees: maker ${(cfg.exchange.fees.maker * 100).toFixed(2)}% taker ${(cfg.exchange.fees.taker * 100).toFixed(2)}%`);
  console.log(`Reference trade (1.5% target / 1% stop) after costs: win ${econ.winNetPct.toFixed(3)}%, loss ${econ.lossNetPct.toFixed(3)}%, breakeven win rate ${(econ.breakevenWinRate * 100).toFixed(1)}%`);
  console.log('Backtest and paper results do not guarantee live profitability. You can lose the funds in the account.\n');
  const ok = await requireTypedConfirmation('Confirm authorization.', authorizationPhrase(cfg.exchange.id));
  if (!ok) {
    console.error('Phrase did not match. Not authorized.');
    process.exit(1);
  }
  const a = writeAuthorization(stateDir, cfg.exchange.id, values.operator, hours);
  console.log(`Authorized until ${a.expiresAt}. Any change to risk/engine code or configs invalidates it.`);
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
