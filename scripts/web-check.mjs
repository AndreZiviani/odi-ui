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
const VALUES = Object.fromEntries(SCHEMA.map((r) => [r.name, '1']));

const API = {
  '/api/schema': SCHEMA, '/api/meta': META, '/api/consumers': CONS,
  '/api/values': VALUES, '/api/defaults': {}, '/api/baseline': [],
  '/api/status': { raw: 'RTK.0> gpon get onu-state\n  Operation State(O5)\n' },
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
              'omci', 'services', 'mebrowser'];
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

await import(join(root, 'web', 'app.js'));
await new Promise((r) => setTimeout(r, 50));
ok(true, 'app.js bootstraps without throwing');

console.log(failed ? `\n${failed} failed` : '\nweb modules ok');
process.exit(failed ? 1 : 0);
