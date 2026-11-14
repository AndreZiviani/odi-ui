/*
 * The Status tab: the last two hours, one sample a minute.
 *
 * The image keeps the samples (odi-oss history.sh, a RAM ring at
 * /var/run/history); confd only hands the file over, as GET /api/history
 * does, and everything here is worked out in the browser, as for /api/status.
 * A stick without the ring (a stock slot, an older odi-oss, history turned
 * off) answers raw: null and the section stays hidden.
 *
 * One line a sample, space-separated key=value, oldest first. Only the keys
 * below are read, and only plain numbers; anything else is dropped, so a key
 * the image adds later breaks nothing. Totals (octets, errors, CPU jiffies,
 * events) are turned into rates between two samples; a gap of more than
 * GAP_S between them, or a total that went down, breaks the line instead.
 */

import { $, el } from './dom.js';

const SVG = 'http://www.w3.org/2000/svg';
const WINDOW_S = 7200;       /* what the ring holds: 120 samples */
const GAP_S = 150;           /* more than two missed samples: no line across */
const W = 600;               /* the viewBox; the chart is scaled to the block */
const H = 56;
const STATES = { 1: 'O1', 2: 'O2', 3: 'O3', 4: 'O4', 5: 'O5', 6: 'O6', 7: 'O7' };
const NUM = /^-?\d+(\.\d+)?$/;
const KEYS = ['t', 'up', 'st', 'rx', 'tx', 'tc', 'bi', 'di', 'do', 'los', 'lof', 'lom',
  'o5i', 'o5o', 'bip', 'fecu', 'cb', 'ct', 'ma'];

/* The ring as [{ up, st, rx, ... }], oldest first; a line without up is dropped. */
function parseHistory(raw) {
  const out = [];
  for (const line of String(raw || '').split('\n')) {
    const s = {};
    for (const kv of line.trim().split(/\s+/)) {
      const eq = kv.indexOf('=');
      if (eq < 1) continue;
      const k = kv.slice(0, eq);
      const v = kv.slice(eq + 1);
      if (k === 'al') { if (/^(-|[A-Z]+(,[A-Z]+)*)$/.test(v)) s.al = v === '-' ? [] : v.split(','); continue; }
      if (KEYS.includes(k) && NUM.test(v)) s[k] = Number(v);
    }
    if (s.up !== undefined) out.push(s);
  }
  out.sort((a, b) => a.up - b.up);
  return out;
}

/* The difference of a total between two samples, null when either lacks it or it went down. */
function delta(a, b, k) {
  if (a[k] === undefined || b[k] === undefined) return null;
  const d = b[k] - a[k];
  return d < 0 ? null : d;
}

/*
 * Per sample, what the charts draw: a value or null (no line there).
 * Rates need the sample before, within GAP_S. Marks are the minutes where
 * the line changed: another ONU state than the sample before, a drop out of
 * O5 the transition counter saw (also when both samples read O5), or a LOS
 * or LOF that came and went.
 */
function series(samples) {
  const pts = [];
  const marks = [];
  for (let i = 0; i < samples.length; i++) {
    const b = samples[i];
    const a = i > 0 && b.up - samples[i - 1].up <= GAP_S ? samples[i - 1] : null;
    const dt = a ? b.up - a.up : 0;
    const rate = (k, scale) => {
      if (!a || dt <= 0) return null;
      const d = delta(a, b, k);
      return d === null ? null : (d * scale) / dt;
    };
    const dc = a ? delta(a, b, 'cb') : null;
    const dtot = a ? delta(a, b, 'ct') : null;
    pts.push({
      up: b.up, t: b.t, st: b.st,
      rx: b.rx === undefined ? null : b.rx,
      down: rate('di', 8 / 1e6), upl: rate('do', 8 / 1e6),
      bip: rate('bip', 60), fecu: rate('fecu', 60),
      cpu: dc !== null && dtot ? (dc / dtot) * 100 : null,
      mem: b.ma === undefined ? null : b.ma / 1024,
    });
    if (i === 0) continue;
    const p = samples[i - 1];
    const why = [];
    if (p.st !== undefined && b.st !== undefined && p.st !== b.st) {
      why.push(`${STATES[p.st] || p.st} \u2192 ${STATES[b.st] || b.st}`);
    }
    const out5 = delta(p, b, 'o5o');
    if (out5 && !(p.st === 5 && b.st !== 5 && out5 === 1)) {
      why.push(`left O5 ${out5}\u00d7`);
    }
    for (const k of ['los', 'lof']) {
      const d = delta(p, b, k);
      if (d) why.push(`${k.toUpperCase()} ${d}\u00d7`);
    }
    if (why.length) marks.push({ up: b.up, t: b.t, bad: b.st !== 5, text: why.join(', ') });
  }
  return { pts, marks };
}

