// Paper trading dashboard. All external content is written with textContent; never innerHTML.
const params = new URLSearchParams(location.search);
const TOKEN = params.get('token') || '';
const $ = (sel) => document.querySelector(sel);
let current = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', 'x-paper-token': TOKEN, ...(opts.headers || {}) },
    credentials: 'same-origin',
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function setField(name, value, cls) {
  for (const el of document.querySelectorAll(`[data-field="${name}"]`)) {
    el.textContent = value === null || value === undefined || value === '' ? '—' : String(value);
    el.className = cls || '';
  }
}

const num = (v, d = 2) => (v === null || v === undefined || v === '' ? '—' : Number(v).toFixed(d));
const utc = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : '—');

function row(tbody, cells) {
  const tr = document.createElement('tr');
  for (const c of cells) {
    const td = document.createElement('td');
    if (c && typeof c === 'object') {
      td.textContent = c.text;
      if (c.cls) td.className = c.cls;
    } else td.textContent = c === null || c === undefined ? '—' : String(c);
    tr.appendChild(td);
  }
  tbody.appendChild(tr);
}

function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

async function loadSessions(keep) {
  const data = await api('/api/sessions');
  const sel = $('#session');
  clear(sel);
  for (const s of data.sessions) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = `${s.id} · ${s.strategy} · ${s.status}${s.runtimeActive ? ' · running' : ''}`;
    sel.appendChild(o);
  }
  const ss = $('#start-strategy');
  if (!ss.options.length) {
    for (const id of data.strategies.filter((x) => x !== 'llm')) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = id;
      ss.appendChild(o);
    }
  }
  $('#start-box').hidden = !data.allowStart;
  if (keep && data.sessions.some((s) => s.id === keep)) sel.value = keep;
  current = sel.value || null;
}

function drawChart(vals) {
  const svg = $('#chart');
  clear(svg);
  const pts = vals.filter((v) => v.equity_mid !== null);
  if (pts.length < 2) return;
  const ys = pts.map((v) => Number(v.equity_mid));
  const t0 = pts[0].time;
  const t1 = pts[pts.length - 1].time || t0 + 1;
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const span = hi - lo || 1;
  const path = pts
    .map(
      (v, i) => `${i ? 'L' : 'M'}${(((v.time - t0) / (t1 - t0 || 1)) * 600).toFixed(1)},${(150 - ((ys[i] - lo) / span) * 140).toFixed(1)}`,
    )
    .join(' ');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.5');
  p.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(p);
}

