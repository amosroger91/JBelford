import type { DashboardSnapshot } from './snapshot';
import { fmtUsd } from '../core/util';

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function pnl(v: number, color: boolean, digits = 4): string {
  const s = (v >= 0 ? '+' : '') + fmtUsd(v, digits);
  if (!color) return s;
  return (v > 0 ? C.green : v < 0 ? C.red : '') + s + C.reset;
}

function time(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
}

/** Pure renderer: snapshot in, text out (tested without a terminal). */
export function renderDashboard(s: DashboardSnapshot, color = true): string {
  const b = (t: string) => (color ? C.bold + t + C.reset : t);
  const paint = (c: string, t: string) => (color ? c + t + C.reset : t);
  const lines: string[] = [];
  const hb = s.heartbeat;
  const hbAge = hb ? s.now - hb.ts : Infinity;
  const engineState = !hb ? 'NOT RUNNING' : hbAge > 30_000 ? `NO HEARTBEAT (${Math.round(hbAge / 1000)}s)` : hb.phase;

  lines.push(b(`JBelford BTC/USD scalper  [${s.mode.toUpperCase()}]`) + paint(C.dim, `  ${time(s.now)} UTC`));
  if (s.mode !== 'live') lines.push(paint(C.cyan, 'PAPER TRADING: no real orders are sent'));
  if (s.kill) lines.push(paint(C.red, `KILL SWITCH ACTIVE since ${s.kill.at}: ${s.kill.reason}`));
  if (s.halt) lines.push(paint(C.red, `HALTED (${s.halt.kind}) since ${time(s.halt.at)}: ${s.halt.reason}`));
  lines.push(
    `Engine: ${b(engineState)}  data: ${hb?.transport ?? '-'} age ${hb ? Math.round(hb.dataAgeMs / 1000) + 's' : '-'}  state: ${
      hb ? (hb.stateCertain ? paint(C.green, 'certain') : paint(C.yellow, 'UNCERTAIN')) : '-'
    }  bid/ask: ${hb?.bid ?? '-'} / ${hb?.ask ?? '-'}`,
  );
  lines.push('');

  const bal = s.balance;
  const equityChange = bal && s.startingEquity !== undefined ? bal.equity - s.startingEquity : 0;
  lines.push(b('Account'));
  lines.push(
    `  USD ${bal ? fmtUsd(bal.usd, 2) : '-'}   BTC ${bal ? bal.btc.toFixed(8) : '-'}   Equity ${bal ? fmtUsd(bal.equity, 2) : '-'}   since start ${pnl(equityChange, color, 2)}`,
  );
  lines.push(
    `  Net P&L ${pnl(s.totals.netPnl, color)}   Gross ${pnl(s.totals.grossPnl, color)}   Fees ${fmtUsd(s.totals.fees, 4)}   Trades ${s.totals.trades}   Win rate ${
      s.totals.trades ? ((s.totals.wins / s.totals.trades) * 100).toFixed(0) + '%' : '-'
    }`,
  );
  lines.push('');

  lines.push(b('Position'));
  if (s.position) {
    const p = s.position;
    lines.push(
      `  LONG ${p.amount.toFixed(8)} BTC @ ${p.entryPrice.toFixed(1)}  stop ${p.stopPrice.toFixed(1)}  target ${p.takeProfitPrice.toFixed(1)}  opened ${time(p.openedAt)}  unrealized ${pnl(s.unrealizedUsd, color)}`,
    );
  } else {
    lines.push('  flat');
  }
  lines.push('');

  const L = s.limits;
  const remaining = L.maxDailyLossUsd + s.daily.realizedTodayUsd + Math.min(0, s.unrealizedUsd);
  lines.push(b('Risk (hard limits, not configurable)'));
  lines.push(
    `  Today: trades ${s.daily.tradesToday}/${L.maxTradesPerDay}  realized ${pnl(s.daily.realizedTodayUsd, color)}  loss budget left ${fmtUsd(Math.max(0, remaining), 3)} of ${fmtUsd(L.maxDailyLossUsd)}`,
  );
  lines.push(
    `  Consecutive losses ${s.daily.consecutiveLosses}/${L.maxConsecutiveLosses}  cooldown ${s.cooldownMs > 0 ? Math.ceil(s.cooldownMs / 1000) + 's' : 'none'}  max order ${fmtUsd(L.maxOrderValueUsd)}`,
  );
  lines.push('');

  lines.push(b('Recent trades'));
  if (s.recentTrades.length === 0) lines.push('  none yet');
  for (const t of s.recentTrades) {
    lines.push(
      `  ${time(t.closedAt)}  ${t.exitReason.padEnd(12)} ${t.amount.toFixed(8)} @ ${t.entryPrice.toFixed(1)} -> ${t.exitPrice.toFixed(1)}  fees ${fmtUsd(
        t.entryFee + t.exitFee,
        4,
      )}  net ${pnl(t.netPnl, color)}`,
    );
  }
  lines.push('');
  lines.push(b('Events'));
  for (const e of s.recentEvents) {
    const c = e.level === 'error' ? C.red : e.level === 'warn' ? C.yellow : C.dim;
    lines.push(paint(c, `  ${time(e.ts)} ${e.level.padEnd(5)} ${e.msg}`));
  }
  lines.push('');
  lines.push(paint(C.dim, 'Ctrl+C exits the dashboard only. Emergency stop: npm run kill'));
  return lines.join('\n');
}
