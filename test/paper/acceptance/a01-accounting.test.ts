import { describe, expect, it } from 'vitest';
import { Ledger } from '../../../src/paper/ledger';
import { TradingStore } from '../../../src/paper/store';
import { TradingService } from '../../../src/paper/service';
import { PaperBroker } from '../../../src/paper/execution/paper';
import { OrderBook } from '../../../src/paper/market/book';
import { dec, str } from '../../../src/paper/money';
import { evaluateIntent, type RiskContext } from '../../../src/paper/risk';
import { makeRng } from '../../../src/core/util';
import type { ApprovedOrder } from '../../../src/paper/domain';
import { PRODUCT, T0, testConfig } from '../harness';

/**
 * Accounting acceptance tests. Expected values are calculated by hand in the
 * comments, independently of the implementation.
 */
function setup(usd = '10000') {
  const store = new TradingStore(':memory:');
  const svc = new TradingService(store);
  const cfg = testConfig({ initialBalances: { usd, btc: '0' } });
  const id = svc.createSession(cfg, PRODUCT, { kind: 'forward', now: T0, id: 'acct' });
  return { store, ledger: new Ledger(store), id, cfg };
}

function order(id: string, side: 'buy' | 'sell', qty: string, guard: string, reserved: string, n = 1): ApprovedOrder {
  return {
    orderId: `o-${n}`,
    clientOrderId: `c-${n}`,
    sessionId: id,
    decisionId: `d-${n}`,
    side,
    qty,
    guardPrice: guard,
    reserved,
    submittedAt: T0 + n,
    arrivalAt: T0 + n,
    validUntil: T0 + 60_000,
    policyVersion: 'p',
    snapshotId: 's',
    purpose: 'strategy',
  };
}

const broker = (participation = '1') =>
  new PaperBroker({
    takerRate: dec('0.009'),
    participation: dec(participation),
    guardBps: 50,
    baseIncrement: dec('0.00000001'),
    baseMinSize: dec('0.00000001'),
  });

function book(bids: [string, string][], asks: [string, string][]) {
  const b = new OrderBook();
  b.loadSnapshot(
    bids.map(([price, qty]) => ({ price, qty })),
    asks.map(([price, qty]) => ({ price, qty })),
  );
  return b;
}

