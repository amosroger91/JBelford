import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { PaperConfig } from './config';
import { configHash, strategyVersionHash } from './config';
import { journalHash } from './evaluation/canonical';
import type { Readiness } from './evaluation/readiness';
import type { TradingStore } from './store';
import { PROJECT_ROOT } from './service';

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function csv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0]!);
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
}

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

export interface ExportResult {
  dir: string;
  files: { path: string; sha256: string }[];
  journalHash: string;
}

/** Export JSON, CSV, HTML and an evidence manifest for a session. */
export function exportReport(
  store: TradingStore,
  sessionId: string,
  cfg: PaperConfig,
  readiness: Readiness,
  outDir: string,
  extra: { datasetDir?: string | null; reproduction: string[]; replay?: unknown; label?: string },
): ExportResult {
  mkdirSync(outDir, { recursive: true });
  const files: { path: string; sha256: string }[] = [];
  const write = (name: string, content: string) => {
    writeFileSync(join(outDir, name), content);
    files.push({ path: name, sha256: sha(content) });
  };
  const session = store.get('SELECT * FROM sessions WHERE id = ?', sessionId)!;
  const jh = journalHash(store, sessionId);
  const q = (sql: string) => store.all(sql, sessionId);

  write('orders.csv', csv(q('SELECT * FROM orders WHERE session_id = ? ORDER BY submitted_at, order_id')));
  write('fills.csv', csv(q('SELECT * FROM fills WHERE session_id = ? ORDER BY event_ordinal, fill_id')));
  write('valuations.csv', csv(q('SELECT * FROM valuations WHERE session_id = ? ORDER BY id')));
  write('decisions.csv', csv(q('SELECT * FROM decisions WHERE session_id = ? ORDER BY event_ordinal')));
  write('risk_events.csv', csv(q('SELECT * FROM risk_events WHERE session_id = ? ORDER BY id')));
  write('ledger.csv', csv(q('SELECT * FROM ledger_entries WHERE session_id = ? ORDER BY id')));
  write('feed_health.csv', csv(q('SELECT * FROM feed_health WHERE session_id = ? ORDER BY id')));
  write('observation_gaps.csv', csv(q('SELECT * FROM observation_gaps WHERE session_id = ? ORDER BY id')));
  write('audit.csv', csv(q('SELECT * FROM audit WHERE session_id = ? ORDER BY id')));

  const report = {
    label: extra.label ?? 'PAPER — SIMULATED FUNDS',
    session: {
      id: sessionId,
      parentId: session.parent_id,
      status: session.status,
      venue: session.venue,
      product: session.product,
      purpose: session.purpose,
      createdAt: new Date(session.created_at as number).toISOString(),
      startedAt: session.started_at ? new Date(session.started_at as number).toISOString() : null,
      lastEventAt: session.last_event_time ? new Date(session.last_event_time as number).toISOString() : null,
      sourceCommit: session.source_commit,
      dependencies: JSON.parse((session.deps_json as string) ?? '{}'),
    },
    identity: {
      configHash: configHash(cfg),
      strategyVersion: strategyVersionHash(cfg),
      canonicalJournalSha256: jh.hash,
      journalCounts: jh.counts,
    },
    assumptions: {
      fees: cfg.fees,
      execution: cfg.execution,
      risk: cfg.risk,
      fillModel:
        'ioc-depth-walk-v1: market IOC after delay, walks displayed depth with participation cap and execution guard; consumed liquidity tracked per level and cleared when the venue updates that level; no counterfactual market impact or queue position.',
      costBasis: 'weighted average including buy fees',
      valuation:
        'equity marked at mid; liquidation value walks bids minus taker fee; stale data is labelled stale and never marked to a fabricated price',
      dayBoundary: 'UTC',
    },
    readiness,
    replay: extra.replay ?? null,
    reproduction: extra.reproduction,
  };
  write('report.json', JSON.stringify(report, null, 2));
  write('report.html', renderHtml(report, readiness));

  const manifest = {
    format: 'jbelford-paper-evidence-v1',
    sessionId,
    configHash: configHash(cfg),
    strategyVersion: strategyVersionHash(cfg),
    canonicalJournalSha256: jh.hash,
    dataset: extra.datasetDir
      ? {
          dir: relative(PROJECT_ROOT, extra.datasetDir).replace(/\\/g, '/'),
          manifestSha256: sha(readFileSync(join(extra.datasetDir, 'manifest.json'))),
        }
      : null,
    files,
    reproduction: extra.reproduction,
    note: 'Export timestamps and machine paths are excluded from the canonical journal hash.',
  };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  store.run('INSERT INTO reports (session_id, created_at, path, content_hash) VALUES (?, ?, ?, ?)', sessionId, Date.now(), outDir, jh.hash);
  return { dir: outDir, files, journalHash: jh.hash };
}

function fmt(v: unknown, d = 4): string {
  if (typeof v === 'number') return Number.isFinite(v) ? v.toFixed(d) : String(v);
  return escapeHtml(v ?? '—');
}