async function refresh() {
  if (!current) return;
  const [s, orders, fills, vals, decisions, ready] = await Promise.all([
    api(`/api/sessions/${encodeURIComponent(current)}`),
    api(`/api/sessions/${encodeURIComponent(current)}/orders`),
    api(`/api/sessions/${encodeURIComponent(current)}/fills`),
    api(`/api/sessions/${encodeURIComponent(current)}/valuations`),
    api(`/api/sessions/${encodeURIComponent(current)}/decisions`),
    api(`/api/sessions/${encodeURIComponent(current)}/readiness`),
  ]);
  const live = s.live && s.runtimeActive ? s.live : null;
  const bid = live ? live.bestBid : s.valuation ? s.valuation.mark_bid : null;
  const mid = s.valuation ? s.valuation.mark_mid : null;
  const ask = live ? live.bestAsk : bid && mid ? (2 * Number(mid) - Number(bid)).toFixed(2) : null;
  setField('venue', `${s.venue} ${s.product}`);
  setField('lastTrade', live ? live.lastTrade : null);
  setField('bidask', bid ? `${bid} / ${ask ?? '—'}` : null);
  setField('spread', bid && ask ? `${(((Number(ask) - Number(bid)) / ((Number(ask) + Number(bid)) / 2)) * 10000).toFixed(3)} bps` : null);
  const feedState = live ? live.feed : s.feed ? `${s.feed.state} (last recorded)` : 'no data';
  setField('feed', feedState, live && live.feed === 'healthy' ? 'ok' : 'bad');
  setField(
    'feedAge',
    live && live.feedAgeMs !== null ? `${(live.feedAgeMs / 1000).toFixed(1)} s` : s.runtimeActive ? null : 'runtime not running',
  );
  setField('status', s.status + (s.runtimeActive ? ' (runtime attached)' : ''));
  setField('lastEvent', utc(s.lastEventTime));
  const b = s.balances;
  setField('initialUsd', `$${num(s.initialUsd)}`);
  setField('usd', `$${num(b.usd_available)} / $${num(b.usd_reserved)}`);
  setField('btc', `${num(b.btc_available, 8)} / ${num(b.btc_reserved, 8)}`);
  setField(
    'equity',
    s.valuation && s.valuation.equity_mid ? `$${num(s.valuation.equity_mid)}${s.valuation.stale ? ' (stale)' : ''}` : 'stale / unavailable',
  );
  const m = ready.metrics;
  setField(
    'pnl',
    m.netTradingPnl === null ? 'unknown (stale valuation)' : `$${num(m.netTradingPnl, 4)}`,
    m.netTradingPnl > 0 ? 'ok' : m.netTradingPnl < 0 ? 'bad' : '',
  );
  setField(
    'allIn',
    m.allInOperatingPnl === null
      ? m.operatingCosts.complete
        ? 'unknown'
        : 'unknown: incomplete cost data'
      : `$${num(m.allInOperatingPnl, 4)}`,
  );
  setField('fees', `$${num(m.fees, 4)}`);
  setField('dd', `${num(m.maxDrawdown * 100, 3)}%`);
  setField('exposure', `${num(m.avgExposure * 100, 2)}%`);
  drawChart(vals);
  const c = ready.controls;
  $('#controls-line').textContent =
    `Controls over the same window: cash 0.000% · BTC buy-and-hold ${c.buyHold.ret === null ? '—' : num(c.buyHold.ret * 100, 3) + '%'} · matched exposure ${c.matchedExposure.ret === null ? '—' : num(c.matchedExposure.ret * 100, 3) + '%'} · candidate ${m.netReturn === null ? '—' : num(m.netReturn * 100, 3) + '%'}`;

  const ot = $('#orders');
  clear(ot);
  for (const o of orders) {
    const avg = Number(o.filled_qty) > 0 ? (Number(o.notional) / Number(o.filled_qty)).toFixed(2) : '—';
    row(ot, [
      utc(o.submitted_at),
      utc(o.arrival_at),
      o.side,
      o.qty,
      o.filled_qty,
      avg,
      o.fees,
      { text: o.status, cls: o.status === 'filled' ? 'ok' : o.status === 'rejected' ? 'bad' : '' },
      { text: o.reject_reason || '', cls: 'wrap' },
    ]);
  }
  const ft = $('#fills');
  clear(ft);
  for (const f of fills) row(ft, [utc(f.time), f.fill_id, f.side, f.qty, f.price, f.fee]);

  const dl = $('#decisions');
  clear(dl);
  for (const d of decisions.slice(0, 20)) {
    const div = document.createElement('div');
    div.className = 'decision';
    const intent = d.intent_json ? JSON.parse(d.intent_json) : null;
    const head = document.createElement('div');
    head.textContent = `${utc(d.completed_at)} · ${d.decision_id} · ${d.strategy} · ${d.outcome}${intent ? ` · ${intent.action}${intent.targetWeight ? ' ' + intent.targetWeight : ''} · ${intent.rationale}` : d.detail ? ' · ' + d.detail : ''}`;
    div.appendChild(head);
    const checks = document.createElement('div');
    checks.className = 'muted';
    checks.textContent = d.checks.map((k) => `${k.passed ? '✓' : '✗'} ${k.check_name}: ${k.detail}`).join(' · ');
    div.appendChild(checks);
    dl.appendChild(div);
  }
  setField('opCorrect', ready.operationalCorrectness, ready.operationalCorrectness === 'pass' ? 'ok' : 'bad');
  setField('evidence', ready.strategyEvidence);
  const gt = $('#gates');
  clear(gt);
  for (const g of ready.gates)
    row(gt, [g.gate, { text: g.passed ? 'PASS' : 'FAIL', cls: g.passed ? 'ok' : 'bad' }, { text: g.evidence, cls: 'wrap' }]);
  const fl = $('#findings');
  clear(fl);
  for (const f of ready.findings) {
    const li = document.createElement('li');
    li.textContent = f;
    fl.appendChild(li);
  }
  setField('purpose', s.purpose);
  setField('identity', `config ${s.configHash.slice(0, 16)}… · strategy version ${s.strategyVersion.slice(0, 16)}…`);
}

async function control(action) {
  if (!current) return;
  const msg = $('#control-msg');
  try {
    const r = await api(`/api/sessions/${encodeURIComponent(current)}/control`, { method: 'POST', body: JSON.stringify({ action }) });
    msg.textContent = `${r.mode}: ${r.detail}`;
  } catch (e) {
    msg.textContent = `error: ${e.message}`;
  }
  await loadSessions(current);
  await refresh();
}

for (const b of document.querySelectorAll('[data-action]')) b.addEventListener('click', () => control(b.dataset.action));
$('#session').addEventListener('change', (e) => {
  current = e.target.value;
  refresh();
});
$('#start-btn').addEventListener('click', async () => {
  const msg = $('#control-msg');
  try {
    const r = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ strategy: $('#start-strategy').value, durationMinutes: Number($('#start-duration').value) }),
    });
    msg.textContent = r.note;
  } catch (e) {
    msg.textContent = `error: ${e.message}`;
  }
});

(async () => {
  try {
    await loadSessions();
    await refresh();
  } catch (e) {
    $('#control-msg').textContent = `error: ${e.message}`;
  }
  setInterval(() => refresh().catch(() => {}), 3000);
})();