describe('1-2. round trips: spread + fees, never double-counted', () => {
  it('buy then sell at unchanged bid/ask loses exactly the spread plus both fees', () => {
    const { ledger, id } = setup();
    const b = book([['79999.00', '1']], [['80000.00', '1']]);
    const br = broker();
    // Buy 0.005 BTC at the ask 80000.00: notional 400.00, fee 0.9% = 3.60. Reserve 400*1.0050*1.009 rounded up.
    ledger.submit(order(id, 'buy', '0.005', '80400', '405.618', 1), 1);
    const buy = br.execute(b, {
      orderId: 'o-1',
      sessionId: id,
      side: 'buy',
      qty: dec('0.005'),
      guardPrice: dec('80400'),
      priorFills: 0,
      time: T0 + 10,
      ordinal: 2,
    });
    expect(buy.fills).toHaveLength(1);
    expect(buy.fills[0]).toMatchObject({ price: '80000', qty: '0.005', fee: '3.6' });
    for (const f of buy.fills) ledger.applyFill(f);
    // Sell 0.005 at the bid 79999.00: notional 399.995, fee 3.599955.
    ledger.submit(order(id, 'sell', '0.005', '79599', '0.005', 2), 3);
    const br2 = broker();
    const sell = br2.execute(b, {
      orderId: 'o-2',
      sessionId: id,
      side: 'sell',
      qty: dec('0.005'),
      guardPrice: dec('79599'),
      priorFills: 0,
      time: T0 + 20,
      ordinal: 4,
    });
    expect(sell.fills[0]).toMatchObject({ price: '79999', qty: '0.005', fee: '3.599955' });
    for (const f of sell.fills) ledger.applyFill(f);
    const bal = ledger.balances(id);
    // 10000 - 400 - 3.6 + 399.995 - 3.599955 = 9992.795045 ; loss = 0.005 spread + 7.199955 fees
    expect(str(bal.usdAvailable)).toBe('9992.795045');
    expect(str(bal.usdReserved)).toBe('0');
    expect(str(bal.btcAvailable)).toBe('0');
    expect(str(bal.feesPaid)).toBe('7.199955');
    expect(str(bal.realizedPnl)).toBe('-7.204955');
    expect(ledger.verify(id)).toEqual([]);
  });

  it('a small price rise still loses after costs, and the loss is reported', () => {
    const { ledger, id } = setup();
    ledger.submit(order(id, 'buy', '0.005', '80400', '405.618', 1), 1);
    for (const f of broker().execute(book([['79999', '1']], [['80000', '1']]), {
      orderId: 'o-1',
      sessionId: id,
      side: 'buy',
      qty: dec('0.005'),
      guardPrice: dec('80400'),
      priorFills: 0,
      time: T0,
      ordinal: 2,
    }).fills)
      ledger.applyFill(f);
    // Market rises 0.125%: bid 80100. Proceeds 400.50, fee 3.6045 -> net 396.8955 vs cost 403.60.
    ledger.submit(order(id, 'sell', '0.005', '79700', '0.005', 2), 3);
    for (const f of broker().execute(book([['80100', '1']], [['80100.01', '1']]), {
      orderId: 'o-2',
      sessionId: id,
      side: 'sell',
      qty: dec('0.005'),
      guardPrice: dec('79700'),
      priorFills: 0,
      time: T0 + 1,
      ordinal: 4,
    }).fills)
      ledger.applyFill(f);
    const bal = ledger.balances(id);
    expect(str(bal.realizedPnl)).toBe('-6.7045'); // 396.8955 - 403.6
    expect(str(bal.usdAvailable)).toBe('9993.2955');
  });
});

describe('4. partial fills', () => {
  it('consume displayed depth, cancel the IOC remainder and release only the unused reservation', () => {
    const { ledger, id } = setup();
    // asks: 0.002 @ 80000.00, 0.001 @ 80010.00; buy 0.005 -> fills 0.003, remainder 0.002 cancelled.
    const b = book(
      [['79999', '1']],
      [
        ['80000.00', '0.002'],
        ['80010.00', '0.001'],
      ],
    );
    ledger.submit(order(id, 'buy', '0.005', '80400', '405.618', 1), 1);
    const r = broker().execute(b, {
      orderId: 'o-1',
      sessionId: id,
      side: 'buy',
      qty: dec('0.005'),
      guardPrice: dec('80400'),
      priorFills: 0,
      time: T0,
      ordinal: 2,
    });
    expect(r.fills.map((f) => [f.price, f.qty, f.fee])).toEqual([
      ['80000', '0.002', '1.44'], // 160.00 * 0.009
      ['80010', '0.001', '0.72009'], // 80.01 * 0.009
    ]);
    expect(str(r.remainder!.qty)).toBe('0.002');
    for (const f of r.fills) ledger.applyFill(f);
    expect(ledger.order(id, 'o-1')!.status).toBe('partially_filled');
    ledger.close(id, 'o-1', 'cancelled', T0 + 1, 3, r.remainder!.reason);
    const bal = ledger.balances(id);
    // spent 160 + 1.44 + 80.01 + 0.72009 = 242.17009
    expect(str(bal.usdAvailable)).toBe('9757.82991');
    expect(str(bal.usdReserved)).toBe('0');
    expect(str(bal.btcAvailable)).toBe('0.003');
    expect(ledger.order(id, 'o-1')).toMatchObject({ status: 'cancelled', filledQty: dec('0.003') });
    expect(ledger.verify(id)).toEqual([]);
  });

  it('participation cap leaves liquidity for others and consumed depth is not reused until the level changes', () => {
    const b = book([['79999', '1']], [['80000', '0.01']]);
    const br = broker('0.5');
    const a = br.execute(b, {
      orderId: 'x',
      sessionId: 's',
      side: 'buy',
      qty: dec('0.01'),
      guardPrice: dec('80400'),
      priorFills: 0,
      time: T0,
      ordinal: 1,
    });
    expect(a.fills.map((f) => f.qty)).toEqual(['0.005']); // 50% of 0.01
    const again = br.execute(b, {
      orderId: 'y',
      sessionId: 's',
      side: 'buy',
      qty: dec('0.01'),
      guardPrice: dec('80400'),
      priorFills: 0,
      time: T0,
      ordinal: 2,
    });
    expect(again.rejected).toMatch(/insufficient depth/); // same unchanged depth cannot be consumed twice
    br.onLevelChange('ask', '80000'); // venue republished the level: replenishment rule
    expect(
      br.execute(b, {
        orderId: 'z',
        sessionId: 's',
        side: 'buy',
        qty: dec('0.001'),
        guardPrice: dec('80400'),
        priorFills: 0,
        time: T0,
        ordinal: 3,
      }).fills,
    ).toHaveLength(1);
  });
});

