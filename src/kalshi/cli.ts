import { parseArgs } from 'node:util';
import { resolveFromRoot } from '../paper/service';
import { loadKalshiConfig } from './config';
import { UNIT } from './engine';
import { listKalshiSessions, reportKalshi, runKalshiLive } from './service';

export const KALSHI_USAGE = `usage: jbelford kalshi <start|report|sessions> [--config config/kalshi.paper.yaml] [--duration 2h] [SESSION_ID]`;

function duration(s: string | undefined): number {
  const m = /^(\d+)(s|m|h)$/.exec(s ?? '2h');
  if (!m) throw new Error(`bad --duration "${s}" (use e.g. 30m, 2h)`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as 's' | 'm' | 'h'];
}

export async function kalshiMain(cmd: string, rest: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { config: { type: 'string' }, duration: { type: 'string' }, output: { type: 'string' } },
  });
  const cfg = loadKalshiConfig(resolveFromRoot(values.config ?? 'config/kalshi.paper.yaml'));
  switch (cmd) {
    case 'start': {
      const ms = duration(values.duration);
      const ac = new AbortController();
      process.once('SIGINT', () => ac.abort());
      console.log(
        `PAPER - SIMULATED FUNDS. Kalshi public data only; no account, no orders sent. Bankroll $${cfg.bankrollUsd}, ${cfg.series.length} series, run ${values.duration ?? '2h'}.`,
      );
      const r = await runKalshiLive({
        cfg,
        durationMs: ms,
        signal: ac.signal,
        onProgress: (e, note) => {
          const s = e.summary();
          console.log(
            `  [${new Date().toISOString().slice(11, 19)}] ${note} cash=$${s.cashUsd.toFixed(2)} equity@cost=$${s.equityAtCostUsd.toFixed(2)} pnl=$${s.realizedPnlUsd.toFixed(2)} ` +
              `orders=${e.openOrders().length} fills=${s.fills} settled=${s.settledMarkets} (W${s.wins}/L${s.losses}) open=${s.openPositions} reserved=$${(e.reserved() / UNIT).toFixed(2)}`,
          );
        },
      });
      console.log(`Session ${r.sessionId} finished: ${JSON.stringify(r.engine.summary())}`);
      console.log(`Next: kalshi report ${r.sessionId}`);
      return;
    }
    case 'report': {
      const id = positionals[0];
      if (!id) throw new Error('report needs a SESSION_ID');
      const { report, out } = reportKalshi(cfg, id, values.output);
      console.log(JSON.stringify(report, null, 2));
      console.log(`report: ${out}`);
      return;
    }
    case 'sessions': {
      for (const s of listKalshiSessions(cfg)) {
        const x = s.summary;
        console.log(
          `${s.id}  ${s.status}${x ? `  pnl $${x.realizedPnlUsd.toFixed(2)}  settled ${x.settledMarkets} (W${x.wins}/L${x.losses})  fills ${x.fills}` : ''}`,
        );
      }
      return;
    }
    default:
      console.error(KALSHI_USAGE);
      process.exit(2);
  }
}
