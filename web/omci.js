/*
 * Reading the OMCI MIB, and turning what omcicli prints into something the two
 * ME pages can render.
 *
 * One parser, two pages. `mebrowser.js` shows the blocks as they came;
 * `services.js` picks a handful apart and says what they mean. Both go through
 * here so there is exactly one place that knows the output shape -- and that
 * shape is not consistent even within one firmware. ME 84 prints `EntityID`,
 * ME 171 prints `EntityId`, and a table's rows are bare lines with no key at
 * all. The parser is deliberately permissive about all of it: an attribute it
 * does not recognise still reaches the page as text, because a MIB dump this
 * daemon cannot label is far more useful than one it drops.
 */

import { get } from './dom.js';

/*
 * omcicli frames each table with rows of X and separates instances with rows of
 * =. Both are decoration; neither carries data.
 */
const isBanner = (l) => /^X{3,}\s*$/.test(l);
const isRule = (l) => /^={3,}\s*$/.test(l);

/*
 * Parse one `omcicli mib get` dump.
 *
 * Returns { name, instances: [ { id, attrs: [[k, v]], groups: [{label, attrs}] } ] }.
 *
 * `name` is the table name omcicli itself printed, and the pages display it
 * rather than the label they asked for. That is the check that keeps a wrong
 * class id from being quietly mislabelled: ask for 84 and the card says
 * whatever came back, so a mismatch is visible instead of assumed away.
 */
function parseOmci(text) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\r$/, ''));
  const instances = [];
  let name = '';
  let cur = null;
  let group = null;

  const flush = () => {
    if (cur && (cur.attrs.length || cur.groups.length)) instances.push(cur);
    cur = null;
    group = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    /* The table name sits between two banner rows, once, at the top. */
    if (isBanner(line)) {
      const next = lines[i + 1];
      if (next && !isBanner(next) && !isRule(next) && isBanner(lines[i + 2] || '')) {
        name = next.trim();
        i += 2;
      }
      continue;
    }
    if (isRule(line)) { flush(); continue; }

    const t = line.trim();
    if (!t) continue;
    if (!cur) { cur = { id: '', attrs: [], groups: [] }; group = null; }

    /*
       An INDENTED line continues the attribute above it rather than starting
       anything. Real dumps do this in at least two places: ME 131 breaks
       `ToDInfo` into tab-indented sub-lines that themselves contain colons,
       and ME 171 follows `DscpToPbitMapping:` with eight indented hex words
       and no colons at all. Treating those as new keys or new sub-tables
       produced eight empty headings and attached the instance's own remaining
       attributes to the last INDEX row.
    */
    if (/^\s/.test(line) && (group ? group.attrs.length : cur.attrs.length)) {
      const into = group ? group.attrs : cur.attrs;
      const last = into[into.length - 1];

      last[1] = last[1] ? last[1] + ' ' + t : t;
      continue;
    }

    const c = t.indexOf(':');
    if (c > 0) {
      const k = t.slice(0, c).trim();
      const v = t.slice(c + 1).trim();
      if (/^entity\s*id$/i.test(k)) cur.id = v;
      (group ? group.attrs : cur.attrs).push([k, v]);
    } else {
      /* A line with no colon opens a sub-table: `ReceivedFrameVlanTaggingOperTable`
         and then one `INDEX n` per row. */
      group = { label: t, attrs: [] };
      cur.groups.push(group);
    }
  }
  flush();
  return { name, instances };
}

/* Case-insensitive attribute lookup, top level only. */
function attr(inst, key) {
  const want = String(key).toLowerCase();
  for (const [k, v] of inst.attrs) if (k.toLowerCase() === want) return v;
  return null;
}

/*
 * Fetch one dump. Never throws for a device-side condition: an ONU that has not
 * registered answers with nothing at all, and "nothing at all" is a finding the
 * pages render, not an error they hide.
 */
async function fetchOmci(params) {
  const qs = new URLSearchParams(params).toString();
  try {
    const r = await get('/api/omci?' + qs);
    return {
      raw: r.raw || '',
      truncated: !!r.truncated,
      ok: r.ok !== false,
      error: r.error || '',
      ...parseOmci(r.raw || ''),
    };
  } catch (e) {
    return { raw: '', truncated: false, ok: false, error: String(e.message || e), name: '', instances: [] };
  }
}

/*
 * Whether a dump means "the MIB service did not answer" rather than "this table
 * is empty".
 *
 * Both failure modes were seen on our own sticks: `omcicli` either prints
 * nothing at all, or prints its registered-table listing instead of the table
 * you asked for. Rendering either as "the OLT has not created any" is the most
 * misleading thing this page could say -- it reads as a provisioning fault on a
 * line that is carrying traffic. See the investigation notes: a long-running
 * omci_app stops servicing the request queue, and restarting it fixes it.
 */
function unavailable(dump) {
  if (!dump.ok) return dump.error || 'the MIB could not be read';
  const raw = String(dump.raw || '');

  if (!raw.trim())
    return 'omcicli returned nothing. The MIB service stops answering on a '
         + 'long-running omci_app; restarting it (/etc/runomci.sh) restores it '
         + 'without touching the line.';
  if (/^TableId\s*\[\d+\]\s*Name:/m.test(raw) && !dump.instances.length)
    return 'omcicli listed its tables instead of reading the one asked for, '
         + 'which is how it fails when omci_app has stopped servicing the '
         + 'request queue. Restarting omci_app (/etc/runomci.sh) restores it.';
  return null;
}

/* One ME, by class id or table name. */
const fetchMe = (me, entity) =>
  fetchOmci(entity ? { cmd: 'me', me, entity } : { cmd: 'me', me });

export { parseOmci, attr, fetchOmci, fetchMe, unavailable };
