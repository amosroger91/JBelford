import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import ccxt, { type Exchange } from 'ccxt';
import { appContext, pct } from './common';
import { HARD_LIMITS } from '../risk/limits';
import { roundTripEconomics } from '../economics/costs';

/**
 * Validates exchange compatibility using PUBLIC endpoints only:
 * market existence, spot type, minimums vs the $10 cap, precision, WebSocket
 * and post-only/client-id capability, live spread, and fee economics.
 *   npm run validate:exchange
 *   npm run validate:exchange -- --exchanges kraken,coinbase,bitstamp,gemini
 */
const { values } = parseArgs({ options: { exchanges: { type: 'string' } } });

async function main() {
  const { cfg, reportsDir } = appContext();
  const params = { takeProfitPct: 1.5, stopLossPct: 1.0 }; // reference intraday trade
  const ids = (values.exchanges ?? cfg.exchange.id).split(',').map((s) => s.trim());
  const results: Record<string, unknown>[] = [];

  for (const id of ids) {
    const Ctor = (ccxt as unknown as Record<string, new (c: object) => Exchange>)[id];
    const ProCtor = (ccxt.pro as unknown as Record<string, new (c: object) => Exchange>)[id];
    if (!Ctor) {
      results.push({ exchange: id, ok: false, error: 'not supported by ccxt' });
      continue;
    }
    const ex = new Ctor({ enableRateLimit: true });
    const r: Record<string, unknown> = { exchange: id, ccxtVersion: ccxt.version };
    const problems: string[] = [];
    try {
      await ex.loadMarkets();
      const m = ex.market(cfg.exchange.symbol);
      const book = await ex.fetchOrderBook(cfg.exchange.symbol, 10);
      const bid = book.bids[0]?.[0] ?? NaN;
      const ask = book.asks[0]?.[0] ?? NaN;
      const mid = (bid + ask) / 2;
      const minAmount = m.limits.amount?.min ?? 0;
      const minCost = m.limits.cost?.min ?? 0;
      const minOrderUsd = Math.max(minCost, minAmount * mid);
      const ws = ProCtor ? new ProCtor({}) : null;
      r.spot = m.spot;
      r.bid = bid;
      r.ask = ask;
      r.spreadBps = ((ask - bid) / mid) * 10_000;
      r.minAmountBtc = minAmount;
      r.minCostUsd = minCost;
      r.effectiveMinOrderUsd = minOrderUsd;
      r.amountStep = m.precision.amount;
      r.priceTick = m.precision.price;
      r.ccxtStaticFees = { maker: m.maker, taker: m.taker };
      r.websocket = { orderBook: !!ws?.has.watchOrderBook, trades: !!ws?.has.watchTrades, ohlcv: !!ws?.has.watchOHLCV };
      r.capabilities = {
        fetchOHLCV: ex.has.fetchOHLCV,
        createPostOnlyOrder: ex.has.createPostOnlyOrder ?? 'see exchange docs',
        fetchOpenOrders: ex.has.fetchOpenOrders,
        fetchClosedOrders: ex.has.fetchClosedOrders,
      };
      if (!m.spot) problems.push('not a spot market');
      if (minOrderUsd > HARD_LIMITS.maxOrderValueUsd * 0.98)
        problems.push(`exchange minimum ~$${minOrderUsd.toFixed(2)} is at/above the $${HARD_LIMITS.maxOrderValueUsd} cap`);
      if (!ws?.has.watchOrderBook) problems.push('no WebSocket order book (polling fallback only)');
      if (id === cfg.exchange.id && (m.maker !== cfg.exchange.fees.maker || m.taker !== cfg.exchange.fees.taker)) {
        r.feeNote = `ccxt's built-in fee table (${m.maker}/${m.taker}) differs from the configured, verified schedule (${cfg.exchange.fees.maker}/${cfg.exchange.fees.taker}). The configured values are used. Re-verify on the exchange's fee page before going live; with credentials, fetchTradingFee shows your actual tier.`;
      }
    } catch (e) {
      problems.push(String(e));
    }
    r.problems = problems;
    r.ok = problems.length === 0;
    results.push(r);
  }

  const econ = roundTripEconomics(params.takeProfitPct, params.stopLossPct, {
    fees: cfg.exchange.fees,
    spreadBps: cfg.backtest.spreadBps,
    takerSlippageBps: cfg.backtest.takerSlippageBps,
  });
  const summary = {
    generatedAt: new Date().toISOString(),
    configuredExchange: cfg.exchange.id,
    configuredFees: cfg.exchange.fees,
    strategy: { takeProfitPct: params.takeProfitPct, stopLossPct: params.stopLossPct },
    economicsAfterCosts: econ,
    results,
  };
  console.log(JSON.stringify(summary, null, 2));
  console.log(
    `\nAt configured fees a ${pct(params.takeProfitPct)} target nets ${pct(econ.winNetPct, 3)} and a ${pct(params.stopLossPct)} stop loses ${pct(-econ.lossNetPct, 3)}.` +
      ` Breakeven win rate: ${pct(econ.breakevenWinRate * 100, 1)}.`,
  );
  const path = join(reportsDir, `exchange-validation-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify(summary, null, 2));
  console.log(`Saved ${path}`);
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
