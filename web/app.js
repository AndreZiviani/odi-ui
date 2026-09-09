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

const bytes = (n) => {
  n = Number(n || 0);
  const u = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return (i ? n.toFixed(n < 10 ? 2 : 1) : String(n)) + ' ' + u[i];
};

/*
 * Port 2 faces the fibre and port 0 the host, established by correlating their
 * deltas on two different lines. Facing them at each other makes the mirror —
 * what one receives, the other sends — the thing you read first, because that
 * is the actual test for whether the stick is forwarding.
 *
 * THROUGHPUT, not totals. omci_app clears port 0's counters at every OMCI
 * performance-monitoring interval while port 2's run free, so their cumulative
 * figures diverge by orders of magnitude — 14 GB against 58 MB on a stick that
 * is forwarding perfectly. Side by side that reads as a fault. The rates
 * between polls do mirror, which is the thing actually worth showing.
 *
 * A negative delta means the counter was reset between polls, so that sample is
 * dropped rather than rendered as a spike.
 */
let PREV = null;
function renderFlow(text) {
  const ports = {};
  let cur = null;
  for (const line of text.split('\n')) {
    const p = /^Port:\s*(\d+)/.exec(line);
    if (p) { cur = p[1]; ports[cur] = {}; continue; }
    const kv = /^(\w+)\s*:\s*(\d+)\s*$/.exec(line);
    if (kv && cur !== null) ports[cur][kv[1]] = kv[2];
  }
  const now = Date.now();
  const rate = (id, k) => {
    /* Both sides need the `|| {}`. side() had it and this did not, so a poll
       that reported one port and not the other — a truncated counter dump, or
       a diag hiccup — threw a TypeError out of renderStatus, and the whole
       status page froze on the previous sample while the timer kept retrying
       the same throw every 15 seconds. */
    if (!PREV || !PREV.ports[id] || !ports[id]) return null;
    const dt = (now - PREV.at) / 1000;
    if (dt < 1) return null;
    const d = Number(ports[id][k] || 0) - Number(PREV.ports[id][k] || 0);
    return d < 0 ? null : d / dt;    /* negative means the counter was reset */
  };

  const side = (id, role, cls) => {
    const d = el('div', 'side' + (cls ? ' ' + cls : ''));
    d.append(el('div', 'role', role), el('div', 'port', 'Port ' + id));
    const dl = el('dl');
    const p = ports[id] || {};
    for (const [k, label] of [['ifInOctets', 'in'], ['ifOutOctets', 'out']]) {
      const r = rate(id, k);
      dl.append(el('dt', null, label),
                el('dd', null, r === null ? 'measuring' : bytes(r) + '/s'));
    }
    dl.append(el('dt', null, 'dropped'),
              el('dd', null, Number(p.dot1dTpPortInDiscards || 0).toLocaleString()));
    d.append(dl);
    return d;
  };

  const host = $('#flow');
  host.textContent = '';
  if (!Object.keys(ports).length) {
    host.append(el('p', 'hint', 'No counters reported.'));
    PREV = null;
    return;
  }
  host.append(side('2', 'Fibre'), el('div', 'mirror', '⇄'), side('0', 'Host', 'right'));
  PREV = { at: now, ports };
}

/* --- config ------------------------------------------------------------- */

let SCHEMA = [], VALUES = {}, META = {}, CONS = {}, DEFAULTS = {}, BASELINE = {};

/*
 * Where a value came from.
 *
 * The image ships only ten defaults in /etc/config_default*.xml; the rest are
 * built into the MIB with no read-only way to read them out. So a key is judged
 * against the image default where one exists, and otherwise against a baseline
 * captured from a stick considered correct. Anything with neither reference is
 * left unlabelled rather than guessed at.
 */
function provenance(row, raw) {
  const name = row.name;
  if (name in DEFAULTS) {
    return raw === DEFAULTS[name]
      ? { cls: 'default', label: 'image default' }
      : { cls: 'changed', label: 'changed', was: DEFAULTS[name], from: 'image default' };
  }
  if (name in BASELINE) {
    return raw === BASELINE[name]
      ? null
      : { cls: 'changed', label: 'changed', was: BASELINE[name], from: 'baseline' };
  }
  return null;
}