describe('5. reservations prevent double spending', () => {
  it('two orders cannot spend the same USD', () => {
    const { ledger, id } = setup('1000');
    ledger.submit(order(id, 'buy', '0.01', '80400', '600', 1), 1);
    expect(() => ledger.submit(order(id, 'buy', '0.01', '80400', '600', 2), 2)).toThrow(/insufficient available USD/);
    expect(str(ledger.balances(id).usdReserved)).toBe('600');
  });
  it('two orders cannot sell the same BTC', () => {
    const store = new TradingStore(':memory:');
    const svc = new TradingService(store);
    const id = svc.createSession(testConfig({ initialBalances: { usd: '0', btc: '0.01' } }), PRODUCT, {
      kind: 'forward',
      now: T0,
      id: 'b',
    });
    const ledger = new Ledger(store);
    ledger.submit(order(id, 'sell', '0.008', '79000', '0.008', 1), 1);
    expect(() => ledger.submit(order(id, 'sell', '0.008', '79000', '0.008', 2), 2)).toThrow(/insufficient available BTC/);
  });
});

describe('6. idempotency and crash safety', () => {
  it('duplicate fills settle once; duplicate client order ids are rejected', () => {
    const { ledger, id } = setup();
    ledger.submit(order(id, 'buy', '0.005', '80400', '405.618', 1), 1);
    const f = {
      fillId: 'o-1:f1',
      orderId: 'o-1',
      sessionId: id,
      side: 'buy' as const,
      price: '80000',
      qty: '0.005',
      fee: '3.6',
      liquidity: 'taker' as const,
      eventOrdinal: 2,
      time: T0,
    };
    expect(ledger.applyFill(f)).toBe(true);
    const before = ledger.balances(id);
    expect(ledger.applyFill(f)).toBe(false);
    expect(ledger.applyFill({ ...f })).toBe(false);
    expect(ledger.balances(id)).toEqual(before);
    expect(() => ledger.submit({ ...order(id, 'buy', '0.001', '80400', '81', 9), clientOrderId: 'c-1' }, 3)).toThrow(
      /duplicate client order id/,
    );
  });

  it.each(['submit:after-insert', 'fill:after-insert', 'fill:after-post', 'fill:before-commit'])(
    'a crash at %s leaves invariants intact and a retry settles once',
    (point) => {
      const { store, ledger, id } = setup();
      const f = {
        fillId: 'o-1:f1',
        orderId: 'o-1',
        sessionId: id,
        side: 'buy' as const,
        price: '80000',
        qty: '0.005',
        fee: '3.6',
        liquidity: 'taker' as const,
        eventOrdinal: 2,
        time: T0,
      };
      store.faultHook = (p) => {
        if (p === point) throw new Error(`simulated crash at ${p}`);
      };
      if (point.startsWith('submit')) {
        expect(() => ledger.submit(order(id, 'buy', '0.005', '80400', '405.618', 1), 1)).toThrow(/simulated crash/);
        expect(ledger.order(id, 'o-1')).toBeUndefined();
        expect(ledger.verify(id)).toEqual([]);
        store.faultHook = null;
        ledger.submit(order(id, 'buy', '0.005', '80400', '405.618', 1), 1);
      } else {
        store.faultHook = null;
        ledger.submit(order(id, 'buy', '0.005', '80400', '405.618', 1), 1);
        store.faultHook = (p) => {
          if (p === point) throw new Error(`simulated crash at ${p}`);
        };
        expect(() => ledger.applyFill(f)).toThrow(/simulated crash/);
        expect(store.get('SELECT COUNT(*) AS n FROM fills')!.n).toBe(0);
        expect(ledger.verify(id)).toEqual([]);
        store.faultHook = null;
        expect(ledger.applyFill(f)).toBe(true);
        expect(ledger.applyFill(f)).toBe(false);
      }
      expect(ledger.verify(id)).toEqual([]);
    },
  );
});

