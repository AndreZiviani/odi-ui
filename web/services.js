/*
 * What the OLT actually built on this ONU, in plain language.
 *
 * The config page shows what we ASKED for. This one shows what the line
 * BUILT -- and when those disagree, the line is right. Nearly every "state is
 * O5 but nothing passes" report on this hardware is settled by two of these
 * tables, so they get sentences rather than a hex dump; the dump is one tab
 * over.
 *
 * The rule this page is written to: never invent a meaning. Where an attribute
 * has an unambiguous reading -- a VLAN id is a VLAN id -- it is spelled out.
 * Where it does not, the value is shown as it came and the reader is pointed at
 * the raw view, because a confident wrong explanation of a MIB attribute is
 * worse than no explanation at all. That is why there is no table of
 * forwarding-operation codes here: the VIDs in the filter answer the question
 * people actually ask, and the operation byte is shown unread.
 */

import { $, el, get } from './dom.js';
import { fetchMe, attr } from './omci.js';

/*
 * The six tables worth a sentence, in the order someone diagnosing a dead link
 * would want them. Class ids, not names: the number form is the one seen
 * working on this firmware in the field. Each card prints the table name that
 * came back, so asking for the wrong id shows up as a wrong name rather than a
 * mislabelled card.
 */
const CARDS = [
  { me: '7',   title: 'Software version the OLT sees',  render: renderSwImage },
  { me: '131', title: 'The OLT at the other end',       render: renderOlt },
  { me: '84',  title: 'VLANs this line allows',         render: renderVlanFilter },
  { me: '171', title: 'VLAN translation',               render: renderExtVlan },
  { me: '262', title: 'Upstream containers (T-CONT)',   render: renderIds },
  { me: '268', title: 'GEM ports',                      render: renderIds },
];

/*
 * Vendor codes are four ASCII characters and the OLT reports them as a 32-bit
 * hex word. Only vendors seen on these threads are named; anything else shows
 * the code, which is still the useful half.
 */
const VENDORS = {
  ALCL: 'Nokia (Alcatel-Lucent)',
  HWTC: 'Huawei',
  ZTEG: 'ZTE',
  FHTT: 'FiberHome',
};

