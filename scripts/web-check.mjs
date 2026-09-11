/*
 * Load the whole module graph and drive it against fixture data.
 *
 * Splitting app.js into modules moved a class of mistake from "obvious" to
 * "silent": a missing export, an import that resolves to undefined, or an
 * import cycle that leaves a binding uninitialised produces a blank page and a
 * console error nobody sees, because the only way to run this page is to flash
 * a stick and open a browser.
 *
 * So: a DOM stub thin enough to be honest about what it is, the repo's own
 * schema files as fixtures, and an assertion that the page renders rows. It
 * does not check layout or CSS -- it checks that the pieces still fit.
 *
 *   node scripts/web-check.mjs        (via make check)
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* --- a DOM, to the depth this page actually uses ------------------------- */
class El {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.attrs = {};
    this.dataset = {}; this.style = {}; this.options = [];
    this._text = ''; this.hidden = false; this.disabled = false;
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      toggle: (c, on) => (on ? this.classList._s.add(c) : this.classList._s.delete(c)),
      contains: (c) => this.classList._s.has(c),
    };
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  append(...n) {
    for (const x of n) {
      this.children.push(x);
      if (this.tagName === 'select' && x.tagName === 'option') this.options.push(x);
    }
  }
  appendChild(n) { this.append(n); }
  setAttribute(k, v) { this.attrs[k] = v; }
  querySelectorAll() { return []; }
  get value() { return this._value ?? ''; }
  set value(v) { this._value = v; }
}

const byId = new Map();
const doc = {
  createElement: (t) => new El(t),
  querySelector: (sel) => {
    if (!byId.has(sel)) byId.set(sel, new El('div'));
    return byId.get(sel);
  },
  querySelectorAll: () => [],
  addEventListener: () => {},
  dispatchEvent: () => true,
};
globalThis.document = doc;
globalThis.Event = class { constructor(t) { this.type = t; } };
globalThis.CustomEvent = globalThis.Event;
globalThis.location = { hostname: 'stick.example', href: '/' };
globalThis.setInterval = () => 0;
globalThis.confirm = () => false;   /* the reset flow asks; nothing here clicks it */
globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };

/* --- fixtures: the repo's own data, shaped as the API returns it --------- */
function tsv(name, cols) {
  const out = [];
  for (const line of readFileSync(join(root, 'schema', name), 'utf8').split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('name\t')) continue;
    const f = line.split('\t');
    out.push(Object.fromEntries(cols.map((c, i) => [c, f[i] ?? ''])));
  }
  return out;
}
const SCHEMA = tsv('keys.tsv', ['name', 'store', 'address', 'section', 'type', 'apply', 'writable', 'common']);
const META = tsv('meta.tsv', ['name', 'label', 'help', 'options', 'depends', 'range']);
const CONS = tsv('consumers.tsv', ['name', 'apply', 'readers']);
const FEAT = tsv('features.tsv', ['mask', 'bit', 'feature', 'module']);
const VALUES = Object.fromEntries(SCHEMA.map((r) => [r.name, '1']));

const API = {
  '/api/schema': SCHEMA, '/api/meta': META, '/api/consumers': CONS,
  '/api/values': VALUES, '/api/defaults': {}, '/api/baseline': [], '/api/features': FEAT,
  '/api/status': { raw: 'RTK.0> gpon get onu-state\n  Operation State(O5)\n' },
  '/api/firmware': {
    running: 'ODI-260910-6861b53', confd: 'test', mem: '26 MB', build: {},
    defaultauth: false,
    env: { sw_active: '0', sw_commit: '0', sw_tryactive: '2',
           sw_version0: 'ODI-260910-6861b53', sw_version1: 'V1.0-220923' },
  },
};

/*
 * The OMCI fixtures are REAL device output, captured from sticks running the
 * same V1.0-220923 base ours do -- see scripts/fixtures/omci/README.md. That
 * matters more here than anywhere else in this file: the ME parser exists
 * purely to cope with a format that is inconsistent between tables, and a
 * fixture written to match the parser would test nothing.
 */
