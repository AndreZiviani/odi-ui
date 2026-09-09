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

let SCHEMA = [], VALUES = {}, META = {};

/* Show what a stored value actually means: "1 — manual" rather than "1". */
function optionLabel(row, raw) {
  const m = META[row.name];
  if (!m || !m.options) return null;
  for (const pair of m.options.split('|')) {
    const eq = pair.indexOf('=');
    if (eq > 0 && pair.slice(0, eq) === raw) return pair.slice(eq + 1);
  }
  return null;
}

/*
 * Whether a key's `depends` condition holds. The firmware ignores some keys
 * unless others are set a particular way — VLAN_MANU_TAG_VID only reaches
 * omci_app when VLAN_CFG_TYPE=1 and VLAN_MANU_MODE=1, and otherwise a sentinel
 * is sent in its place. Saying so is more useful than showing a value that
 * looks live and is not.
 */
function dependsUnmet(row) {
  const m = META[row.name];
  if (!m || !m.depends) return null;
  const unmet = m.depends.split('&').filter((c) => {
    const [k, v] = c.split('=');
    return VALUES[k] !== v;
  });
  return unmet.length ? unmet : null;
}

function rangeBad(row, raw) {
  const m = META[row.name];
  if (!m || !m.range || raw === '' || raw === undefined) return null;
  const [lo, hi] = m.range.split('-').map(Number);
  const n = Number(raw);
  if (!Number.isFinite(n) || n < lo || n > hi) return `outside ${lo}\u2013${hi}`;
  return null;
}

/*
 * Some keys hold the hex of an ASCII string — GPON_PLOAM_PASSWD keeps
 * "1234567890" as 31323334353637383930. Show the readable form, keeping the hex
 * alongside since that is what the device stores and what you would type back.
 *
 * Driven by the schema type, never sniffed: INT1 holds 2147483647, which is
 * valid hex decoding to '!GH6G', so a heuristic would mangle plain integers.
 * A PLOAM password is 10 arbitrary octets by standard and is not required to be
 * printable, so a value that is not stays hex.
 */
function hexAscii(hex) {
  if (!hex) return null;
  if (hex.length % 2 || /[^0-9a-fA-F]/.test(hex)) return null;
  let out = '';
  for (let i = 0; i < hex.length; i += 2) {
    const c = parseInt(hex.slice(i, i + 2), 16);
    if (c < 0x20 || c > 0x7e) return null;
    out += String.fromCharCode(c);
  }
  return out;
}

function renderValue(row, raw) {
  if (raw === undefined) return el('td', null, '\u2014');
  if (raw === '') return el('td', null, '(empty)');
  if (row.type === 'hexascii') {
    const txt = hexAscii(raw);
    const td = el('td');
    if (txt === null) {
      td.append(el('span', 'key', raw), el('span', 'tag', 'not ascii'));
    } else {
      td.append(el('span', null, txt), el('span', 'tag', raw));
    }
    return td;
  }
  return el('td', null, raw);
}

function renderConfig(hostSel, rows, filter) {
  const host = $(hostSel);
  host.textContent = '';
  const f = (filter || '').toLowerCase();
  const bySection = {};

  for (const row of rows) {
    if (f && !(row.name.toLowerCase().includes(f) || row.section.includes(f))) continue;
    (bySection[row.section] ||= []).push(row);
  }

  for (const name of Object.keys(bySection).sort()) {
    host.append(el('h2', null, name));
    const t = el('table');
    const head = el('tr');
    for (const h of ['Setting', 'Value', 'Notes']) head.append(el('th', null, h));
    t.append(head);
    for (const row of bySection[name]) {
      const meta = META[row.name] || {};
      const tr = el('tr');
      const k = el('td');
      k.append(el('div', 'label', meta.label || row.name));
      k.append(el('div', 'key', row.name));
      if (row.writable === 'never') k.append(el('span', 'tag never', 'never'));
      if (row.writable === 'identity') k.append(el('span', 'tag identity', 'identity'));
      if (row.apply === 'restart:omci') k.append(el('span', 'tag omci', 'no reboot'));
      if (meta.range) k.append(el('span', 'tag', meta.range));
      tr.append(k);

      const vtd = renderValue(row, VALUES[row.name]);
      const opt = optionLabel(row, VALUES[row.name]);
      if (opt) { vtd.textContent = ''; vtd.append(el('span', null, opt)); }
      const bad = rangeBad(row, VALUES[row.name]);
      if (bad) vtd.append(el('span', 'tag never', bad));
      tr.append(vtd);

      const info = el('td', 'info');
      if (meta.help) info.append(el('div', 'help', meta.help));
      const unmet = dependsUnmet(row);
      if (unmet) {
        info.append(el('div', 'unmet',
          'Ignored by the firmware right now \u2014 needs ' + unmet.join(' and ') + '.'));
      }
      if (meta.options) {
        info.append(el('div', 'opts', 'Accepts: ' +
          meta.options.split('|').map((p) => p.slice(0, p.indexOf('='))).join(', ')));
      }
      tr.append(info);
      t.append(tr);
    }
    host.append(t);
  }
}

/* --- wiring ------------------------------------------------------------- */

const TABS = ['status', 'config', 'advanced'];
for (const b of document.querySelectorAll('nav button')) {
  b.onclick = () => {
    for (const o of document.querySelectorAll('nav button')) o.classList.toggle('on', o === b);
    for (const t of TABS) $('#' + t).hidden = b.dataset.tab !== t;
  };
}
$('#filter').oninput = (e) => renderConfig('#sections', SCHEMA, e.target.value);

async function refresh() {
  try {
    const st = await get('/api/status');
    if (st.error) throw new Error(st.error);
    renderStatus(st.raw);
  } catch (e) { fail(e); }
}

(async function init() {
  try {
    let metaRows;
    [SCHEMA, VALUES, metaRows] = await Promise.all([
      get('/api/schema'), get('/api/values'), get('/api/meta'),
    ]);
    for (const m of metaRows) META[m.name] = m;
    /* Config shows the keys provisioning actually uses; Advanced shows all of
       them. The split is a schema flag, so which keys are "common" is a data
       decision and not something baked in here. */
    renderConfig('#common', SCHEMA.filter((r) => r.common === 'yes'), '');
    renderConfig('#sections', SCHEMA, '');
  } catch (e) { fail(e); }
  await refresh();
  /* A scrape is three forks of ~35 ms each on a ~300 BogoMIPS core, so this is
     deliberately unhurried. */
  setInterval(refresh, 15000);
})();
