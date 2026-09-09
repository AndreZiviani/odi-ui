/*
 * The whole UI. It renders from /api/schema, so a new config key appears here
 * without touching this file or the daemon.
 *
 * The device parses nothing it does not have to: /api/status returns diag's raw
 * output and the splitting happens below, which means adding a status field
 * costs no C and no reflash.
 */
'use strict';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

function fail(e) {
  const box = $('#err');
  box.textContent = String(e && e.message ? e.message : e);
  box.hidden = false;
}

async function get(path) {
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) throw new Error(path + ' -> HTTP ' + r.status);
  return r.json();
}

/* --- status ------------------------------------------------------------- */

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

function card(k, v, cls) {
  const c = el('div', 'card' + (cls ? ' ' + cls : ''));
  c.append(el('div', 'k', k), el('div', 'v', v === null || v === undefined ? '--' : v));
  return c;
}

function renderStatus(raw) {
  const s = sections(raw);
  $('#raw').textContent = raw;

  const onu = num(s['gpon get onu-state'], /Operation State\((O\d)\)/);
  const alarms = (s['gpon get alarm-status'] || '')
    .split('\n').filter((l) => /Alarm /.test(l));
  const asserted = alarms.filter((l) => !/clear/i.test(l));

  const cards = $('#statuscards');
  cards.textContent = '';
  cards.append(
    card('ONU state', onu, onu === 'O5' ? 'good' : 'bad'),
    card('Alarms', alarms.length ? (asserted.length || 'all clear') : null,
         asserted.length ? 'bad' : 'good'),
    card('Rx power', fmt(s, 'rx-power', 'dBm')),
    card('Tx power', fmt(s, 'tx-power', 'dBm')),
    card('Temperature', fmt(s, 'temperature', 'C')),
    card('Voltage', fmt(s, 'voltage', 'V')),
  );

  renderPorts(s['mib dump counter port all'] || '');
}

function fmt(s, key, unit) {
  const v = num(s['pon get transceiver ' + key], /:\s*(-?\d+\.\d+)/);
  return v === null ? null : (+v).toFixed(2) + ' ' + unit;
}

/* The counters worth showing: enough to answer "is it forwarding", not all 46. */
const SHOW = [
  ['ifInOctets', 'Rx octets'], ['ifOutOctets', 'Tx octets'],
  ['ifInUcastPkts', 'Rx unicast'], ['ifOutUcastPkts', 'Tx unicast'],
  ['dot1dTpPortInDiscards', 'Rx discards'], ['etherStatsCRCAlignErrors', 'CRC errors'],
];

function renderPorts(text) {
  const ports = {};
  let cur = null;
  for (const line of text.split('\n')) {
    const p = /^Port:\s*(\d+)/.exec(line);
    if (p) { cur = p[1]; ports[cur] = {}; continue; }
    const kv = /^(\w+)\s*:\s*(\d+)\s*$/.exec(line);
    if (kv && cur !== null) ports[cur][kv[1]] = kv[2];
  }
  const ids = Object.keys(ports);
  const t = el('table');
  const head = el('tr');
  head.append(el('th', null, 'Counter'));
  for (const id of ids) head.append(el('th', null, 'Port ' + id + (id === '2' ? ' (PON)' : '')));
  t.append(head);
  for (const [key, label] of SHOW) {
    const tr = el('tr');
    tr.append(el('td', null, label));
    for (const id of ids) tr.append(el('td', 'num', Number(ports[id][key] || 0).toLocaleString()));
    t.append(tr);
  }
  const box = $('#ports');
  box.textContent = '';
  box.append(t);
}

/* --- config ------------------------------------------------------------- */

let SCHEMA = [], VALUES = {};

function renderConfig(filter) {
  const host = $('#sections');
  host.textContent = '';
  const f = (filter || '').toLowerCase();
  const bySection = {};

  for (const row of SCHEMA) {
    if (f && !(row.name.toLowerCase().includes(f) || row.section.includes(f))) continue;
    (bySection[row.section] ||= []).push(row);
  }

  for (const name of Object.keys(bySection).sort()) {
    host.append(el('h2', null, name));
    const t = el('table');
    const head = el('tr');
    for (const h of ['Key', 'Value', 'Type', 'Apply']) head.append(el('th', null, h));
    t.append(head);
    for (const row of bySection[name]) {
      const tr = el('tr');
      const k = el('td');
      k.append(el('span', 'key', row.name));
      if (row.writable === 'never') k.append(el('span', 'tag never', 'never'));
      if (row.writable === 'identity') k.append(el('span', 'tag identity', 'identity'));
      if (row.apply === 'restart:omci') k.append(el('span', 'tag omci', 'no reboot'));
      tr.append(k);
      const v = VALUES[row.name];
      tr.append(el('td', null, v === undefined ? '—' : (v === '' ? '(empty)' : v)));
      tr.append(el('td', null, row.type));
      tr.append(el('td', null, row.apply === 'unknown' ? '—' : row.apply));
      t.append(tr);
    }
    host.append(t);
  }
}

/* --- wiring ------------------------------------------------------------- */

for (const b of document.querySelectorAll('nav button')) {
  b.onclick = () => {
    for (const o of document.querySelectorAll('nav button')) o.classList.toggle('on', o === b);
    $('#status').hidden = b.dataset.tab !== 'status';
    $('#config').hidden = b.dataset.tab !== 'config';
  };
}
$('#filter').oninput = (e) => renderConfig(e.target.value);

async function refresh() {
  try {
    const st = await get('/api/status');
    if (st.error) throw new Error(st.error);
    renderStatus(st.raw);
  } catch (e) { fail(e); }
}

(async function init() {
  try {
    [SCHEMA, VALUES] = await Promise.all([get('/api/schema'), get('/api/values')]);
    renderConfig('');
  } catch (e) { fail(e); }
  await refresh();
  /* A scrape is three forks of ~35 ms each on a ~300 BogoMIPS core, so this is
     deliberately unhurried. */
  setInterval(refresh, 15000);
})();
