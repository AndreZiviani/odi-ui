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
    this.dataset = {}; this.options = [];
    this.style = { setProperty: (k, v) => { this.style[k] = v; } };
    this._text = ''; this.hidden = false; this.disabled = false;
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      toggle: (c, on) => (on ? this.classList._s.add(c) : this.classList._s.delete(c)),
      contains: (c) => this.classList._s.has(c),
    };
  }
  /* className and classList are the same thing in a real DOM, and el() in
     dom.js sets className directly. Keeping them separate here meant
     classList.contains() answered false for every class the page assigns,
     which silently passed any test that only checked the happy path. */
  get className() { return [...this.classList._s].join(' '); }
  set className(v) {
    this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean));
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
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  get value() { return this._value ?? ''; }
  set value(v) { this._value = v; }
}

const byId = new Map();
const doc = {
  createElement: (t) => new El(t),
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t), children: [] }),
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
globalThis.location = { hostname: 'stick.example', href: '/', hash: '' };
globalThis.window = { addEventListener: () => {} };
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
const SETT = tsv('settings.tsv', ['name', 'apply', 'action', 'pair', 'reader', 'note']);
const VALUES = Object.fromEntries(SCHEMA.map((r) => [r.name, '1']));

const API = {
  '/api/schema': SCHEMA, '/api/meta': META, '/api/consumers': CONS,
  '/api/values': VALUES, '/api/defaults': {}, '/api/baseline': [], '/api/features': FEAT,
  '/api/settings': SETT,
  '/api/status': { raw: 'RTK.0> gpon get onu-state\n  Operation State(O5)\n' },
  '/api/firmware': {
    running: 'ODI-260910-6861b53', confd: 'test', mem: '26 MB', build: {},
    defaultauth: false, switches: { 'omci-identity.on': false }, lanip_override: false,
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
const fx = (f) => readFileSync(join(root, 'scripts/fixtures/omci', f), 'utf8');
const OMCI = {
  84: fx('84-VlanTagFilterData.txt'),
  171: fx('171-ExtVlanTagOperCfgData.txt'),
  7: fx('7-SWImage.txt'),
  131: fx('131-OltG.txt'),
  11: fx('11-EthUni-claro.txt'),
  329: fx('329-VEIP-claro.txt'),
  47: fx('47-MacBriPortCfgData-claro.txt'),
};
const OMCI_VERO_47 = fx('47-MacBriPortCfgData-vero.txt');
const OMCI_CLARO_171 = fx('171-claro.txt');

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

const textOf = (n) => (n.nodeType === 3 ? n.textContent
  : (n._text || '') + (n.children || []).map(textOf).join(''));

/* --- load the graph and render ------------------------------------------ */
let failed = 0;
const ok = (cond, what) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!cond) failed++;
};

const mods = ['dom', 'state', 'status', 'flow', 'validate', 'config', 'save', 'firmware',
              'omci', 'services', 'mebrowser', 'restore', 'l2', 'tools'];
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

renderConfig('#sections', S.SCHEMA, '', true);
ok(doc.querySelector('#sections').children.length > 0, 'the stock-keys list renders rows');
renderConfig('#set-line', S.SCHEMA.filter((r) => r.common === 'yes'), '');
ok(doc.querySelector('#set-line').children.length > 0, 'a Config subtab renders rows');

const vlan = SCHEMA.find((r) => r.name === 'VLAN_MANU_TAG_VID');
ok(valueProblem(vlan, '99999') !== null, 'an out-of-range VLAN is rejected');
ok(valueProblem(vlan, '100') === null, 'an in-range VLAN is accepted');
const ip = SCHEMA.find((r) => r.name === 'LAN_IP_ADDR');
ok(valueProblem(ip, '1.2.3.999') !== null, 'a bad octet is rejected');

renderStatus(API['/api/status'].raw);
ok(true, 'renderStatus runs against a diag capture');