/* `PRI 8,VID 35, TPID 0, EthType 0x00` -> { PRI: '8', VID: '35', ... } */
function fields(v) {
  const out = {};
  for (const part of String(v || '').split(',')) {
    const m = /^\s*(\S+)\s+(\S+)\s*$/.exec(part);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/*
 * G.988 fills unused filter fields with the maximum the field can hold: a VLAN
 * id is 12 bits, so 4096 cannot be one and means "do not filter on this"; a
 * priority is 3 bits, so 15 means the same. Both are printed by the firmware as
 * ordinary numbers, and reading them as real values is how a rule that matches
 * everything gets described as a rule that matches VLAN 4096.
 */
const vidText = (v) => (v === '4096' ? 'any' : v);
const priText = (v) => (v === '15' ? 'any' : v);

const hexToAscii = (h) => {
  const s = String(h || '').replace(/^0x/i, '');
  let out = '';
  for (let i = 0; i + 1 < s.length; i += 2) {
    const c = parseInt(s.slice(i, i + 2), 16);
    if (c < 0x20 || c > 0x7e) return '';
    out += String.fromCharCode(c);
  }
  return out;
};

function note(text, cls) {
  return el('p', 'me-note' + (cls ? ' ' + cls : ''), text);
}

/* --- the six renderers --------------------------------------------------- */

/*
 * What the stick believes its versions are, from the U-Boot environment. Read
 * alongside the MIB so the software-image card can compare the two: ME 7 is
 * what the OLT was TOLD, and these are what the partitions actually hold.
 */
let ENV = {};

function renderSwImage(box, dump) {
  const dl = el('dl', 'me-kv');
  for (const inst of dump.instances) {
    const ver = attr(inst, 'Version') || '(empty)';
    const act = attr(inst, 'IsActive');
    const com = attr(inst, 'IsCommitted');
    const tags = [];
    if (act === '1') tags.push('running');
    if (com === '1') tags.push('kept');
    dl.append(el('dt', '', 'Image ' + (inst.id || '?')),
              el('dd', '', ver + (tags.length ? '  — ' + tags.join(', ') : '')));
  }
  box.append(dl);
  box.append(note('This is the version string your ISP sees, and the only one '
    + 'they see. It comes from the image, not from this page — so if it has to '
    + 'keep matching the ONU you replaced, check it here after every flash.'));

  /*
   * The comparison that makes this card worth having. ME 7 is what the OLT was
   * told; sw_version<n> is what the partition holds. On this base they are
   * connected by chk_swver_fix.sh, which runs at boot and only when
   * OMCI_OLT_MODE is neither 0 nor 21 -- so a difference is usually not a fault
   * but that script deliberately standing down, and saying which is the whole
   * point. "My OMCI software version resets at every boot" is the most-asked
   * question about this device (Anime4000/RTL960x#30) and it is the same
   * mechanism read from the other end.
   */
  const active = ENV.sw_active;
  const held = ENV['sw_custom_version' + active] || ENV['sw_version' + active];
  const told = dump.instances.map((i) => attr(i, 'Version')).filter(Boolean);

  if (!held || !told.length) return;
  if (told.some((v) => v === held)) {
    box.append(note('Matches what partition ' + active + ' holds.'));
    return;
  }
  box.append(note('Partition ' + active + ' holds “' + held + '”, which is not '
    + 'what the OLT was told. That is normal when OMCI_OLT_MODE is 0 or 21: '
    + 'chk_swver_fix.sh stands down and OMCI_SW_VER keeps whatever is stored. '
    + 'Set sw_custom_version' + active + ' in the U-Boot environment to choose '
    + 'the reported string outright — it survives reflashing, and it is the '
    + 'answer to a version that resets at every boot.'));
}

function renderOlt(box, dump) {
  const inst = dump.instances[0];
  const hex = inst ? attr(inst, 'OltVendorId') : null;
  const code = hexToAscii(hex);
  const dl = el('dl', 'me-kv');

  dl.append(el('dt', '', 'Vendor'),
            el('dd', '', code ? (VENDORS[code] ? code + ' — ' + VENDORS[code] : code)
                              : String(hex || 'not reported')));
  if (inst) {
    for (const [k, v] of inst.attrs) {
      if (/^oltvendorid$/i.test(k) || /^entity\s*id$/i.test(k)) continue;
      dl.append(el('dt', '', k), el('dd', '', v));
    }
  }
  box.append(dl);
}

function renderVlanFilter(box, dump) {
  const vids = [];

  for (const inst of dump.instances) {
    for (const [k, v] of inst.attrs) {
      if (!/^FilterTbl\[/i.test(k)) continue;
      const f = fields(v);
      if (f.VID !== undefined) vids.push(f.VID);
    }
  }

  if (!vids.length) {
    box.append(note('No tag filters are installed.'));
    return;
  }

  box.append(el('p', 'me-lead', vids.length === 1
    ? 'The OLT allows one VLAN on this line: ' + vids[0] + '.'
    : 'The OLT allows these VLANs on this line: ' + vids.join(', ') + '.'));
  box.append(note('Tag a VLAN outside that list and the ONU still reaches O5 '
    + 'while the traffic is discarded — which looks exactly like a dead line. '
    + 'The forwarding-operation byte that decides how strict each filter is '
    + 'shows unread in the raw view.'));
}

function renderExtVlan(box, dump) {
  const rules = [];

  for (const inst of dump.instances) {
    for (const g of inst.groups) {
      if (!/^INDEX\b/i.test(g.label)) continue;
      const row = {};
      for (const [k, v] of g.attrs) row[k.toLowerCase()] = fields(v);
      rules.push(row);
    }
  }

  if (!rules.length) {
    box.append(note('No VLAN translation rules are installed — the OLT is not '
      + 'rewriting tags on this line.'));
    return;
  }

  const list = el('div', 'me-rules');
  let translated = null;

  for (const r of rules) {
    const fi = r['filter inner'] || {};
    const ti = r['treatment inner'] || {};
    const from = vidText(fi.VID);
    const to = vidText(ti.VID);
    const line = el('div', 'me-rule');

    line.append(el('span', 'me-from', from === 'any' ? 'any VLAN' : 'VLAN ' + from));
    line.append(el('span', 'me-arrow', '→'));
    line.append(el('span', 'me-to', to === 'any' ? 'unchanged' : 'VLAN ' + to));
    if (fi.PRI && priText(fi.PRI) !== 'any')
      line.append(el('span', 'me-pri', 'priority ' + fi.PRI));
    list.append(line);

    if (from !== 'any' && to !== 'any' && from !== to && translated === null)
      translated = { from, to };
  }
  box.append(list);

  if (translated) {
    box.append(el('p', 'me-lead', 'The OLT expects VLAN ' + translated.to
      + ' on the fibre and calls it VLAN ' + translated.from + ' on your side.'));
    box.append(note('Which of the two your router should tag is the most common '
      + 'thing to get wrong here. An ONU that applies this rule wants '
      + translated.from + '. Users of this Realtek chipset report it does not '
      + 'apply the rule, and that ' + translated.to + ' is what works. If one '
      + 'carries no traffic, try the other.'));
  }
}

/* T-CONTs and GEM ports: what exists, not what each one is set to. */
function renderIds(box, dump) {
  const ids = dump.instances.map((i) => i.id).filter(Boolean);

  if (!ids.length) {
    box.append(note('The OLT has not created any.'));
    return;
  }
  box.append(el('p', 'me-lead', ids.length + ' provisioned: ' + ids.join(', ')));
}

/* --- the page ------------------------------------------------------------ */

let loaded = false;

async function renderServices(force) {
  const host = $('#services-cards');

  if (loaded && !force) return;
  loaded = true;
  host.textContent = '';
  host.append(el('p', 'hint', 'Reading the MIB…'));

  /* Never let the firmware read take the page down: it is context for one
     card, and the other five are worth rendering without it. */
  try { ENV = (await get('/api/firmware')).env || {}; } catch (e) { ENV = {}; }

  const dumps = [];
  for (const c of CARDS) dumps.push(await fetchMe(c.me));

  host.textContent = '';
  for (let i = 0; i < CARDS.length; i++) {
    const c = CARDS[i];
    const dump = dumps[i];
    const card = el('section', 'me-card');

    card.append(el('h3', '', c.title));
    /* The name the device printed, not the one we asked for. */
    card.append(el('p', 'me-src', dump.name
      ? 'ME ' + c.me + ' — ' + dump.name
      : 'ME ' + c.me));

    /* An error and an empty MIB are different findings and read differently:
       one means the daemon could not ask, the other means the OLT provisioned
       nothing -- which on a line sitting in O5 is itself the diagnosis. Each
       renderer says what empty means for its own table. */
    if (!dump.ok && dump.error)
      card.append(note(dump.error, 'bad'));
    else
      c.render(card, dump);

    if (dump.truncated)
      card.append(note('This dump was longer than the daemon will hold; what '
        + 'you see is the start of it.', 'bad'));

    const det = el('details', 'me-raw');
    det.append(el('summary', '', 'Raw'));
    det.append(el('pre', '', dump.raw || '(no output)'));
    card.append(det);

    host.append(card);
  }
}

export { renderServices };