describe('7. increments, minimums, fee rounding, fee reserves, extreme prices', () => {
  const ctx = (over: Partial<RiskContext> = {}): RiskContext => ({
    sessionId: 's',
    now: T0,
    decisionCompletedAt: T0,
    generation: 1,
    currentGeneration: 1,
    expectedSnapshotId: 'snap',
    feed: 'healthy',
    bookSynced: true,
    bestBid: dec('79999.99'),
    bestAsk: dec('80000.00'),
    touchDepthUsd: { bid: dec('1000'), ask: dec('1000') },
    usdAvailable: dec('10000'),
    btcAvailable: dec('0'),
    btcHeld: dec('0'),
    pendingBuyQty: dec('0'),
    pendingSellQty: dec('0'),
    equity: dec('10000'),
    dayStartEquity: dec('10000'),
    hwmEquity: dec('10000'),
    openOrders: 0,
    ordersLastHour: 0,
    knownOperatingCostUsd: dec('0'),
    operatingCostUnknown: false,
    usesPaidModel: false,
    paused: false,
    ...over,
  });
  const intent = (w: string) => ({
    decisionId: 'd',
    snapshotId: 'snap',
    action: 'target' as const,
    targetWeight: w,
    validUntil: T0 + 60_000,
    rationale: 't',
  });
  const cfg = testConfig();

  it('sizes to the 5% order cap and quantizes the quantity DOWN to the base increment', () => {
    const r = evaluateIntent(intent('0.2'), ctx(), cfg, PRODUCT);
    // 5% of 10000 = 500 USD / ask 80000 = 0.00625 BTC exactly
    expect(r.order).toMatchObject({ side: 'buy', qty: '0.00625', guardPrice: '80400' });
    // reserve = 0.00625 * 80400 * 1.009 = 507.0225 (rounded up to 1e-8)
    expect(r.order!.reserved).toBe('507.0225');
  });

  it('refuses changes below the rebalance threshold and below product minimum notional', () => {
    expect(evaluateIntent(intent('0.004'), ctx(), cfg, PRODUCT).noOrderReason).toMatch(/rebalance threshold/);
    const tiny = testConfig({ risk: { minRebalancePctEquity: '0' } });
    expect(evaluateIntent(intent('0.00005'), ctx(), tiny, PRODUCT).noOrderReason).toMatch(/product minimum/); // $0.50 < $1 minimum
  });

  it('shrinks a buy so the reservation covers the fee when cash is tight', () => {
    const r = evaluateIntent(intent('0.2'), ctx({ usdAvailable: dec('100'), equity: dec('10000') }), cfg, PRODUCT);
    // affordable = 100 / (80400 * 1.009) = 100 / 81123.6 = 0.001232684... -> 0.00123268 (floor at 1e-8)
    expect(r.order!.qty).toBe('0.00123268');
    expect(Number(r.order!.reserved)).toBeLessThanOrEqual(100);
  });

  it('rounds fees UP to 0.00000001 USD and handles extreme prices exactly', () => {
    const br = broker();
    const b = book([['9999999.99', '1']], [['10000000.00', '1']]);
    const r = br.execute(b, {
      orderId: 'x',
      sessionId: 's',
      side: 'buy',
      qty: dec('0.00000001'),
      guardPrice: dec('20000000'),
      priorFills: 0,
      time: T0,
      ordinal: 1,
    });
    // notional 0.1 USD, fee 0.0009 exactly
    expect(r.fills[0]).toMatchObject({ price: '10000000', qty: '0.00000001', fee: '0.0009' });
    const b2 = book([['0.99', '1']], [['1.00', '10']]);
    const r2 = br.execute(b2, {
      orderId: 'y',
      sessionId: 's',
      side: 'buy',
      qty: dec('0.00000001'),
      guardPrice: dec('2'),
      priorFills: 0,
      time: T0,
      ordinal: 2,
    });
    // notional 0.00000001 USD, fee 9e-11 -> rounded UP to 0.00000001
    expect(r2.fills[0]!.fee).toBe('0.00000001');
  });
});