const OMCI = {
  84: readFileSync(join(root, 'scripts/fixtures/omci/84-VlanTagFilterData.txt'), 'utf8'),
  171: readFileSync(join(root, 'scripts/fixtures/omci/171-ExtVlanTagOperCfgData.txt'), 'utf8'),
};

/*
 * ME 7 has no capture yet. The FRAME below is verified -- it is the one the two
 * real fixtures use -- but the attribute names are assumed, so this exercises
 * the comparison logic and NOT the claim that this firmware calls the attribute
 * "Version". scripts/capture-omci.sh settles that; until it has run, this is
 * labelled for what it is rather than filed beside the real captures.
 */
const ME7_SHAPED = [
  'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', 'SWImage',
  'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  '=================================',
  'EntityId: 0x0000', 'Version: V1.0-220923', 'IsActive: 1', 'IsCommitted: 1',
  '=================================', '',
].join('\n');
globalThis.fetch = async (path) => {
  const [key, qs] = String(path).split('?');
  if (key === '/api/omci') {
    const p = new URLSearchParams(qs || '');
    const raw = p.get('cmd') === 'me' ? (OMCI[p.get('me')] ?? '') : '';
    return { ok: true, status: 200, json: async () => ({ raw, ok: true, truncated: false }) };
  }
  if (!(key in API)) throw new Error('unexpected fetch: ' + key);
  return { ok: true, status: 200, json: async () => API[key] };
};

/* --- load the graph and render ------------------------------------------ */
let failed = 0;
const ok = (cond, what) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!cond) failed++;
};

const mods = ['dom', 'state', 'status', 'flow', 'validate', 'config', 'save', 'firmware',
              'omci', 'services', 'mebrowser', 'restore', 'l2'];
for (const m of mods) {
  const mod = await import(join(root, 'web', `${m}.js`));
  ok(Object.keys(mod).length > 0, `${m}.js loads and exports something`);
}

const { S } = await import(join(root, 'web', 'state.js'));
const { renderConfig, renderAll } = await import(join(root, 'web', 'config.js'));
const { valueProblem } = await import(join(root, 'web', 'validate.js'));
const { renderStatus } = await import(join(root, 'web', 'status.js'));

S.SCHEMA = SCHEMA;
S.VALUES = VALUES;
for (const m of META) S.META[m.name] = m;
for (const c of CONS) S.CONS[c.name] = c;
for (const f of FEAT) (S.FEATURES[f.mask] ||= []).push(f);

renderConfig('#sections', S.SCHEMA, '');
ok(doc.querySelector('#sections').children.length > 0, 'the Advanced table renders rows');
renderConfig('#common', S.SCHEMA.filter((r) => r.common === 'yes'), '');
ok(doc.querySelector('#common').children.length > 0, 'the Config table renders rows');

const vlan = SCHEMA.find((r) => r.name === 'VLAN_MANU_TAG_VID');
ok(valueProblem(vlan, '99999') !== null, 'an out-of-range VLAN is rejected');
ok(valueProblem(vlan, '100') === null, 'an in-range VLAN is accepted');
const ip = SCHEMA.find((r) => r.name === 'LAN_IP_ADDR');
ok(valueProblem(ip, '1.2.3.999') !== null, 'a bad octet is rejected');

renderStatus(API['/api/status'].raw);
ok(true, 'renderStatus runs against a diag capture');

/* --- the switch MAC table ------------------------------------------------- */
const { parseL2 } = await import(join(root, 'web', 'l2.js'));
const L2 = readFileSync(join(root, 'scripts/fixtures/l2-table.txt'), 'utf8');
const l2rows = parseL2(L2);

ok(l2rows.length === 2, 'every learned address is found across the LUT stanzas');
ok(l2rows[0].MACAddress === '78:54:2E:07:64:63', 'the address is read');
ok(l2rows[0].Spa === '2', 'the source port is zipped against its own header');
ok(l2rows[0].Vid === '1' && l2rows[0].State === 'Auto',
   'later columns line up too');