/* The near-edge band scales with the window. A fixed 3 dB was more than half
   the 4.5 dB launch window and flagged a healthy +2.15 dBm transmitter. */
{
  const { OPTICS, tight } = await import(join(root, 'web', 'status.js'));
  ok(Math.abs(tight(OPTICS.tx) - 0.72) < 0.01 && Math.abs(tight(OPTICS.rx) - 3.04) < 0.01,
     'near the edge is 16% of each window: 0.72 dB tx, 3.04 dB rx');
  const tx = (v) => `RTK.0> pon get transceiver tx-power\n  Tx Power : ${v} dBm\n`;
  renderStatus(tx('2.15'));
  ok(doc.querySelector('#tx').className === 'meter v-ok', 'a +2.15 dBm transmitter is in window, not near the edge');
  renderStatus(tx('0.9'));
  ok(doc.querySelector('#tx').className === 'meter v-warn', 'and +0.9 dBm, 0.4 dB off the minimum, is near it');
  renderStatus(tx('0.2'));
  ok(doc.querySelector('#tx').className === 'meter v-bad', 'and +0.2 dBm is out of the window');
}

/* --- the kernel log ------------------------------------------------------- */
const { renderLogLines } = await import(join(root, 'web', 'tools.js'));

/* Real shape, from Anime4000/RTL960x#30: a <4> header followed by CONTINUATION
   lines carrying no prefix of their own. Those inherit the last level seen --
   otherwise the switch error under a warning renders as ordinary text. */
const KLOG = [
  '<4>',
  '<4>create ani vlan for mbcast fail, ret = 65672',
  '[WARNING] Return Error (0x10088:RT_ERR_RG_VLAN_USED_BY_SYSTEM) at line:18390',
  '<6>eth0: link up',
].join('\n');

const logbox = doc.createElement('div');
renderLogLines(KLOG, logbox);
ok(logbox.children.length === 3, 'blank lines are dropped, real ones kept');
ok(logbox.children[0].classList.contains('warn'), 'a <4> line is a warning');
ok(logbox.children[1].classList.contains('warn'),
   'a continuation line inherits the level above it');
ok(!logbox.children[2].classList.contains('warn'), 'and a later <6> resets it');
ok(!/^<\d>/.test(logbox.children[0].textContent), 'the priority prefix is not shown');

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

/* odi-oss diag answers the same command with its own listing: one header,
   one line per row, a summary line before and after. The rows are its golden
   test's, not a capture -- scripts/fixtures/omci/README.md says so. */
const { members } = await import(join(root, 'web', 'l2.js'));
const L2OSS = readFileSync(join(root, 'scripts/fixtures/l2-table-odi-oss.txt'), 'utf8');
const ossrows = parseL2(L2OSS);
ok(ossrows.length === 3, 'odi-oss: every row is found, the summary lines are not');
ok(ossrows[0].MACAddress === '78:54:2E:07:64:63' && ossrows[0].Spa === '2'
   && ossrows[0].Vid === '1' && ossrows[0].Age === '6' && ossrows[0].State === 'Auto',
   'odi-oss: the stock header words carry the same fields');
ok(ossrows[1].Spa === '0', 'odi-oss: a host-side address');
ok(ossrows[2].Type === 'mc' && ossrows[2].Ports === '0x1' && ossrows[2].State === 'Static',
   'odi-oss: a multicast group is marked, with its member mask');
ok(members('0x1') === 'host (port 0)', 'a member mask names the host side');
ok(members('0x5') === 'host (port 0), fibre (port 2)', 'and each member, in port order');
ok(members('0x0') === 'no ports', 'an empty mask says so');

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

/* 4 is what the stock firmware ships with, and what Anime4000/RTL960x#41 has
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
ok(cards.children.length === 7, 'the Services tab renders a card per table');
const text = JSON.stringify(cards, (k, v) => (k === 'classList' ? undefined : v));
ok(/VLAN 1600/.test(text), 'the translation card names the VLAN on the fibre');
ok(/allows these VLANs on this line: 75, 1600/.test(text),
   'the filter card lists the VLANs the OLT permits');

/* Captured from our own sticks, so these assert what the DEVICE says. */
ok(/ODI|V1\.0-220923/.test(text), 'the software-image card shows a version');
ok(/running/.test(text) && /kept/.test(text),
   'Active and Committed are read -- the card assumed IsActive/IsCommitted and showed neither');
