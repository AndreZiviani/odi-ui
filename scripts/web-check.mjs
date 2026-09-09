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
globalThis.fetch = async (path) => {
  const key = String(path).split('?')[0];
  if (!(key in API)) throw new Error('unexpected fetch: ' + key);
  return { ok: true, status: 200, json: async () => API[key] };
};

/* --- load the graph and render ------------------------------------------ */
let failed = 0;
const ok = (cond, what) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!cond) failed++;
};

const mods = ['dom', 'state', 'status', 'flow', 'validate', 'config', 'save', 'firmware'];
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

await import(join(root, 'web', 'app.js'));
await new Promise((r) => setTimeout(r, 50));
ok(true, 'app.js bootstraps without throwing');

console.log(failed ? `\n${failed} failed` : '\nweb modules ok');
process.exit(failed ? 1 : 0);