describe('property: accounting conservation under random trading', () => {
  it('cash and inventory are conserved and the ledger always reconciles', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rng = makeRng(seed);
      const { ledger, id, store } = setup();
      let n = 0;
      for (let step = 0; step < 30; step++) {
        const bal = ledger.balances(id);
        const price = (70000 + Math.floor(rng() * 20000)).toFixed(2);
        const side: 'buy' | 'sell' = bal.btcAvailable > 0n && rng() < 0.5 ? 'sell' : 'buy';
        n++;
        const qty = side === 'buy' ? (0.0001 + rng() * 0.002).toFixed(8) : str(bal.btcAvailable);
        const guard = side === 'buy' ? (Number(price) * 1.005).toFixed(2) : (Number(price) * 0.995).toFixed(2);
        const reserve = side === 'buy' ? (Number(qty) * Number(guard) * 1.0091).toFixed(8) : qty;
        if (side === 'buy' && dec(reserve) > bal.usdAvailable) continue;
        ledger.submit(order(id, side, qty, guard, reserve, n), n * 10);
        const b = book([[price, '0.002']], [[price, '0.002']]);
        const r = broker((0.3 + rng() * 0.7).toFixed(4)).execute(b, {
          orderId: `o-${n}`,
          sessionId: id,
          side,
          qty: dec(qty),
          guardPrice: dec(guard),
          priorFills: 0,
          time: T0 + n,
          ordinal: n * 10 + 1,
        });
        for (const f of r.fills) {
          ledger.applyFill(f);
          if (rng() < 0.3) expect(ledger.applyFill(f)).toBe(false); // random redelivery
        }
        if (!['filled'].includes(ledger.order(id, `o-${n}`)!.status))
          ledger.close(id, `o-${n}`, r.rejected ? 'rejected' : 'cancelled', T0 + n, n * 10 + 2, 'test');
        expect(ledger.verify(id)).toEqual([]);
      }
      // Independent recomputation from the fill tape.
      let usd = dec('10000');
      let btc = 0n;
      for (const f of store.all('SELECT side, price, qty, fee FROM fills')) {
        const notional = (dec(f.price as string) * dec(f.qty as string)) / 10n ** 12n; // prices x qty are exact at <=12 dp here
        if (f.side === 'buy') {
          usd -= notional + dec(f.fee as string);
          btc += dec(f.qty as string);
        } else {
          usd += notional - dec(f.fee as string);
          btc -= dec(f.qty as string);
        }
      }
      const bal = ledger.balances(id);
      expect(bal.usdAvailable + bal.usdReserved).toBe(usd);
      expect(bal.btcAvailable + bal.btcReserved).toBe(btc);
    }
  });
});
