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

let SCHEMA = [], VALUES = {}, META = {}, CONS = {};

/* The apply class, preferring the derived one over the schema's. */
function applyOf(row) {
  return (CONS[row.name] || {}).apply || row.apply || 'unknown';
}

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

/* Pending edits, keyed by name. Kept out of the DOM so switching tabs or
   re-filtering cannot silently drop a change the user has typed. */
const EDITS = new Map();

function renderValue(row, raw) {
  const td = el('td');
  const meta = META[row.name] || {};

  /* Never-writable keys get no control at all. The refusal is enforced in the
     daemon twice over, but not offering the field is the honest presentation. */
  if (row.writable === 'never') {
    td.append(el('span', null, raw === '' ? '(empty)' : raw));
    return td;
  }

  let input;
  if (meta.options) {
    input = el('select');
    for (const pair of meta.options.split('|')) {
      const eq = pair.indexOf('=');
      const o = el('option', null, pair.slice(eq + 1));
      o.value = pair.slice(0, eq);
      input.append(o);
    }
    /* A value the device holds that is not in the option list must still be
       selectable, or opening the page would silently propose changing it. */
    if (![...input.options].some((o) => o.value === raw)) {
      const o = el('option', null, raw + ' (current, not a listed value)');
      o.value = raw;
      input.append(o);
    }
    input.value = raw;
  } else {
    input = el('input');
    input.type = 'text';
    input.value = raw === undefined ? '' : raw;
    input.spellcheck = false;
    if (row.type === 'int') input.inputMode = 'numeric';
  }
  input.dataset.name = row.name;
  input.oninput = input.onchange = () => {
    const v = input.value;
    if (v === raw) EDITS.delete(row.name); else EDITS.set(row.name, v);
    input.classList.toggle('changed', v !== raw);
    validateInput(row, input);
    refreshSaveBar();
  };
  td.append(input);

  /* PLOAM and friends store the hex of an ASCII string; show the readable form
     beside the field it is stored in. */
  if (row.type === 'hexascii') {
    const txt = hexAscii(raw);
    td.append(el('div', 'aside', txt === null ? 'not printable ASCII' : 'ASCII: ' + txt));
  }
  return td;
}

function validateInput(row, input) {
  const bad = rangeBad(row, input.value);
  input.classList.toggle('invalid', !!bad);
  input.title = bad || '';
  return !bad;
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
      const ap = applyOf(row);
      if (ap === 'restart:omci') k.append(el('span', 'tag omci', 'no reboot'));
      if (ap === 'reboot') k.append(el('span', 'tag identity', 'needs reboot'));
      if (meta.range) k.append(el('span', 'tag', meta.range));
      tr.append(k);

      tr.append(renderValue(row, VALUES[row.name]));

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
      /* Who reads the key. Useful even where the timing is unknown, and it is
         what the apply class was derived from. */
      const rd = (CONS[row.name] || {}).readers;
      if (rd) info.append(el('div', 'opts', 'Read by: ' + rd.split(',').join(', ')));
      tr.append(info);
      t.append(tr);
    }
    host.append(t);
  }
}

/* --- saving ------------------------------------------------------------- */

function refreshSaveBar() {
  const bar = $('#savebar');
  const n = EDITS.size;
  bar.hidden = n === 0;
  $('#savecount').textContent = n === 1 ? '1 change' : n + ' changes';
  const identity = [...EDITS.keys()].filter(
    (k) => (SCHEMA.find((r) => r.name === k) || {}).writable === 'identity');
  $('#confirmwrap').hidden = identity.length === 0;
  $('#confirmwhat').textContent = identity.join(', ');
}

function encode(pairs) {
  return pairs.map(([k, v]) =>
    encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
}

async function save() {
  const out = $('#saveout');
  out.textContent = '';
  const pairs = [...EDITS.entries()];
  if (!pairs.length) return;

  if (!$('#confirmwrap').hidden && !$('#confirm').checked) {
    out.append(el('div', 'bad', 'Identity keys need the confirmation ticked.'));
    return;
  }
  if ($('#confirm').checked) pairs.push(['_confirm', 'identity']);

  $('#save').disabled = true;
  try {
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: encode(pairs),
    });
    if (r.status === 401) { location.href = '/'; return; }
    const res = await r.json();

    for (const item of res.results || []) {
      const line = el('div', item.ok ? 'good' : 'bad');
      line.textContent = item.ok
        ? `${item.name} = ${item.value}`
        : `${item.name}: ${item.error}`;
      out.append(line);
      if (item.ok) EDITS.delete(item.name);
    }

    /* Nothing is applied implicitly: a write on this device does nothing until
       omci_app restarts or the stick reboots, so say which and let the user
       choose. */
    if (res.apply === 'restart:omci') {
      const b = el('button', 'apply', 'Apply now (restarts OMCI, ~6s, no reboot)');
      b.onclick = doApply;
      out.append(b);
    } else if (res.apply === 'reboot') {
      out.append(el('div', 'warn',
        'These keys have no traced consumer, so assume a reboot is needed for ' +
        'them to take effect. Nothing here reboots the stick for you.'));
    }

    VALUES = await get('/api/values');
    renderAll();
  } catch (e) {
    out.append(el('div', 'bad', String(e.message || e)));
  } finally {
    $('#save').disabled = false;
    refreshSaveBar();
  }
}

async function doApply(ev) {
  const out = $('#saveout');
  ev.target.disabled = true;
  ev.target.textContent = 'Restarting OMCI…';
  try {
    const r = await fetch('/api/apply', { method: 'POST' });
    const res = await r.json();
    out.append(el('div', res.applied ? 'good' : 'bad',
      res.applied ? 'Applied — omci_app restarted and the ONU is re-registering.'
                  : 'Apply failed: ' + (res.error || 'unknown')));
  } catch (e) {
    out.append(el('div', 'bad', String(e.message || e)));
  } finally {
    ev.target.remove();
    await refresh();
  }
}

function renderAll() {
  renderConfig('#common', SCHEMA.filter((r) => r.common === 'yes'), '');
  renderConfig('#sections', SCHEMA, $('#filter').value);
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
$('#save').onclick = save;
$('#discard').onclick = () => { EDITS.clear(); renderAll(); refreshSaveBar(); $('#saveout').textContent = ''; };

async function refresh() {
  try {
    const st = await get('/api/status');
    if (st.error) throw new Error(st.error);
    renderStatus(st.raw);
  } catch (e) { fail(e); }
}

(async function init() {
  try {
    let metaRows, consRows;
    [SCHEMA, VALUES, metaRows, consRows] = await Promise.all([
      get('/api/schema'), get('/api/values'), get('/api/meta'), get('/api/consumers'),
    ]);
    for (const m of metaRows) META[m.name] = m;
    for (const c of consRows) CONS[c.name] = c;
    renderAll();
  } catch (e) { fail(e); }
  await refresh();
  /* A scrape is three forks of ~35 ms each on a ~300 BogoMIPS core, so this is
     deliberately unhurried. */
  setInterval(refresh, 15000);
})();
