import type { PaperConfig } from '../config';
import type { EvidenceClass } from '../domain';
import { networkLog } from '../market/netguard';
import type { TradingStore } from '../store';
import { blockBootstrapLowerBound, controls, sensitivity, sessionMetrics, valuations, type Controls, type SessionMetrics } from './metrics';

export interface Gate {
  gate: string;
  passed: boolean;
  evidence: string;
}

export interface Readiness {
  policyVersion: string;
  operationalCorrectness: 'pass' | 'fail';
  strategyEvidence: EvidenceClass;
  gates: Gate[];
  findings: string[];
  metrics: SessionMetrics;
  controls: Controls;
  uncertainty: ReturnType<typeof blockBootstrapLowerBound> & { metric: string; blockDays: number; samples: number; confidence: number };
  sensitivity: ReturnType<typeof sensitivity>;
  deflatedSharpe: string;
  disclaimer: string;
}

export interface ExternalEvidence {
  /** Result of the acceptance suite run against this code (attach from CI/`npm run test:acceptance`). */
  acceptance?: { passed: boolean; detail: string };
  /** Replay comparison: canonical journal hashes of the original and the replay. */
  replay?: { matched: boolean; detail: string };
}

/**
 * Versioned qualification policy (plan section 8). Produces findings with
 * linked evidence and two separate verdicts. Never changes broker mode or
 * grants access to funds; there is no automatic promotion.
 */
