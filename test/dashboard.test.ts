import { describe, expect, it } from 'vitest';
import { buildSnapshot, HEARTBEAT_KEY } from '../src/dashboard/snapshot';
import { renderDashboard } from '../src/dashboard/render';
import { RiskEngine } from '../src/risk/engine';
import { memStore, T0, trade } from './helpers';

describe('dashboard', () => {
  it('renders balance, equity, trades, net P&L and fees', () => {
    const store = memStore();
    const risk = new RiskEngine(store);
    store.insertBalance(T0, { usd: 50, btc: 0 }, 77000);
    store.closePositionWithTrade(trade({ netPnl: 0.0193, closedAt: T0 + 60_000 }));
    store.insertBalance(T0 + 120_000, { usd: 50.0193, btc: 0 }, 77100);
    store.setKv(HEARTBEAT_KEY, {
      ts: T0 + 120_000,
      phase: 'FLAT',
      transport: 'websocket',
      dataAgeMs: 400,
      stateCertain: true,
      bid: 77100,
      ask: 77100.1,
      pid: 1,
    });
    const text = renderDashboard(buildSnapshot(store, risk, 'paper', null, 0.008, T0 + 125_000), false);
    expect(text).toContain('PAPER TRADING');
    expect(text).toContain('USD $50.02');
    expect(text).toContain('Equity $50.02');
    expect(text).toContain('Net P&L +$0.0193');
    expect(text).toMatch(/Fees \$0\.0600/);
    expect(text).toContain('take_profit');
    expect(text).toContain('Engine: FLAT');
    expect(text).toContain('trades 1/10');
  });

  it('shows halts and kill switch prominently', () => {
    const store = memStore();
    const risk = new RiskEngine(store);
    risk.halt('3 consecutive losses', 'manual_reset', T0);
    const text = renderDashboard(buildSnapshot(store, risk, 'paper', { at: 'now', reason: 'test' }, 0.008, T0 + 1), false);
    expect(text).toContain('KILL SWITCH ACTIVE');
    expect(text).toContain('HALTED (manual_reset)');
    expect(text).toContain('NOT RUNNING');
  });
});