/* The apply class, preferring the derived one over the schema's. */
function applyOf(row) {
  return (CONS[row.name] || {}).apply || row.apply || 'unknown';
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
 * Everything wrong with a value, in one place, so the field marking and the
 * Save gate cannot disagree about what is acceptable.
 *
 * These checks mirror the daemon's rather than replacing them — anything
 * reachable over HTTP is validated there too, since a request need not come
 * from this page. What they buy is telling the user before the write instead of
 * after it.
 */
function valueProblem(row, raw) {
  if (raw === '' || raw === undefined) {
    return 'cannot be empty \u2014 flash set refuses to clear a key';
  }
  if (row.type === 'int' && !/^\d+$/.test(raw)) return 'must be a whole number';
  if (row.type === 'ipv4') {
    const oct = raw.split('.');
    if (oct.length !== 4 || !oct.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)) {
      return 'must be four numbers 0\u2013255 separated by dots';
    }
  }
  if (row.type === 'mac' && !/^[0-9a-fA-F]{12}$/.test(raw)) {
    return 'must be 12 hex digits, no separators';
  }
  if (row.type === 'hex32' && !/^[0-9a-fA-F]{32}$/.test(raw)) {
    return 'must be 32 hex digits';
  }
  if (row.type === 'hexascii' && !/^([0-9a-fA-F]{2})+$/.test(raw)) {
    return 'must be hex, a whole number of bytes';
  }

  const m = META[row.name];
  if (m && m.options) {
    const allowed = m.options.split('|').map((p) => p.slice(0, p.indexOf('=')));
    if (!allowed.includes(raw)) return 'not one of: ' + allowed.join(', ');
  }
  return rangeBad(row, raw);
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

  /* What to PUT IN THE FIELD: the pending edit if there is one, otherwise the
     device value. `raw` stays the comparison baseline throughout.

     Keeping edits in a Map outside the DOM is what lets a tab switch or a
     filter keystroke rebuild the table without losing them — but only if the
     rebuild reads the Map back. It did not: renderConfig repopulated every
     field from VALUES, so a typed change vanished from the screen while the
     bar still counted it and Save still wrote it. A value the user cannot see
     is a value they cannot check. */
  const shown = EDITS.has(row.name) ? EDITS.get(row.name) : raw;

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
    if (shown !== raw && ![...input.options].some((o) => o.value === shown)) {
      const o = el('option', null, shown);
      o.value = shown;
      input.append(o);
    }
    input.value = shown;
  } else {
    input = el('input');
    input.type = 'text';
    input.value = shown === undefined ? '' : shown;
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
  input.classList.toggle('changed', shown !== raw);
  validateInput(row, input);
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
  /* Only mark what the user is actually proposing. A value the device already
     holds that falls outside its option list is shown as it is, not scolded. */
  const bad = EDITS.has(row.name) ? valueProblem(row, input.value) : null;
  input.classList.toggle('invalid', !!bad);
  input.title = bad || '';
  return !bad;
}

