import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadPaperConfig, parsePaperConfig, type PaperConfig } from '../paper/config';
import { PaperOnlyError, type ControlAction } from '../paper/domain';
import { TradingStore } from '../paper/store';
import { TradingService, resolveFromRoot, runForward, runReplay, PROJECT_ROOT } from '../paper/service';
import { canonicalJournal, diffJournals, journalHash } from '../paper/evaluation/canonical';
import { evaluateReadiness, type ExternalEvidence } from '../paper/evaluation/readiness';
import { exportReport } from '../paper/export';
import { Ledger } from '../paper/ledger';

/**
 * JBelford command line.
 *
 *   node dist/cli.js paper start   --config config/trading.paper.yaml [--duration 30m] [--strategy ID] [--drill disconnect@10m:20s,duplicate@12m:5]
 *   node dist/cli.js paper resume  SESSION_ID [--duration 15m] [--drill ...]   restart a runtime (or resume a paused one)
 *   node dist/cli.js paper status  [SESSION_ID]
 *   node dist/cli.js paper pause|stop|flatten SESSION_ID
 *   node dist/cli.js paper replay  SESSION_ID [--output artifacts/trading/SESSION_ID/replay]
 *   node dist/cli.js paper report  SESSION_ID [--output artifacts/trading/SESSION_ID]
 *   node dist/cli.js paper research [--days 360] [--refresh]
 *   node dist/cli.js paper sessions
 *   node dist/cli.js paper web [--port 8787]
 *   node dist/cli.js paper mcp
 *   node dist/cli.js kalshi start [--duration 2h] | kalshi report SESSION_ID | kalshi sessions   (Kalshi paper test)
 */
const USAGE = `usage: jbelford paper <start|resume|status|pause|stop|flatten|replay|report|research|sessions|web|mcp> [args]`;

function duration(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(s);
  if (!m) throw new Error(`invalid duration "${s}" (examples: 90s, 30m, 2h)`);
  return Math.round(Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as 'ms' | 's' | 'm' | 'h']);
}

function drills(s: string | undefined) {
  if (!s) return [];
  return s.split(',').map((d) => {
    const m = /^(disconnect|duplicate)@([^:]+):(.+)$/.exec(d.trim());
    if (!m) throw new Error(`invalid drill "${d}" (examples: disconnect@10m:20s, duplicate@12m:5)`);
    const kind = m[1] as 'disconnect' | 'duplicate';
    return { kind, atMs: duration(m[2])!, arg: kind === 'disconnect' ? duration(m[3])! : Number(m[3]) };
  });
}

function loadConfig(path: string | undefined, overrides: { strategy?: string; usd?: string }): PaperConfig {
  const p = resolveFromRoot(path ?? 'config/trading.paper.yaml');
  const local = resolveFromRoot('config/trading.paper.local.yaml');
  const cfg = loadPaperConfig(path ? p : existsSync(local) ? local : p);
  if (!overrides.strategy && !overrides.usd) return cfg;
  const raw = JSON.parse(JSON.stringify(cfg)) as PaperConfig;
  if (overrides.strategy) raw.strategy = { id: overrides.strategy as PaperConfig['strategy']['id'], params: {} };
  if (overrides.usd) raw.initialBalances = { ...raw.initialBalances, usd: overrides.usd };
  return parsePaperConfig(raw);
}

function openStore(cfgPath?: string): { store: TradingStore; svc: TradingService; cfg: PaperConfig } {
  const cfg = loadConfig(cfgPath, {});
  const store = new TradingStore(resolveFromRoot(cfg.storage.db));
  return { store, svc: new TradingService(store), cfg };
}

function progress(s: {
  feed: string;
  bestBid: string | null;
  bestAsk: string | null;
  ordinal: number;
  status: string;
  reconnects: number;
  skippedDecisions: number;
}) {
  console.log(
    `  [${new Date().toISOString().slice(11, 19)}] ${s.status} feed=${s.feed} bid=${s.bestBid} ask=${s.bestAsk} events=${s.ordinal} reconnects=${Math.max(0, s.reconnects - 1)}`,
  );
}