ok(/HWTC/.test(text), 'the OLT vendor code is decoded from its hex word');
ok(/carries both the physical Ethernet UNI and the VEIP/.test(text),
   'Claro: the bridge carries the UNI and the VEIP');

/* The same card on the other line, which is the difference that matters. */
OMCI[47] = OMCI_VERO_47;
await renderServices(true);
const veroText = JSON.stringify(doc.querySelector('#services-cards'),
                                (k, v) => (k === 'classList' ? undefined : v));
ok(/carries the VEIP, not the physical port/.test(veroText),
   'Vero: the bridge carries the VEIP alone');
OMCI[47] = fx('47-MacBriPortCfgData-claro.txt');

/* Claro's real ME 171: most rows add no tag at all (treatment PRI 15, a 3-bit
   field, so out of range and unspecified). Rendering those as "VLAN 0" is a
   VLAN id nobody set, printed as though the OLT had set it -- which is what
   the live page did until a stick showed it. */
OMCI[171] = OMCI_CLARO_171;
await renderServices(true);
const c171 = JSON.stringify(doc.querySelector('#services-cards'),
                            (k, v) => (k === 'classList' ? undefined : v));
ok(/no tag added/.test(c171), 'an unset treatment reads as "no tag added"');
ok(!/VLAN 0/.test(c171), 'and never as VLAN 0');
OMCI[171] = fx('171-ExtVlanTagOperCfgData.txt');

/* --- a MIB service that has stopped answering --------------------------- */
const { unavailable } = await import(join(root, 'web', 'omci.js'));
ok(unavailable({ ok: true, raw: '', instances: [] }) !== null,
   'empty output is reported as unavailable, not as an empty table');
ok(unavailable({ ok: true, raw: 'TableId [1] Name: Anig!\n', instances: [] }) !== null,
   'a table listing in place of the table asked for is reported too');
ok(unavailable({ ok: true, raw: OMCI[84], instances: parseOmci(OMCI[84]).instances }) === null,
   'a real dump is not mistaken for a failure');

/* --- the odi-oss omcid dump shape -------------------------------------- */
/* SYNTHETIC, and not in scripts/fixtures/omci/: no capture of it is in hand
   yet. Built from the printf in odi-oss src/omci/respond/show.c (cli_row)
   and the first line a live stick answered for ME 268 ("268 GemPortCtp 1",
   then "    PortID 0fff ..."), which the Services card used to call "The
   OLT has not created any". It proves the parser reads that shape, and
   nothing about which attributes a real line carries. */
const ODI268 = [
  '268 GemPortCtp 1',
  '    PortID                   0fff',
  '    TcAdapterPtr             8000',
  '    Direction                03',
  '268 GemPortCtp 2',
  '    PortID                   0402',
  '    TcAdapterPtr             8001',
  '2 rows', '',
].join('\n');
const p268 = parseOmci(ODI268);
ok(p268.name === 'GemPortCtp' && p268.instances.length === 2 && p268.rows === 2,
   'odi-oss: every row is read, and the row count');
ok(attr(p268.instances[0], 'PortID') === '0x0fff' && Number(attr(p268.instances[1], 'PortID')) === 1026,
   'odi-oss: attribute bytes read as numbers');
const pVer = parseOmci('7 SWImage 0\n    Version                  56312e302d3232303932330000000000\n    Active                   01\n1 row\n');
ok(attr(pVer.instances[0], 'Version') === 'V1.0-220923', 'odi-oss: a string attribute reads as its text');