/* A wall clock that NTP has set, as HH:MM; null before it was (or without t). */
function clock(t) {
  if (!t || t < 1600000000) return null;
  const d = new Date(t * 1000);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function svgEl(tag, attrs) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

/* One small chart: the lines of `keys`, a shared scale from zero (or from
   the data, for power), and the marks across it. */
function chart(spec, pts, marks, x) {
  const vals = [];
  for (const p of pts) for (const k of spec.keys) if (p[k] !== null && p[k] !== undefined) vals.push(p[k]);
  const box = el('div', 'h-chart');
  const head = el('div', 'h-head');
  head.append(el('span', 'h-name', spec.name));
  const last = pts.length ? pts[pts.length - 1] : null;
  const nows = spec.keys.map((k) => (last && last[k] !== null ? spec.fmt(last[k]) : '\u2014'));
  const now = nows.join(' / ');
  /* Each figure in the colour of its line, so two lines need no legend. */
  const nowEl = el('span', 'h-now');
  nows.forEach((v, n) => {
    if (n) nowEl.append(el('span', null, ' / '));
    nowEl.append(el('span', spec.keys.length > 1 ? 'h-c' + n : null, v));
  });
  nowEl.append(el('span', null, ' ' + spec.unit));
  head.append(nowEl);
  box.append(head);
  if (!vals.length) {
    box.append(el('p', 'h-none', 'No reading in this window.'));
    return box;
  }
  let lo = spec.zero ? 0 : Math.min(...vals);
  let hi = Math.max(...vals);
  if (spec.min !== undefined) hi = Math.max(hi, spec.min);
  if (hi - lo < (spec.span || 1e-9)) { const m = (hi + lo) / 2; lo = spec.zero ? 0 : m - spec.span / 2; hi = lo + spec.span; }
  const y = (v) => (H - 2 - ((v - lo) / (hi - lo)) * (H - 4)).toFixed(1);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'h-svg' });
  svg.setAttribute('aria-hidden', 'true');
  for (const m of marks) {
    svg.append(svgEl('line', { x1: x(m.up), x2: x(m.up), y1: 0, y2: H, class: m.bad ? 'h-mark bad' : 'h-mark' }));
  }
  spec.keys.forEach((k, n) => {
    let d = '';
    let pen = false;
    for (const p of pts) {
      if (p[k] === null || p[k] === undefined) { pen = false; continue; }
      d += (pen ? 'L' : 'M') + x(p.up) + ' ' + y(p[k]);
      pen = true;
    }
    if (d) svg.append(svgEl('path', { d, class: 'h-line h-line' + n }));
  });
  box.append(svg);
  const range = el('div', 'h-range');
  range.textContent = `${spec.fmt(Math.min(...vals))} to ${spec.fmt(Math.max(...vals))} ${spec.unit}`;
  box.append(range);
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', `${spec.name}, last two hours: ${range.textContent}; now ${now} ${spec.unit}.`);
  return box;
}

/* A real minus sign, as on the meters. */
const fix = (d) => (v) => (v < 0 ? '\u2212' : '') + Math.abs(v).toFixed(d);
const CHARTS = [
  { name: 'Receive power', keys: ['rx'], unit: 'dBm', fmt: fix(1), span: 1 },
  { name: 'Traffic down / up', keys: ['down', 'upl'], unit: 'Mbit/s', fmt: fix(1), zero: true, min: 1 },
  { name: 'BIP errors / uncorrectable FEC', keys: ['bip', 'fecu'], unit: 'per min', fmt: fix(0), zero: true, min: 1 },
  { name: 'CPU', keys: ['cpu'], unit: '%', fmt: fix(0), zero: true, min: 10 },
  { name: 'Memory available', keys: ['mem'], unit: 'MB', fmt: fix(1), zero: true, min: 1 },
];

/*
 * The section: a state strip (green while O5), the charts, the marks listed
 * under them with their time, and the axis. `now` is the uptime confd read
 * with the file, so the right edge is the moment of the request.
 */
function renderHistory(h) {
  const host = $('#histblock');
  const box = $('#history');
  if (!host || !box) return;
  if (!h || typeof h.raw !== 'string') { host.hidden = true; return; }
  host.hidden = false;
  box.textContent = '';
  const samples = parseHistory(h.raw);
  if (!samples.length) {
    box.append(el('p', 'hint', 'No samples yet: the first comes a minute after boot.'));
    return;
  }
  const nowUp = Number.isFinite(h.up) ? h.up : samples[samples.length - 1].up;
  const from = nowUp - WINDOW_S;
  const x = (up) => Math.max(0, Math.min(W, ((up - from) / WINDOW_S) * W)).toFixed(1);
  const { pts, marks } = series(samples);

  /* The ONU state strip: one cell a sample, as wide as a minute. */
  const strip = svgEl('svg', { viewBox: `0 0 ${W} 8`, preserveAspectRatio: 'none', class: 'h-strip' });
  strip.setAttribute('aria-hidden', 'true');
  const cell = (60 / WINDOW_S) * W;
  for (const p of pts) {
    if (p.up < from) continue;
    const cls = p.st === 5 ? 'h-ok' : p.st === undefined ? 'h-unk' : 'h-bad';
    strip.append(svgEl('rect', { x: (x(p.up) - cell).toFixed(1), y: 0, width: cell.toFixed(1), height: 8, class: cls }));
  }
  const shead = el('div', 'h-head');
  const lastSt = samples[samples.length - 1].st;
  shead.append(el('span', 'h-name', 'ONU state'), el('span', 'h-now', STATES[lastSt] || '\u2014'));
  const sbox = el('div', 'h-chart');
  sbox.append(shead, strip);
  box.append(sbox);

  for (const spec of CHARTS) box.append(chart(spec, pts, marks, x));

  const axis = el('div', 'h-axis');
  const tLast = samples[samples.length - 1].t;
  const at = (ago) => {
    const c = clock(tLast !== undefined ? tLast - (samples[samples.length - 1].up - (nowUp - ago)) : 0);
    return c || (ago ? `\u2212${ago / 60} min` : 'now');
  };
  axis.append(el('span', null, at(WINDOW_S)), el('span', null, at(WINDOW_S / 2)), el('span', null, at(0)));
  box.append(axis);

  const shown = marks.filter((m) => m.up >= from);
  if (shown.length) {
    const list = el('ul', 'h-marks');
    for (const m of shown.slice(-12)) {
      const when = clock(m.t) || `${Math.round((nowUp - m.up) / 60)} min ago`;
      list.append(el('li', m.bad ? 'bad' : null, `${when}: ${m.text}`));
    }
    box.append(list);
  }
}

export { renderHistory, parseHistory, series };