export function evaluateReadiness(store: TradingStore, sessionId: string, cfg: PaperConfig, ext: ExternalEvidence = {}): Readiness {
  const m = sessionMetrics(store, sessionId, cfg);
  const c = controls(store, sessionId, cfg);
  const r = cfg.readiness;
  const gates: Gate[] = [];
  const findings: string[] = [];
  const add = (gate: string, passed: boolean, evidence: string) => gates.push({ gate, passed, evidence });

  // ---- operational correctness (hard) ----
  const unauthorized = networkLog.filter((n) => !n.allowed || n.authenticated);
  const ordersWithoutRisk = store.all(
    `SELECT o.order_id FROM orders o WHERE o.session_id = ? AND o.purpose = 'strategy'
       AND NOT EXISTS (SELECT 1 FROM risk_events r WHERE r.session_id = o.session_id AND r.decision_id = o.decision_id AND r.check_name = 'funds' AND r.passed = 1)`,
    sessionId,
  );
  add(
    'ledger reconciliation',
    m.reconciliation.length === 0,
    m.reconciliation.length
      ? m.reconciliation.join('; ')
      : 'projection equals ledger; no negative balances; reservations match open orders',
  );
  add(
    'no risk bypass',
    ordersWithoutRisk.length === 0,
    ordersWithoutRisk.length
      ? `${ordersWithoutRisk.length} orders without passing risk checks`
      : 'every strategy order has a passing risk evaluation',
  );
  add(
    'no unauthorized endpoint (this process)',
    unauthorized.length === 0,
    unauthorized.length
      ? `${unauthorized.length} blocked/unauthenticated attempts`
      : `${networkLog.length} requests, all public allowlisted GET/WS`,
  );
  if (ext.acceptance) add('acceptance suite', ext.acceptance.passed, ext.acceptance.detail);
  else findings.push('Acceptance suite result not attached to this report (run `npm run test:acceptance`).');
  if (ext.replay) add('replay reproduces recorded outcomes', ext.replay.matched, ext.replay.detail);
  else findings.push('No replay comparison attached; provenance gate cannot pass without one.');
  const operational = gates.every((g) => g.passed) && !!ext.acceptance?.passed && !!ext.replay?.matched;

  // ---- strategy evidence ----
  const days = m.observedMs / 86_400_000;
  add('observation floor: days', days >= r.minDays, `${days.toFixed(3)} days observed (need ${r.minDays})`);
  add(
    'observation floor: round trips',
    m.roundTrips.count >= r.minRoundTrips,
    `${m.roundTrips.count} completed round trips (need ${r.minRoundTrips})`,
  );
  add(
    'continuity: coverage',
    m.feed.coveragePct >= r.minCoveragePct,
    `${m.feed.coveragePct.toFixed(2)}% coverage (need ${r.minCoveragePct}%), ${m.feed.gaps} gaps`,
  );
  add(
    'continuity: longest segment',
    m.feed.longestContinuousMs / 3_600_000 >= r.minContinuousHours,
    `${(m.feed.longestContinuousMs / 3_600_000).toFixed(2)}h (need ${r.minContinuousHours}h)`,
  );
  add(
    'net trading PnL positive',
    (m.netTradingPnl ?? -1) > 0,
    `net trading PnL ${m.netTradingPnl?.toFixed(4) ?? 'unknown (stale valuation)'}`,
  );
  add(
    'all-in operating PnL positive (complete costs)',
    m.operatingCosts.complete && (m.allInOperatingPnl ?? -1) > 0,
    m.operatingCosts.complete
      ? `all-in ${m.allInOperatingPnl?.toFixed(4)}`
      : `${m.operatingCosts.unknownCalls} model calls with unknown cost: all-in PnL cannot be claimed`,
  );

  // Excess daily returns versus the matched-exposure control (approximation: control daily = weight * BTC daily).
  const vals = valuations(store, sessionId).filter((v) => v.markMid !== null);
  const byDayMark = new Map<string, number>();
  for (const v of vals) byDayMark.set(new Date(v.time).toISOString().slice(0, 10), v.markMid!);
  const marks = [...byDayMark.values()];
  const w = Number(cfg.risk.maxExposure);
  const excess = m.dailyReturns.slice(1).map((d, i) => d.ret - w * (marks[i + 1]! / marks[i]! - 1));
  const unc = blockBootstrapLowerBound(excess, r.bootstrapBlockDays, r.bootstrapSamples, r.confidence);
  add(
    'uncertainty: lower bound of excess return > 0',
    unc.lowerBound !== null && unc.lowerBound > 0,
    unc.lowerBound === null
      ? `not computed: ${unc.reason}`
      : `one-sided ${r.confidence * 100}% lower bound ${unc.lowerBound.toExponential(3)} per day`,
  );
  const lastMark = vals.at(-1)?.markBid ?? null;
  const sens = sensitivity(store, sessionId, cfg, lastMark);
  add(
    'robustness: positive under 1.5x fees and 20bps slippage',
    (sens.fees1_5x ?? -1) > 0 && (sens.slippage20bps ?? -1) > 0,
    `1.5x fees ${sens.fees1_5x?.toFixed(4)}, +20bps ${sens.slippage20bps?.toFixed(4)}`,
  );
  add(
    'robustness: within drawdown budget',
    m.maxDrawdown < Number(cfg.risk.drawdownPausePct),
    `max drawdown ${(m.maxDrawdown * 100).toFixed(3)}% (budget ${Number(cfg.risk.drawdownPausePct) * 100}%)`,
  );

  const strategyGates = gates.filter((g) => /^(observation|continuity|net trading|all-in|uncertainty|robustness)/.test(g.gate));
  let evidence: EvidenceClass;
  if (!operational) evidence = 'not_ready';
  else if (strategyGates.every((g) => g.passed)) evidence = 'eligible_for_human_review';
  else evidence = 'insufficient_evidence';

  if (days < r.minDays)
    findings.push(
      `Short run (${days.toFixed(3)} of ${r.minDays} days): results are an operational check, not strategy evidence. Keep observing.`,
    );
  if (m.counts.partialFills) findings.push(`${m.counts.partialFills} orders partially filled (IOC remainder cancelled).`);
  if (m.feed.gaps)
    findings.push(`${m.feed.gaps} observation gaps totalling ${(m.feed.gapMs / 1000).toFixed(1)}s; no fills are simulated inside gaps.`);
  if (m.models.length > 1) findings.push(`Multiple models responded (${m.models.join(', ')}): results mix strategy versions.`);
  findings.push('Counterfactual market impact of our orders and exact queue position are not modelled.');
  findings.push(
    'Fee assumptions: ' +
      `${cfg.fees.version} taker ${cfg.fees.takerRate} (${cfg.fees.verified ? 'verified' : 'UNVERIFIED'}; ${cfg.fees.source}).`,
  );

  return {
    policyVersion: r.version,
    operationalCorrectness: operational ? 'pass' : 'fail',
    strategyEvidence: evidence,
    gates,
    findings,
    metrics: m,
    controls: c,
    uncertainty: {
      ...unc,
      metric: 'mean daily excess return vs matched-exposure control',
      blockDays: r.bootstrapBlockDays,
      samples: r.bootstrapSamples,
      confidence: r.confidence,
    },
    sensitivity: sens,
    deflatedSharpe: 'not computed: requires a registered set of comparable forward trials with sufficient daily observations',
    disclaimer:
      'PAPER — SIMULATED FUNDS. A profitable simulation does not establish future profitability. This report never enables live trading.',
  };
}