const SAVED = { 7: OMCI[7], 262: OMCI[262], 268: OMCI[268] };
OMCI[268] = ODI268;
OMCI[262] = '0 rows\n';
OMCI[7] = '0 rows\n';
await renderServices(true);
const odiText = JSON.stringify(doc.querySelector('#services-cards'),
                               (k, v) => (k === 'classList' ? undefined : v));
ok(/2 provisioned, by GEM port id: 4095, 1026/.test(odiText),
   'the GEM port card reads the odi-oss shape instead of reporting none');
ok(!/has not provisioned any|has not created any/.test(odiText),
   'an ONU-created entity answering 0 rows is never reported as none');
ok((odiText.match(/Could not read/g) || []).length >= 2,
   'it is reported as a read that came back incomplete');
OMCI[262] = '';
OMCI[268] = '0 rows\n';
await renderServices(true);
const noneText = JSON.stringify(doc.querySelector('#services-cards'),
                                (k, v) => (k === 'classList' ? undefined : v));
ok(/The MIB holds none/.test(noneText), 'a good empty read of an OLT-created table says none');
Object.assign(OMCI, SAVED);

/* --- the kernel log, as odi-oss writes it -------------------------------- */
const oss = doc.createElement('div');
const rOss = renderLogLines('<12>rcS: alive 517.79 s, free 13912 kB\nodi_wdt: alive at 492 s\n<11>rcS: omcid died\n', oss);
ok(oss.children.length === 1 && rOss.hidden === 2, 'heartbeat lines are hidden by default, and counted');
ok(oss.children[0].classList.contains('bad') && !/<\d+>/.test(textOf(oss.children[0])),
   'a <11> userland line is an error, and its facility prefix is stripped');
const oss2 = doc.createElement('div');
renderLogLines('<12>rcS: alive 517.79 s\n', oss2, { heartbeats: true });
ok(oss2.children.length === 1 && oss2.children[0].classList.contains('warn'), 'and shown on request, <12> as a warning');

/* --- what each firmware slot holds ---------------------------------------- */
const { slotKind } = await import(join(root, 'web', 'firmware.js'));
const fwStock = { slots: { 0: { kernel: 'Linux Kernel Image 6.18', built: 1759028976 },
                           1: { kernel: 'Linux Kernel Image', built: 1663932999 } } };
ok(slotKind(fwStock, '0').kind === 'odi', 'an odi-oss kernel header is recognised');
ok(slotKind(fwStock, '1').kind === 'stock' && slotKind(fwStock, '1').when === '2022-09-23',
   'the stock kernel header is recognised, with its build date');
ok(slotKind({ slots: { 1: {} } }, '1').kind === 'unknown', 'an unreadable slot is unknown, not assumed');

/* --- the trial-boot banner ------------------------------------------------ */
{
  const { renderTrial } = await import(join(root, 'web', 'firmware.js'));
  const st = await import(join(root, 'web', 'state.js'));
  const keepFW = st.S.FW;
  const bar = doc.querySelector('#trialbanner');
  st.S.FW = { env: { sw_active: '0', sw_commit: '1', sw_version1: 'V1.0-220923' }, fallback: {},
              slots: { 1: { kernel: 'Linux Kernel Image', built: 1663932999 } } };
  renderTrial();
  ok(bar.hidden === false, 'a trial boot raises the banner');
  ok(/returns to partition 1, which holds the stock firmware/.test(doc.querySelector('#trial-what').textContent),
     'and says where the next reboot goes, and what that slot holds');
  ok(doc.querySelector('#trial-keep').hidden === false, 'with the Keep action');
  st.S.FW = { env: { sw_active: '0', sw_commit: '0' }, fallback: { sw_commit: '1' }, slots: {} };
  renderTrial();
  ok(bar.hidden === false && /fallback copy still names partition 1/.test(doc.querySelector('#trial-what').textContent),
     'a fallback copy naming another slot is a trial too');
  st.S.FW = { env: { sw_active: '0', sw_commit: '0' }, fallback: { sw_commit: '0' } };
  renderTrial();
  ok(bar.hidden === true, 'and a committed image with both copies agreeing has no banner');
  st.S.FW = { env: {} };
  renderTrial();
  ok(bar.hidden === true, 'an unreadable environment is not reported as a trial');
  st.S.FW = keepFW;
}

