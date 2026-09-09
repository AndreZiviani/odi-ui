/*
 * The Status tab: optical meters and the registration ladder.
 *
 * The device parses nothing it does not have to -- /api/status returns diag's
 * raw output and the splitting happens here, which means adding a status field
 * costs no C and no reflash.
 */

import { $, el } from './dom.js';
import { renderFlow } from './flow.js';

/* diag echoes each command after its "RTK.0> " prompt, so the reply splits back
 * into per-command sections on that marker. */
function sections(raw) {
  const out = {};
  const parts = raw.split('RTK.0> ');
  for (const p of parts) {
    const nl = p.indexOf('\n');
    if (nl < 0) continue;
    out[p.slice(0, nl).trim()] = p.slice(nl + 1);
  }
  return out;
}

const num = (s, re) => { const m = re.exec(s || ''); return m ? m[1] : null; };

/*
 * Optical power, on a scale.
 *
 * A bare number does not tell you whether -23 dBm is healthy. The window drawn
 * behind the needle is the GPON class B+ range this optics is specified for, so
 * the reading is judged rather than merely reported.
 */
const OPTICS = {
  rx: { name: 'Receive',  lo: -30, hi: -4, winLo: -27, winHi: -8,
        note: 'Class B+ receive window' },
  tx: { name: 'Transmit', lo: -3,  hi: 8,  winLo: 0.5, winHi: 5,
        note: 'Class B+ transmit window' },
};

function meter(hostSel, spec, value) {
  const host = $(hostSel);
  host.textContent = '';
  host.append(el('div', 'name', spec.name));

  const read = el('div', 'read');
  if (value === null) {
    read.classList.add('off');
    read.textContent = 'no reading';
  } else {
    read.append(document.createTextNode(value.toFixed(2)));
    read.append(el('span', 'unit', 'dBm'));
    if (value < spec.winLo || value > spec.winHi) read.classList.add('off');
  }
  host.append(read);

  const pct = (v) => ((v - spec.lo) / (spec.hi - spec.lo)) * 100;
  const scale = el('div', 'scale');
  const track = el('div', 'track');
  const win = el('div', 'window');
  win.style.left = pct(spec.winLo) + '%';
  win.style.width = (pct(spec.winHi) - pct(spec.winLo)) + '%';
  track.append(win);
  if (value !== null) {
    const n = el('div', 'needle');
    n.style.left = Math.max(0, Math.min(100, pct(value))) + '%';
    track.append(n);
  }
  scale.append(track);

  const ends = el('div', 'ends');
  ends.append(el('span', null, spec.lo + ' dBm'), el('span', null, '+' + spec.hi + ' dBm'));
  scale.append(ends, el('div', 'note', spec.note));
  host.append(scale);
}

/* O1 to O5 is a real sequence — an ONU climbs it on every registration — which
   is the one thing on this page worth numbering. */
const STATES = {
  O1: 'Initial', O2: 'Standby', O3: 'Serial number',
  O4: 'Ranging', O5: 'Operational', O6: 'Intermittent', O7: 'Emergency stop',
};

function ladder(state) {
  const host = $('#ladder');
  host.textContent = '';
  const n = state ? Number(state.slice(1)) : 0;
  for (let i = 1; i <= 5; i++) {
    const li = el('li', null, 'O' + i);
    if (i < n) li.classList.add('done');
    if (i === n) li.classList.add('here');
    host.append(li);
  }
  const note = $('#statenote');
  note.classList.toggle('bad', state !== 'O5');
  note.textContent = !state ? 'No state reported.'
    : state === 'O5' ? 'Operational. The line is registered and carrying traffic.'
    : (STATES[state] || state) + ' — not yet operational.';
}
function renderStatus(raw) {
  const s = sections(raw);
  $('#raw').textContent = raw;

  const dbm = (key) => {
    const v = num(s['pon get transceiver ' + key], /:\s*(-?\d+\.\d+)/);
    return v === null ? null : Number(v);
  };
  meter('#rx', OPTICS.rx, dbm('rx-power'));
  meter('#tx', OPTICS.tx, dbm('tx-power'));

  ladder(num(s['gpon get onu-state'], /Operation State\((O\d)\)/));

  const alarms = (s['gpon get alarm-status'] || '').split('\n').filter((l) => /Alarm /.test(l));
  const asserted = alarms.filter((l) => !/clear/i.test(l));
  const stat = (k, v, cls) => {
    const d = el('div');
    d.append(el('span', 'k', k), el('span', 'v' + (cls ? ' ' + cls : ''), v));
    return d;
  };
  const temp = num(s['pon get transceiver temperature'], /:\s*(-?\d+\.\d+)/);
  const volt = num(s['pon get transceiver voltage'], /:\s*(-?\d+\.\d+)/);
  const env = $('#env');
  env.textContent = '';
  env.append(
    stat('Temperature', temp === null ? '—' : Number(temp).toFixed(1) + ' °C'),
    stat('Supply', volt === null ? '—' : Number(volt).toFixed(2) + ' V'),
    stat('Alarms',
         !alarms.length ? '—' : asserted.length ? asserted.length + ' asserted' : 'all clear',
         asserted.length ? 'bad' : (alarms.length ? 'ok' : '')),
  );

  renderFlow(s['mib dump counter port all'] || '');
}

export { renderStatus };
