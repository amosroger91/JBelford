import { describe, expect, it } from 'vitest';
import { GuardedAdapter } from '../src/exec/guardedAdapter';
import { PaperAdapter } from '../src/exec/paperAdapter';
import { RiskViolationError } from '../src/exec/adapter';
import { RiskEngine } from '../src/risk/engine';
import { FEES, MARKET, memStore, T0 } from './helpers';

function setup() {
  const store = memStore();
  const risk = new RiskEngine(store);
  const paper = new PaperAdapter(store, { startingUsd: 50, fees: FEES, takerSlippageBps: 5, market: MARKET, now: () => T0 });
  paper.onBook({ bid: 77000, ask: 77000.1, ts: T0 });
  const g = new GuardedAdapter(paper, risk, store, () => 77000, () => T0);
  return { store, risk, paper, g };
}

describe('GuardedAdapter (order-level invariants)', () => {
  it('blocks market buys', async () => {
    const { g } = setup();
    await expect(g.createMarketOrder({ clientOrderId: 'a', side: 'buy', amount: 0.0001 })).rejects.toBeInstanceOf(RiskViolationError);
  });

  it('blocks non-post-only buys', async () => {
    const { g } = setup();
    await expect(g.createLimitOrder({ clientOrderId: 'a', side: 'buy', amount: 0.0001, price: 77000, postOnly: false })).rejects.toThrow(/post-only/);
  });

  it('blocks buys above $10', async () => {
    const { g } = setup();
    await expect(g.createLimitOrder({ clientOrderId: 'a', side: 'buy', amount: 0.00013, price: 77000, postOnly: true })).rejects.toThrow(/exceeds \$10/);
  });

  it('blocks buys while halted', async () => {
    const { g, risk } = setup();
    risk.halt('test', 'manual_reset', T0);
    await expect(g.createLimitOrder({ clientOrderId: 'a', side: 'buy', amount: 0.0001, price: 77000, postOnly: true })).rejects.toThrow(/halted/);
  });

  it('blocks sells without a position (no shorting) and sells larger than the position', async () => {
    const { g, store } = setup();
    await expect(g.createMarketOrder({ clientOrderId: 'a', side: 'sell', amount: 0.0001 })).rejects.toThrow(/no shorting/);
    store.upsertPosition({ tradeId: 't1', symbol: 'BTC/USD', amount: 0.0001, entryPrice: 77000, entryFee: 0.03, openedAt: T0, stopPrice: 76615, takeProfitPrice: 77770 });
    await expect(g.createMarketOrder({ clientOrderId: 'b', side: 'sell', amount: 0.0002 })).rejects.toThrow(/exceeds position/);
    // position exists in the DB but not in the (paper) balance -> balance check blocks it
    await expect(g.createMarketOrder({ clientOrderId: 'c', side: 'sell', amount: 0.0001 })).rejects.toThrow(/BTC balance/);
  });

  it('allows a valid post-only entry', async () => {
    const { g } = setup();
    const o = await g.createLimitOrder({ clientOrderId: 'a', side: 'buy', amount: 0.000127, price: 77000, postOnly: true });
    expect(o.status).toBe('open');
  });
});