/* --- the Firmware subtab ------------------------------------------------ */
{
  const { renderFirmware } = await import(join(root, 'web', 'firmware.js'));
  const keep = API['/api/firmware'];
  const fwText = async (fw) => {
    API['/api/firmware'] = fw;
    await renderFirmware();
    return textOf(doc.querySelector('#parts'));
  };
  const trialFW = { env: { sw_active: '1', sw_commit: '0', sw_tryactive: '2' }, fallback: {},
                    slots: {}, build: { image: 'v1.0.8', confd: 'local' }, confd: 'v1.0.8-dirty' };
  let t = await fwText({ ...trialFW, exe: '/bin/confd' });
  ok(!/override/.test(t), 'a local build (confd=local) run from /bin/confd is not called an override');
  ok(!/Try partition/.test(t), 'mid-trial, neither slot offers Try: one is running, the other is what the next boot is anyway');
  ok(/Keep this image/.test(t), 'the running, uncommitted slot offers Keep this image');
  t = await fwText({ ...trialFW, exe: '/etc/config/confd/confd' });
  ok(/override in \/etc\/config is in use/.test(t), 'a confd run from /etc/config is an override');
  t = await fwText({ ...trialFW, env: { sw_active: '1', sw_commit: '1', sw_tryactive: '2' }, exe: '/bin/confd' });
  ok(/Try partition 0/.test(t) && !/Try partition 1/.test(t), 'committed, Try is offered on the other slot only');
  API['/api/firmware'] = keep;
}

/* --- indented continuation lines ----------------------------------------- */
const tod = parseOmci(OMCI[131]).instances[0];
ok(!tod.groups.length, 'ME 131 ToDInfo sub-lines do not become sub-tables');
ok(/Sequence number/.test(attr(tod, 'ToDInfo') || ''),
   'they are folded into the attribute they belong to');

/* The active partition (sw_active=0 in the stub env) holds ODI-260910-...,
   while the captured ME 7 reports V1.0-220923 -- which is exactly the real
   situation on these sticks today: the versioned image has not been flashed.
   The card must say so and name the nv variable that fixes it. */
ok(/is not what the OLT was told/.test(text),
   'a version the active partition does not hold is reported as such');
ok(/OMCI_SW_VER1/.test(text) && /identity switch/.test(text),
   'and the fix names the key and the switch that report it on this image');
ok(!/sw_custom_version/.test(text), 'not the stock-only nv variable');

/* --- this image own settings table --------------------------------------- */
const state = await import(join(root, 'web', 'state.js'));
const { withPairs } = await import(join(root, 'web', 'save.js'));
const { EDITS } = state;
const walk = (n, f) => { f(n); for (const c of n.children || []) walk(c, f); };
/* The editable subtabs, each its own host now that Config is grouped. */
const GROUP_HOSTS = ['line', 'vlan', 'identity', 'network', 'services', 'other'].map((g) => '#set-' + g);
const hostsOf = (sel) => (sel === '#common' ? GROUP_HOSTS : [sel]).map((h) => doc.querySelector(h));
const rowsOf = (sel) => {
  const out = [];
  for (const host of hostsOf(sel)) walk(host, (n) => { if (n.classList && n.classList.contains('setting')) out.push(n); });
  return out;
};
const inputsOf = (sel) => {
  let n = 0;
  for (const host of hostsOf(sel)) walk(host, (x) => { if (x.tagName === 'input' || x.tagName === 'select') n++; });
  return n;
};
const tagsOf = (sel) => {
  const out = [];
  for (const host of hostsOf(sel)) {
    walk(host, (x) => {
      if (x.tagName === 'span' && x.classList && (x.classList.contains('tag') || x.classList.contains('cost'))) out.push(textOf(x));
    });
  }
  return out;
};
const allText = (sel) => hostsOf(sel).map(textOf).join('\n');

