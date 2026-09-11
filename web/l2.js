/*
 * The switch's learned MAC addresses.
 *
 * The Forwarding counters above say whether frames cross. This says which side
 * each address was learned on, which is the difference between "the stick is
 * passing traffic" and "something is talking to the stick". A host that only
 * ever appears on port 0 is talking to the LAN side and never reaching the
 * fibre.
 *
 * Parsed by finding MAC-shaped lines and splitting on whitespace against the
 * header above them, rather than by column position. diag prints this table in
 * several widths -- there are four different header lines in the binary,
 * depending on which variant of the lookup you ask for -- and a positional
 * parse would silently mis-label the columns for any of them.
 */

import { $, el, get } from './dom.js';

const MAC = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

/*
 * Port numbers come from the same switch the Forwarding section reads: port 2
 * faces the fibre, port 0 faces the SFP host. Named rather than numbered
 * because "learned on 2" means nothing to a reader and "fibre" means
 * everything.
 */
const PORTS = { 0: 'host', 2: 'fibre' };

function parseL2(text) {
  const lines = String(text || '').split('\n');
  const rows = [];
  let header = null;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '').trim();

    if (!line) continue;
    if (/^MACAddress\b/.test(line)) { header = line.split(/\s+/); continue; }

    const fields = line.split(/\s+/);
    if (!MAC.test(fields[0])) continue;

    const row = {};
    /* Zip against whichever header was most recently seen. A row with more
       fields than its header keeps the extras under their index, so nothing is
       dropped just because this variant was not anticipated. */
    fields.forEach((v, i) => { row[(header && header[i]) || String(i)] = v; });
    rows.push(row);
  }
  return rows;
}

async function renderL2() {
  const host = $('#l2');

  host.textContent = 'Reading…';
  let d;
  try { d = await get('/api/l2'); } catch (e) { host.textContent = String(e.message || e); return; }
  host.textContent = '';

  if (d.error) { host.append(el('p', 'me-note bad', d.error)); return; }

  const rows = parseL2(d.raw);
  if (!rows.length) {
    host.append(el('p', 'hint', 'The switch has not learned any addresses. On a '
      + 'stick carrying traffic that is a finding in itself.'));
  } else {
    const t = el('table');
    const head = el('tr');
    for (const h of ['MAC address', 'Learned on', 'VLAN', 'Age', 'State'])
      head.append(el('th', null, h));
    t.append(head);

    for (const r of rows) {
      const tr = el('tr');
      const spa = r.Spa;

      tr.append(el('td', 'mono', r.MACAddress));
      tr.append(el('td', null, spa === undefined ? '—'
        : (PORTS[spa] ? `${PORTS[spa]} (port ${spa})` : 'port ' + spa)));
      tr.append(el('td', 'mono', r.Vid ?? '—'));
      tr.append(el('td', 'mono', r.Age ?? '—'));
      tr.append(el('td', null, r.State ?? '—'));
      t.append(tr);
    }
    host.append(t);
    host.append(el('p', 'hint', rows.length + ' address'
      + (rows.length === 1 ? '' : 'es') + ' learned. Addresses seen only on the '
      + 'host side never reached the fibre.'));
  }

  if (d.truncated)
    host.append(el('p', 'me-note bad', 'The table was longer than the daemon '
      + 'will hold; this is the start of it.'));

  const det = el('details');
  det.append(el('summary', '', 'Raw output'));
  det.append(el('pre', '', d.raw || '(no output)'));
  host.append(det);
}

export { parseL2, renderL2 };