/* The capture ends on a header with no row under it. A parser that assumed
   a row always follows would invent an entry or throw. */
ok(l2rows.every((r) => r.MACAddress), 'a header with no row under it yields no entry');

/* SYNTHETIC, and deliberately not in scripts/fixtures/: no capture in hand
   shows an address learned on the host side, and inventing one to put beside
   the real ones is how a fixture stops being evidence. This exercises only the
   port-number-to-side mapping. */
const SYNTH = 'MACAddress        Spa Fid Age Vid  State  Ext  Hash\n'
            + '02:00:00:00:00:01 0   0   1   1    Auto   0    SVL\n';
ok(parseL2(SYNTH)[0].Spa === '0', 'a port-0 row parses the same way');
/* The second stanza of each entry has its own header (CtagIf Auth DaBlock...)
   and a row of words -- none of which is a MAC, so none of it may become an
   entry of its own. */
ok(!l2rows.some((r) => r.MACAddress === 'Dis'), 'the per-entry flag rows are not mistaken for addresses');
ok(parseL2('').length === 0, 'no output yields no rows');

/* --- restoring a backup --------------------------------------------------- */
const { parseBackup, classify } = await import(join(root, 'web', 'restore.js'));

/* The shape `flash all` prints: hs first, then cs, both wrapped in <Dir>, with
   table rows distinguished only by an XML comment. */
const BACKUP = `
<Dir Name="HW_SETTING">
  <Value Name="GPON_SN" Value="ODI012345678"/>
  <Value Name="LAN_SDS_MODE" Value="4"/>
</Dir>
<Dir Name="MIB_TABLE">
  <Value Name="LAN_IP_ADDR" Value="192.168.0.3"/>
  <Value Name="VLAN_MANU_TAG_VID" Value="110"/>
  <Value Name="OMCI_CUSTOM_RDP" Value="4"/>
</Dir>
<Dir Name="SW_PORT_TBL"> <!--index=1-->
  <Value Name="PVID" Value="1"/>
</Dir>`;

const parsed = parseBackup(BACKUP);
ok(parsed.get('GPON_SN') === 'ODI012345678', 'a backup parses to name/value pairs');
ok(parsed.get('LAN_IP_ADDR') === '192.168.0.3', 'values from both stores are picked up');
ok(parsed.size === 6, 'every Value element is read, comments and Dir nesting included');
ok(parseBackup('not a backup at all').size === 0, 'a file that is not a backup yields nothing');

/* VALUES has every key at '1', so everything in the backup differs. The point
   under test is WHERE each key lands. */
const plan = classify(parsed);
ok(plan.refused.includes('LAN_SDS_MODE'),
   'a SerDes key in a backup is refused, not restored');
ok(!plan.change.some(([n]) => n === 'LAN_SDS_MODE'),
   'and it never reaches the write list');
ok(plan.identity.some(([n]) => n === 'GPON_SN'),
   'identity keys are separated from ordinary ones');
ok(plan.change.some(([n]) => n === 'LAN_IP_ADDR'),
   'an ordinary key is queued for writing');
ok(!plan.change.some(([n]) => n === 'GPON_SN'),
   'and identity keys are not in that list unless asked for');

/* A key already holding the backup's value must not be rewritten: a restore
   that reports 184 writes tells you nothing about what actually changed. */
const same = classify(parseBackup('<Value Name="LAN_IP_ADDR" Value="1"/>'));
ok(same.same.includes('LAN_IP_ADDR') && same.change.length === 0,
   'a value that already matches is not rewritten');

/* --- the OMCI_CUSTOM_* bitmask decode ------------------------------------ */
const { decodeMask } = await import(join(root, 'web', 'state.js'));

/* 4 is what both of our sticks ship with, and what Anime4000/RTL960x#41 has
   been asking about since 2022. The answer is one row of features.tsv. */
const rdp = decodeMask('OMCI_CUSTOM_RDP', '4');
ok(rdp && rdp.known.length === 1 && rdp.known[0].names[0] === 'ignore_conn_uniNode_check',
   'OMCI_CUSTOM_RDP=4 decodes to ignore_conn_uniNode_check');