/* Every queued edit that the daemon would refuse, as [name, why] pairs. */
function invalidEdits() {
  const out = [];
  for (const [name, v] of EDITS) {
    const row = SCHEMA.find((r) => r.name === name);
    const why = row && valueProblem(row, v);
    if (why) out.push([name, why]);
  }
  return out;
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
    for (const h of ['Setting', 'Value', 'What it does']) head.append(el('th', null, h));
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
      const prov = provenance(row, VALUES[row.name]);
      if (prov) {
        const t = el('span', 'tag ' + prov.cls, prov.label);
        if (prov.was !== undefined) {
          t.title = `${prov.from}: ${prov.was === '' ? '(empty)' : prov.was}`;
        }
        k.append(t);
      }
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
      if (prov && prov.was !== undefined) {
        info.append(el('div', 'opts',
          `${prov.from} was ${prov.was === '' ? '(empty)' : prov.was}`));
      }
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
  /* Disabled rather than failing on click: the field is already marked, and a
     Save button that does nothing is worse than one that says it cannot. */
  const bad = invalidEdits();
  $('#save').disabled = bad.length > 0;
  $('#save').title = bad.length
    ? bad.map(([k, w]) => `${k}: ${w}`).join('\n') : '';
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

  /* The red marking on a field used to be the only consequence of an invalid
     value: save() never consulted it and POSTed anyway. The daemon rejects
     these too, but saying so here means the whole batch is not sent to find
     out. */
  const bad = invalidEdits();
  if (bad.length) {
    for (const [name, why] of bad) {
      out.append(el('div', 'bad', `${name}: ${why}`));
    }
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
      /* Two different statements, and the daemon now distinguishes them: a key
         known to be read only at boot, versus a key nothing in the image was
         seen reading at all. 159 of the 184 are the second kind, so collapsing
         them into one sentence made the confident case sound like a guess. */
      out.append(el('div', 'warn', res.untraced
        ? 'Nothing in the image was seen reading these keys, so assume a ' +
          'reboot is needed. Nothing here reboots the stick for you.'
        : 'These keys are read at boot, so a reboot is needed for them to ' +
          'take effect. Nothing here reboots the stick for you.'));
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

/* --- firmware ----------------------------------------------------------- */

async function renderFirmware() {
  const host = $('#parts');
  host.textContent = '';
  let fw;
  try {
    fw = await get('/api/firmware');
  } catch (e) { fail(e); return; }

  const env = fw.env || {};
  const committed = env.sw_commit;
  const booted = env.sw_active;
  const pending = env.sw_tryactive;

  const t = el('table');
  const head = el('tr');
  for (const h of ['Partition', 'Version', 'State']) head.append(el('th', null, h));
  t.append(head);

  for (const p of ['0', '1']) {
    const tr = el('tr');
    tr.append(el('td', null, 'Partition ' + p));
    tr.append(el('td', null, env['sw_version' + p] || 'empty'));

    const st = el('td');
    if (p === committed) st.append(el('span', 'tag omci', 'kept'));
    if (p === booted) st.append(el('span', 'tag', 'booted'));
    if (p === pending && pending !== '2') st.append(el('span', 'tag identity', 'trial pending'));

    const acts = el('div');
    if (p !== committed) {
      const b = el('button', 'fwbtn', 'Try partition ' + p);
      b.onclick = () => fwAction('try', p,
        `Partition ${p} will boot once. If it fails, the stick returns to partition ${committed} on its own.`);
      acts.append(b);
    }
    if (p !== committed && p === booted) {
      const b = el('button', 'fwbtn', 'Keep partition ' + p);
      b.onclick = () => fwAction('commit', p,
        `Partition ${p} becomes the one the stick boots from now on.`);
      acts.append(b);
    }
    st.append(acts);
    tr.append(st);
    t.append(tr);
  }
  host.append(t);

  /* Spell the commands out with this stick's own address and the partition it
     is not running, so they can be pasted without being adapted. */
  const other = booted === '0' ? '1' : '0';
  $('#upload').textContent = [
    '# on your machine, in ~/git/odi-sandbox',
    'make image                     # -> firmware/out/*.tar',
    '',
    'IMG=firmware/out/<image>.tar',
    `cat "$IMG" | ssh admin@${location.hostname} 'cat > /tmp/img.tar'`,
    `md5 -q "$IMG"; ssh admin@${location.hostname} 'md5sum /tmp/img.tar'`,
    '',
    `# writes partition ${other}, the one this stick is not running`,
    `ssh admin@${location.hostname} '/etc/scripts/fwu_starter.sh ${other} /tmp/img.tar'`,
  ].join('\n');

  const foot = el('p', 'hint');
  /* Which confd is answering, not which one the image shipped. A binary at
     /etc/config/confd/confd overrides the image's copy and survives reflashing,
     so the two drift apart silently; reporting the build makes that a question
     you can ask rather than one you have to go and look. */
  foot.textContent = 'Running ' + (fw.running || 'unknown') +
    ' from partition ' + (booted === undefined ? '?' : booted) +
    '. Config UI build ' + (fw.confd || 'unknown') + '.';
  host.append(foot);

  if (fw.mem) $('#memtotal').textContent = fw.mem;

  const rb = el('button', 'fwbtn danger', 'Reboot now');
  rb.onclick = () => fwAction('reboot', '',
    'The stick reboots. It will be unreachable for about a minute.');
  host.append(rb);
}

async function fwAction(action, partition, warning) {
  const out = $('#fwout');
  out.textContent = '';
  if (!confirm(warning + '\n\nContinue?')) return;
  try {
    const r = await fetch('/api/firmware', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=' + action + '&partition=' + encodeURIComponent(partition),
    });
    const res = await r.json();
    if (!res.ok) { out.append(el('div', 'bad', res.error || 'failed')); return; }

    if (action === 'try') {
      out.append(el('div', 'warn',
        `Partition ${partition} is armed for one boot. Reboot to try it; if it ` +
        `does not come up the stick returns here on its own.`));
    } else if (action === 'commit') {
      out.append(el('div', 'good', `Partition ${partition} is now the one it boots.`));
    } else {
      out.append(el('div', 'warn', 'Rebooting. This page will stop responding.'));
    }
    if (action !== 'reboot') await renderFirmware();
  } catch (e) {
    out.append(el('div', 'bad', String(e.message || e)));
  }
}

/* --- wiring ------------------------------------------------------------- */

const TABS = ['status', 'config', 'advanced', 'firmware'];
for (const b of document.querySelectorAll('nav button')) {
  b.onclick = () => {
    for (const o of document.querySelectorAll('nav button')) o.classList.toggle('on', o === b);
    for (const t of TABS) $('#' + t).hidden = b.dataset.tab !== t;
    if (b.dataset.tab === 'firmware') renderFirmware();
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
    let metaRows, consRows, baseRows;
    [SCHEMA, VALUES, metaRows, consRows, DEFAULTS, baseRows] = await Promise.all([
      get('/api/schema'), get('/api/values'), get('/api/meta'),
      get('/api/consumers'), get('/api/defaults'), get('/api/baseline'),
    ]);
    for (const m of metaRows) META[m.name] = m;
    for (const c of consRows) CONS[c.name] = c;
    for (const b of baseRows) BASELINE[b.name] = b.value;
    renderAll();
  } catch (e) { fail(e); }
  await refresh();
  /* A scrape is three forks of ~35 ms each on a ~300 BogoMIPS core, so this is
     deliberately unhurried. */
  setInterval(refresh, 15000);
})();