function renderHtml(
  report: { session: Record<string, unknown>; identity: Record<string, unknown>; reproduction: string[] },
  r: Readiness,
): string {
  const m = r.metrics;
  const gateRows = r.gates
    .map(
      (g) =>
        `<tr><td>${escapeHtml(g.gate)}</td><td class="${g.passed ? 'ok' : 'bad'}">${g.passed ? 'PASS' : 'FAIL'}</td><td>${escapeHtml(g.evidence)}</td></tr>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Paper trading report</title>
<style>
:root{--bg:#fff;--fg:#14171a;--muted:#5b6670;--line:#dde2e6;--ok:#137333;--bad:#b3261e;--warn:#8a5a00;--band:#fff4d6}
@media (prefers-color-scheme:dark){:root{--bg:#121416;--fg:#e8eaed;--muted:#9aa4ad;--line:#2c3237;--ok:#7bd88f;--bad:#ff8a80;--warn:#ffd27a;--band:#3a3000}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:16px}
.band{background:var(--band);border:1px solid var(--warn);padding:8px 12px;font-weight:700;letter-spacing:.04em}
table{border-collapse:collapse;width:100%;margin:8px 0 20px}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
.ok{color:var(--ok);font-weight:700}.bad{color:var(--bad);font-weight:700}.muted{color:var(--muted)}
code{word-break:break-all}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}
.card{border:1px solid var(--line);padding:8px}.card b{display:block;font-size:18px}
</style></head><body>
<div class="band">PAPER — SIMULATED FUNDS · not live trading · not financial advice</div>
<h1>Paper trading report</h1>
<p class="muted">Session <code>${escapeHtml(report.session.id)}</code> · ${escapeHtml(report.session.venue)} ${escapeHtml(report.session.product)} · status ${escapeHtml(report.session.status)}</p>
<div class="grid">
<div class="card">Operational correctness<b class="${r.operationalCorrectness === 'pass' ? 'ok' : 'bad'}">${escapeHtml(r.operationalCorrectness)}</b></div>
<div class="card">Strategy evidence<b>${escapeHtml(r.strategyEvidence)}</b></div>
<div class="card">Net trading PnL (USD)<b>${fmt(m.netTradingPnl)}</b></div>
<div class="card">All-in operating PnL<b>${m.allInOperatingPnl === null ? 'unknown' : fmt(m.allInOperatingPnl)}</b></div>
<div class="card">Fees (USD)<b>${fmt(m.fees)}</b></div>
<div class="card">Ending cash / BTC<b>${fmt(m.endingCash)} / ${fmt(m.endingBtc)}</b></div>
<div class="card">Max drawdown<b>${fmt(m.maxDrawdown * 100, 3)}%</b></div>
<div class="card">Feed coverage<b>${fmt(m.feed.coveragePct, 2)}%</b></div>
</div>
<h2>Gates</h2><table><tr><th>Gate</th><th>Result</th><th>Evidence</th></tr>${gateRows}</table>
<h2>Controls</h2><table><tr><th>Control</th><th>Return</th><th>Note</th></tr>
<tr><td>Cash</td><td>${fmt(r.controls.cash.ret * 100, 3)}%</td><td></td></tr>
<tr><td>BTC buy-and-hold</td><td>${r.controls.buyHold.ret === null ? '—' : fmt(r.controls.buyHold.ret * 100, 3) + '%'}</td><td>${escapeHtml(r.controls.buyHold.note)}</td></tr>
<tr><td>Matched exposure</td><td>${r.controls.matchedExposure.ret === null ? '—' : fmt(r.controls.matchedExposure.ret * 100, 3) + '%'}</td><td>${escapeHtml(r.controls.matchedExposure.note)}</td></tr>
<tr><td>Candidate</td><td>${m.netReturn === null ? '—' : fmt(m.netReturn * 100, 3) + '%'}</td><td>net of fees, spread and simulated depth</td></tr></table>
<h2>Activity</h2><table>${Object.entries(m.counts)
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${fmt(v, 0)}</td></tr>`)
    .join('')}
<tr><td>round trips</td><td>${m.roundTrips.count} (win rate ${fmt(m.roundTrips.winRate, 3)}, profit factor ${fmt(m.roundTrips.profitFactor, 3)})</td></tr>
<tr><td>reconnects / sequence gaps</td><td>${m.feed.reconnects} / ${m.feed.seqGaps}</td></tr></table>
<h2>Uncertainty and sensitivity</h2>
<p>${r.uncertainty.lowerBound === null ? escapeHtml(`Bootstrap not computed: ${r.uncertainty.reason}`) : escapeHtml(`One-sided ${r.uncertainty.confidence * 100}% lower bound: ${r.uncertainty.lowerBound}`)}</p>
<table>${Object.entries(r.sensitivity)
    .filter(([k]) => k !== 'note')
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${v === null ? 'unknown' : fmt(v)}</td></tr>`)
    .join('')}</table>
<h2>Findings</h2><ul>${r.findings.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>
<h2>Identity</h2><table>${Object.entries(report.identity)
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td><code>${escapeHtml(typeof v === 'string' ? v : JSON.stringify(v))}</code></td></tr>`)
    .join('')}</table>
<h2>Reproduce</h2><pre>${report.reproduction.map(escapeHtml).join('\n')}</pre>
<p class="muted">${escapeHtml(r.disclaimer)}</p>
</body></html>`;
}