/* 258 = 0x102: the SFU default, two bits, one of them served by two modules. */
const bdp = decodeMask('OMCI_CUSTOM_BDP', '258');
ok(bdp && bdp.known.length === 2, 'OMCI_CUSTOM_BDP=258 decodes to two bits');
ok(bdp.known.some((b) => b.bit === 0x100 && b.names.length === 2),
   'a bit carrying two plugins reports both');
/* The value is decimal; a hex-looking string must not silently read as 0x. */
ok(decodeMask('OMCI_CUSTOM_ME', '65536').known[0].names[0] === 'accept_invalid_pq_instance_id',
   'OMCI_CUSTOM_ME=65536 is read as decimal');
const unk = decodeMask('OMCI_CUSTOM_RDP', '8');
ok(unk && unk.known.length === 0 && unk.unknown[0] === 8,
   'a bit with no plugin in this image is reported, not dropped');
ok(decodeMask('LAN_IP_ADDR', '1') === null, 'a key that is not a mask decodes to nothing');

/* --- the ME parser, against captured device output ----------------------- */
const { parseOmci, attr } = await import(join(root, 'web', 'omci.js'));

const p84 = parseOmci(OMCI[84]);
ok(p84.name === 'VlanTagFilterData', 'ME 84 reports the table name the device printed');
ok(p84.instances.length === 2, 'ME 84 yields both filter instances');
ok(p84.instances[0].id === '0x04', 'ME 84 EntityID (capital D) is picked up');
ok(attr(p84.instances[0], 'FwdOp') === '0x10', 'an attribute survives with its value');

const p171 = parseOmci(OMCI[171]);
ok(p171.instances.length === 1, 'ME 171 yields one instance');
ok(p171.instances[0].id === '0x02', 'ME 171 EntityId (lowercase d) is picked up too');
const idx = p171.instances[0].groups.find((g) => /^INDEX/.test(g.label));
ok(!!idx, 'the ReceivedFrameVlanTaggingOperTable rows are grouped by INDEX');
ok(idx.attrs.some(([k, v]) => k === 'Treatment Inner' && /VID 1600/.test(v)),
   'a keyless table row keeps its multi-word key');

/* The decoded page, on the same bytes. The claim under test is the one the
   page leads with: the OLT calls it 35 on your side and 1600 on the fibre. */
const { renderServices } = await import(join(root, 'web', 'services.js'));
await renderServices(true);
const cards = doc.querySelector('#services-cards');
ok(cards.children.length === 6, 'the Services tab renders a card per table');
const text = JSON.stringify(cards, (k, v) => (k === 'classList' ? undefined : v));
ok(/VLAN 1600/.test(text), 'the translation card names the VLAN on the fibre');
ok(/allows these VLANs on this line: 75, 1600/.test(text),
   'the filter card lists the VLANs the OLT permits');
/* ME 7 has no fixture, so the card renders empty and must not claim a mismatch
   against the U-Boot environment it cannot compare with. */
ok(!/is not what the OLT was told/.test(text),
   'no version mismatch is claimed when ME 7 returned nothing');

/* Now with a software-image dump whose version is NOT what partition 0 holds:
   the card must say so, because that difference is the whole mechanism behind
   "my OMCI software version resets at every boot". */
OMCI[7] = ME7_SHAPED;
await renderServices(true);
const text2 = JSON.stringify(doc.querySelector('#services-cards'),
                             (k, v) => (k === 'classList' ? undefined : v));
ok(/is not what the OLT was told/.test(text2),
   'a version the active partition does not hold is reported as such');
ok(/sw_custom_version0/.test(text2), 'and the fix names the right nv variable');
delete OMCI[7];

await import(join(root, 'web', 'app.js'));
await new Promise((r) => setTimeout(r, 50));
ok(true, 'app.js bootstraps without throwing');

console.log(failed ? `\n${failed} failed` : '\nweb modules ok');
process.exit(failed ? 1 : 0);
