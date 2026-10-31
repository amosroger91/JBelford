import { describe, expect, it } from 'vitest';
import { PaperAdapter } from '../src/exec/paperAdapter';
import { AmbiguousOrderError, OrderRejectedError } from '../src/exec/adapter';
import { FEES, MARKET, memStore, T0 } from './helpers';

function make(store = memStore(), extra: Partial<ConstructorParameters<typeof PaperAdapter>[1]> = {}) {
  let now = T0;
  const p = new PaperAdapter(store, { startingUsd: 50, fees: FEES, takerSlippageBps: 5, market: MARKET, now: () => now, ...extra });
  return { p, store, setNow: (t: number) => (now = t) };
}

describe('PaperAdapter', () => {
  it('rejects post-only orders that would take liquidity', async () => {
    const { p } = make();
    p.onBook({ bid: 77000, ask: 77000.1, ts: T0 });
    await expect(
      p.createLimitOrder({ clientOrderId: 'a', side: 'buy', amount: 0.0001, price: 77000.1, postOnly: true }),
    ).rejects.toBeInstanceOf(OrderRejectedError);
  });

  it('does not fill a resting bid when price only touches it', async () => {
    const { p } = make();
    p.onBook({ bid: 77000, ask: 77000.1, ts: T0 });
    await p.createLimitOrder({ clientOrderId: 'a', side: 'buy', amount: 0.0001, price: 77000, postOnly: true });
    p.onBook({ bid: 76999.9, ask: 77000, ts: T0 + 1000 }); // ask touches 77000
    p.onPrint(77000, T0 + 1000);
    expect((await p.fetchOrderByClientId('a'))!.filled).toBe(0);
  });

  it('fills a resting bid only when price trades through it, charging maker fee', async () => {
    const { p } = make();
    p.onBook({ bid: 77000, ask: 77000.1, ts: T0 });
    await p.createLimitOrder({ clientOrderId: 'a', side: 'buy', amount: 0.0001, price: 77000, postOnly: true });
    p.onPrint(76999.9, T0 + 1000);
    const o = (await p.fetchOrderByClientId('a'))!;
    expect(o.status).toBe('closed');
    expect(o.avgPrice).toBe(77000);
    expect(o.fee).toBeCloseTo(0.0001 * 77000 * 0.004, 10);
    const b = await p.fetchBalance();
    expect(b.btc).toBeCloseTo(0.0001, 12);
    expect(b.usd).toBeCloseTo(50 - 7.7 - 0.0308, 8);
  });

  it('ignores prints that happened before the order existed', async () => {
    const { p } = make();
    p.onBook({ bid: 77000, ask: 77000.1, ts: T0 });
    await p.createLimitOrder({ clientOrderId: 'a', side: 'buy', amount: 0.0001, price: 77000, postOnly: true });
    p.onPrint(70000, T0 - 60_000);
    expect((await p.fetchOrderByClientId('a'))!.filled).toBe(0);
  });

  it('market sells pay taker fee and slippage', async () => {
    const { p } = make();
    p.onBook({ bid: 77000, ask: 77000.1, ts: T0 });
    await p.createLimitOrder({ clientOrderId: 'a', side: 'buy', amount: 0.0001, price: 77000, postOnly: true });
    p.onPrint(76990, T0 + 1);
    const o = await p.createMarketOrder({ clientOrderId: 'b', side: 'sell', amount: 0.0001 });
    expect(o.avgPrice).toBeCloseTo(77000 * (1 - 0.0005), 6);
    expect(o.fee).toBeCloseTo(0.0001 * o.avgPrice! * 0.008, 10);
  });

  it('rejects duplicate client order ids, insufficient funds and sub-minimum sizes', async () => {
    const { p } = make();
    p.onBook({ bid: 77000, ask: 77000.1, ts: T0 });
    await p.createLimitOrder({ clientOrderId: 'a', side: 'buy', amount: 0.0001, price: 77000, postOnly: true });
    await expect(p.createLimitOrder({ clientOrderId: 'a', side: 'buy', amount: 0.0001, price: 77000, postOnly: true })).rejects.toThrow(
      /duplicate/,
    );
    await expect(p.createLimitOrder({ clientOrderId: 'b', side: 'buy', amount: 0.01, price: 77000, postOnly: true })).rejects.toThrow(
      /insufficient/,
    );
    await expect(p.createLimitOrder({ clientOrderId: 'c', side: 'buy', amount: 0.00001, price: 77000, postOnly: true })).rejects.toThrow(
      /minimum/,
    );
    await expect(p.createMarketOrder({ clientOrderId: 'd', side: 'sell', amount: 0.0001 })).rejects.toThrow(/insufficient BTC/);
  });

  it('persists balances and orders across restarts', async () => {
    const store = memStore();
    const a = make(store).p;
    a.onBook({ bid: 77000, ask: 77000.1, ts: T0 });
    await a.createLimitOrder({ clientOrderId: 'x', side: 'buy', amount: 0.0001, price: 77000, postOnly: true });
    const b = make(store).p;
    expect((await b.fetchOpenOrders()).map((o) => o.clientOrderId)).toEqual(['x']);
    b.onPrint(76000, T0 + 5);
    expect((await b.fetchBalance()).btc).toBeCloseTo(0.0001, 12);
  });

  it('can simulate ambiguous responses where the order WAS created', async () => {
    const { p } = make(memStore(), { faults: { ambiguousCreateRate: 1, rejectRate: 0 }, seed: 1 });
    p.onBook({ bid: 77000, ask: 77000.1, ts: T0 });
    let created = 0;
    for (let i = 0; i < 10; i++) {
      await expect(
        p.createLimitOrder({ clientOrderId: `id${i}`, side: 'buy', amount: 0.00006, price: 70000, postOnly: true }),
      ).rejects.toBeInstanceOf(AmbiguousOrderError);
      if (await p.fetchOrderByClientId(`id${i}`)) created++;
    }
    expect(created).toBeGreaterThan(0);
    expect(created).toBeLessThan(10);
  });
});