for (const r of SETT) S.SETTINGS[r.name] = r;
S.FW = API['/api/firmware'];
ok(state.imageAware(), 'the settings table makes the page image-aware');
renderAll();
const common = '#common';
ok(rowsOf(common).length === SETT.length,
   `Config shows exactly the ${SETT.length} keys this image reads`);
const classTags = tagsOf(common).filter((t) => Object.values(state.CLASS_LABEL).includes(t));
ok(classTags.length === SETT.length, 'and every one of them carries its apply class');
ok(tagsOf(common).includes('Interrupts internet') && tagsOf(common).includes('Live')
   && tagsOf(common).includes('Reboot'), 'the classes are the ones SETTINGS.md names');
const pairs = SETT.filter((r) => r.pair).length;
ok(inputsOf(common) === SETT.length - pairs,
   'every key is editable except the ones written with another (LOID_OLD)');
const stock = '#sections';
ok(rowsOf(stock).length === SCHEMA.length - SETT.length,
   'the stock keys are all on their own tab');
ok(inputsOf(stock) === 0, 'and none of them can be edited there');
ok(doc.querySelector('#device-login').hidden === true,
   'the stock device-login section is not offered');

/* The two SERVICE RESTART keys are editable and validate as host[:port]. */
ok(tagsOf(common).includes('Service restart'), 'SYSLOG_SERVER / NTP_SERVER carry SERVICE RESTART');

/* Help text: one line shown, the rest behind Details, and nothing said twice.
   meta.tsv and settings.tsv were written apart, and the page used to print
   the syslog and NTP explanations twice over, and "re-ranges" on every VLAN
   row twice. */
const { splitHelp } = await import(join(root, 'web', 'config.js'));
for (const r of SETT) {
  const m = META.find((x) => x.name === r.name) || {};
  const h = splitHelp(m.help, r.note);
  const said = [h.first, h.rest, h.note].join(' ').split(/(?<=[.!?])\s+/).map((x) => x.toLowerCase().trim()).filter(Boolean);
  ok(new Set(said).size === said.length, `${r.name}: no sentence is shown twice`);
}
ok(splitHelp('One. Two.', 'Two. Three.').note === 'Three.', 'a note sentence already in the help is dropped');
ok(!/[.!?].+[.!?]/.test(splitHelp(META.find((x) => x.name === 'NTP_SERVER').help, '').first),
   'the visible help is one sentence');
const hpRow = { name: 'NTP_SERVER', type: 'hostport' };
const hp = (v) => valueProblem(hpRow, v);
ok(!hp('pool.ntp.org') && !hp('10.0.0.1') && !hp('10.0.0.1:514') && !hp('a-b.c:65535'),
   'hostport accepts hostnames, IPv4 literals and host:port');
ok(['a b', 'a"b', "a'b", 'h:0', 'h:70000', 'h:', ':1', '-h', 'h.'].every((v) => hp(v)),
   'hostport rejects spaces, quotes and bad ports');
ok(!hp(''), 'hostport accepts empty: it clears the key');

EDITS.set('LOID', 'someone');
const pw = withPairs([...EDITS.entries()]);
ok(pw.some(([k, v]) => k === 'LOID_OLD' && v === 'someone'),
   'saving LOID writes LOID_OLD too, since the OLD value wins');
EDITS.clear();

/* Without the table, the page is what it was: every key offered. */
for (const k of Object.keys(S.SETTINGS)) delete S.SETTINGS[k];
renderAll();
ok(inputsOf('#sections') > 100,
   'with no settings table every key is editable, as before');

await import(join(root, 'web', 'app.js'));
await new Promise((r) => setTimeout(r, 50));
ok(true, 'app.js bootstraps without throwing');

console.log(failed ? `\n${failed} failed` : '\nweb modules ok');
process.exit(failed ? 1 : 0);