function acceptanceEvidence(): ExternalEvidence['acceptance'] {
  const p = join(PROJECT_ROOT, 'artifacts', 'acceptance', 'latest.json');
  if (!existsSync(p)) return undefined;
  const r = JSON.parse(readFileSync(p, 'utf8')) as {
    numTotalTests: number;
    numFailedTests: number;
    numPassedTests: number;
    startTime: number;
  };
  return {
    passed: r.numTotalTests > 0 && r.numFailedTests === 0,
    detail: `${r.numPassedTests}/${r.numTotalTests} acceptance tests passed (run ${new Date(r.startTime).toISOString()})`,
  };
}

/** Replay a session's recording into its own database and compare canonical journals. */
function replayAndCompare(svc: TradingService, store: TradingStore, sessionId: string, cfg: PaperConfig) {
  const s = svc.session(sessionId);
  if (!s) throw new Error(`unknown session ${sessionId}`);
  const datasetDir = resolveFromRoot(join(cfg.recording.dir, s.datasetId ?? sessionId));
  const replayDb = join(PROJECT_ROOT, 'artifacts', 'replays', `${sessionId}-${Date.now()}.db`);
  const r = runReplay({
    sourceDbPath: resolveFromRoot(cfg.storage.db),
    sourceSessionId: sessionId,
    datasetDir,
    replayDbPath: replayDb,
    replayId: `replay-of-${sessionId}`,
  });
  const rs = new TradingStore(replayDb);
  const a = journalHash(store, sessionId);
  const b = journalHash(rs, r.replaySessionId);
  const diff = a.hash === b.hash ? null : diffJournals(canonicalJournal(store, sessionId), canonicalJournal(rs, r.replaySessionId));
  rs.close();
  return { ...r, datasetDir, originalHash: a.hash, replayHash: b.hash, matched: a.hash === b.hash, counts: a.counts, diff };
}

async function main() {
  const [group, cmd, ...rest] = process.argv.slice(2);
  if (group === 'kalshi' && cmd) {
    const { kalshiMain } = await import('../kalshi/cli');
    return kalshiMain(cmd, rest);
  }
  if (group !== 'paper' || !cmd) {
    console.error(USAGE);
    process.exit(2);
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      duration: { type: 'string' },
      strategy: { type: 'string' },
      usd: { type: 'string' },
      drill: { type: 'string' },
      output: { type: 'string' },
      days: { type: 'string' },
      refresh: { type: 'boolean', default: false },
      port: { type: 'string' },
      participation: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
  const id = positionals[0];

  switch (cmd) {
    case 'start': {
      const cfg = loadConfig(values.config, { strategy: values.strategy, usd: values.usd });
      console.log(
        `PAPER — SIMULATED FUNDS. Starting ${cfg.strategy.id} on live public ${cfg.venue} ${cfg.product} data with $${cfg.initialBalances.usd} simulated cash.`,
      );
      const ac = new AbortController();
      process.once('SIGINT', () => ac.abort());
      const r = await runForward({
        cfg,
        durationMs: duration(values.duration),
        drills: drills(values.drill),
        onProgress: progress,
        signal: ac.signal,
      });
      console.log(`Runtime exited. Session ${r.sessionId} (status ${r.status.status}); recording ${r.datasetDir}`);
      console.log(
        `Next: paper status ${r.sessionId} | paper resume ${r.sessionId} | paper stop ${r.sessionId} | paper report ${r.sessionId}`,
      );
      return;
    }
    case 'resume': {
      if (!id) throw new Error('resume needs SESSION_ID');
      const { store, svc, cfg } = openStore(values.config);
      if (svc.runtimeActive(id)) {
        console.log(svc.control(id, 'resume').detail);
        store.close();
        return;
      }
      store.close();
      const ac = new AbortController();
      process.once('SIGINT', () => ac.abort());
      const r = await runForward({
        cfg,
        resumeSessionId: id,
        durationMs: duration(values.duration),
        drills: drills(values.drill),
        onProgress: progress,
        signal: ac.signal,
      });
      console.log(`Runtime exited. Session ${r.sessionId} (status ${r.status.status}).`);
      return;
    }
    case 'pause':
    case 'stop':
    case 'flatten': {
      if (!id) throw new Error(`${cmd} needs SESSION_ID`);
      const { store, svc } = openStore(values.config);
      const r = svc.control(id, cmd as ControlAction);
      console.log(`${r.mode}: ${r.detail}`);
      store.close();
      if (r.mode === 'refused') process.exit(1);
      return;
    }
    case 'status':
    case 'sessions': {
      const { store, svc } = openStore(values.config);
      const list = id ? [svc.session(id)].filter(Boolean) : svc.sessions();
      for (const s of list) {
        const b = svc.ledger.view(s!.id);
        const v = store.get('SELECT equity_mid, stale, time FROM valuations WHERE session_id = ? ORDER BY id DESC LIMIT 1', s!.id);
        const fills = store.get('SELECT COUNT(*) AS n FROM fills WHERE session_id = ?', s!.id)!.n;
        const out = {
          ...s,
          runtimeActive: svc.runtimeActive(s!.id),
          balances: b,
          lastEquityMid: v?.equity_mid ?? null,
          valuationStale: Boolean(v?.stale),
          fills,
        };
        console.log(
          values.json
            ? JSON.stringify(out)
            : `${s!.id}  ${s!.status.padEnd(8)} ${s!.strategy.padEnd(16)} USD ${b.usdAvailable}+${b.usdReserved} BTC ${b.btcAvailable}+${b.btcReserved} equity ${out.lastEquityMid ?? '—'}${out.valuationStale ? ' (stale)' : ''} fills ${fills}${out.runtimeActive ? ' [running]' : ''}`,
        );
      }
      if (list.length === 0) console.log('no sessions');
      store.close();
      return;
    }
    case 'replay': {
      if (!id) throw new Error('replay needs SESSION_ID (its recording is the dataset)');
      const { store, svc, cfg } = openStore(values.config);
      if (values.participation) {
        // Counterfactual liquidity stress on the real recording (not a reproduction).
        const s = svc.session(id);
        if (!s) throw new Error(`unknown session ${id}`);
        const db = join(PROJECT_ROOT, 'artifacts', 'replays', `${id}-stress-${Date.now()}.db`);
        const sr = runReplay({
          sourceDbPath: resolveFromRoot(cfg.storage.db),
          sourceSessionId: id,
          datasetDir: resolveFromRoot(join(cfg.recording.dir, s.datasetId ?? id)),
          replayDbPath: db,
          replayId: `stress-of-${id}`,
          executionOverride: { participation: values.participation },
        });
        const rs = new TradingStore(db);
        const out = {
          label: 'STRESS REPLAY: counterfactual thinner liquidity on recorded live data (not a reproduction)',
          participation: values.participation,
          db,
          orders: rs.all(
            'SELECT order_id, side, qty, filled_qty, status, reject_reason FROM orders WHERE session_id = ?',
            sr.replaySessionId,
          ),
          fills: rs.all('SELECT fill_id, price, qty, fee FROM fills WHERE session_id = ?', sr.replaySessionId),
          ledgerProblems: new Ledger(rs).verify(sr.replaySessionId),
        };
        console.log(JSON.stringify(out, null, 2));
        rs.close();
        store.close();
        return;
      }
      const r = replayAndCompare(svc, store, id, cfg);
      console.log(JSON.stringify({ ...r, diff: r.diff ?? undefined }, null, 2));
      store.close();
      if (!r.matched) process.exit(1);
      return;
    }
    case 'report': {
      if (!id) throw new Error('report needs SESSION_ID');
      const { store, svc, cfg: appCfg } = openStore(values.config);
      const { cfg } = svc.sessionConfig(id);
      const rep = replayAndCompare(svc, store, id, appCfg);
      const readiness = evaluateReadiness(store, id, cfg, {
        acceptance: acceptanceEvidence(),
        replay: {
          matched: rep.matched,
          detail: `original ${rep.originalHash.slice(0, 16)}… vs replay ${rep.replayHash.slice(0, 16)}… over ${rep.events} recorded events`,
        },
      });
      const out = resolveFromRoot(values.output ?? join('artifacts', 'trading', id));
      const res = exportReport(store, id, cfg, readiness, out, {
        datasetDir: rep.datasetDir,
        replay: rep,
        reproduction: [
          'npm ci && npm run build',
          `node dist/cli.js paper replay ${id}`,
          `node dist/cli.js paper report ${id} --output ${values.output ?? `artifacts/trading/${id}`}`,
          `# dataset: ${rep.datasetDir.replace(PROJECT_ROOT, '.').replace(/\\/g, '/')} (sha256-verified segments)`,
        ],
      });
      console.log(`operationalCorrectness=${readiness.operationalCorrectness} strategyEvidence=${readiness.strategyEvidence}`);
      console.log(`replay matched=${rep.matched} journal=${res.journalHash}`);
      console.log(`report: ${join(res.dir, 'report.html')}`);
      store.close();
      return;
    }
    case 'history': {
      const { loadCandles, loadBinanceUsCandles } = await import('../paper/research/historical');
      if (positionals[0] === 'binanceus') {
        console.log(`binance.us candles fetched: ${await loadBinanceUsCandles(Number(values.days ?? 360))}`);
        return;
      }
      const c = await loadCandles(Number(values.days ?? 360), values.refresh);
      console.log(
        `cached ${c.length} completed Coinbase BTC-USD 5m candles ${new Date(c[0]!.start).toISOString()} .. ${new Date(c.at(-1)!.start).toISOString()}`,
      );
      return;
    }
    case 'bracket': {
      const { runBracketBatch } = await import('../paper/research/bracket');
      const cfg = loadConfig(values.config, {});
      const batch = positionals[0] ?? 'batch-01';
      const { out, dir } = runBracketBatch(cfg, { batch, outDir: resolveFromRoot(values.output ?? 'artifacts/research') });
      console.log(
        `BRACKET SCREENING batch ${batch}: ${out.trials} trials (${out.activeTrials} active, ${out.devPositiveTrials} positive on development) in ${out.seconds}s`,
      );
      console.log(`splits: dev ${out.splits.development} | validation ${out.splits.validation} | held-out ${out.splits.heldOut}`);
      for (const f of out.perFamily) {
        const pct = (x: number | undefined) => (x === undefined ? '—' : `${(x * 100).toFixed(2)}%`);
        console.log(
          `  ${f.family.padEnd(16)} trials ${String(f.trials).padStart(4)} devPositive ${String(f.devPositive).padStart(4)} | ` +
            (f.pick
              ? `pick dev ${pct(f.pick.dev.netReturn)} (${f.pick.dev.trades}t) val ${pct(f.pick.val.netReturn)} (${f.pick.val.trades}t) HELD-OUT ${pct(f.heldOut?.netReturn)} (${f.heldOut?.trades}t) stress ${pct(f.heldOutStress?.netReturn)} kraken ${pct(f.heldOutKraken?.netReturn)} ${f.passes ? 'PASS' : 'fail'}`
              : 'no development winner survived validation'),
        );
      }
      console.log(
        `held-out controls: BTC buy-and-hold ${(out.controls.heldOutBtcBuyHold * 100).toFixed(2)}%, matched exposure ${(out.controls.heldOutMatchedExposure * 100).toFixed(2)}%`,
      );
      console.log(`multiple testing: ${JSON.stringify(out.multipleTesting)}`);
      console.log(`any family passes the protocol: ${out.anyPass}`);
      console.log(`saved ${dir}`);
      return;
    }
    case 'research': {
      const { runResearch } = await import('../paper/research/historical');
      const cfg = loadConfig(values.config, {});
      await runResearch(cfg, {
        days: Number(values.days ?? 360),
        refresh: values.refresh,
        outDir: resolveFromRoot(values.output ?? 'artifacts/research'),
      });
      return;
    }
    case 'web': {
      const { startWeb } = await import('../paper/web/server');
      const cfg = loadConfig(values.config, {});
      await startWeb({ dbPath: resolveFromRoot(cfg.storage.db), port: Number(values.port ?? 8787), configPath: values.config });
      return;
    }
    case 'mcp': {
      const { startMcp } = await import('../paper/mcp/server');
      await startMcp({ configPath: values.config });
      return;
    }
    default:
      console.error(USAGE);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e instanceof PaperOnlyError ? `REFUSED: ${e.message}` : `error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
