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
import { fileURLToPath, URL as NodeURL } from 'url';
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
  focus() {}
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
doc.documentElement = { dataset: {} };
globalThis.document = doc;
globalThis.Event = class { constructor(t) { this.type = t; } };
globalThis.CustomEvent = globalThis.Event;
globalThis.location = { hostname: 'stick.example', href: '/', hash: '' };
globalThis.window = { addEventListener: () => {} };
globalThis.setInterval = () => 0;
globalThis.confirm = () => false;   /* the reset flow asks; nothing here clicks it */
/* The real URL class (updates.js parses links with it), plus the two blob stubs. */
globalThis.URL = Object.assign(NodeURL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} });

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
const SETT = tsv('settings.tsv', ['name', 'apply', 'action', 'pair', 'reader', 'note', 'unset']);
const VALUES = Object.fromEntries(SCHEMA.map((r) => [r.name, '1']));

const API = {
  '/api/schema': SCHEMA, '/api/meta': META, '/api/consumers': CONS,
  '/api/values': VALUES, '/api/defaults': {}, '/api/baseline': [], '/api/features': FEAT,
  '/api/settings': SETT,
  '/api/hostlink': { supported: true, state: { setting: 'on', running: 'on', phase: 'steady', fallback: '0' },
                     safemode: null, link: '1', uptime: '300' },
  '/api/netaddr': { supported: false, state: {}, via: '192.168.0.1', peer: '192.168.0.50', uptime: '300' },
  '/api/ntp': { now: 1760773930, ntp: null },
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
  11: fx('11-EthUni-isp1.txt'),
  329: fx('329-VEIP-isp1.txt'),
  47: fx('47-MacBriPortCfgData-isp1.txt'),
};
const OMCI_ISP2_47 = fx('47-MacBriPortCfgData-isp2.txt');
const OMCI_ISP1_171 = fx('171-isp1.txt');

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

const mods = ['dom', 'state', 'status', 'flow', 'validate', 'expert', 'config', 'save', 'firmware',
              'omci', 'services', 'mebrowser', 'phone', 'restore', 'l2', 'tools', 'hostlink', 'netaddr', 'updates'];
for (const m of mods) {
  const mod = await import(join(root, 'web', `${m}.js`));
  ok(Object.keys(mod).length > 0, `${m}.js loads and exports something`);
}

const { S } = await import(join(root, 'web', 'state.js'));
const { renderConfig, renderAll } = await import(join(root, 'web', 'config.js'));
const { valueProblem, fixedMeParse, fixedMeSerialise, fixedMeRowProblems } = await import(join(root, 'web', 'validate.js'));
const { renderFixedMeEditor } = await import(join(root, 'web', 'expert.js'));
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

/* The shared table of what every input accepts and refuses: scripts/smoke.sh
   posts the same rows to the daemon, so a rule cannot change in one layer. */
{
  const V = await import(join(root, 'web', 'validate.js'));
  const rows = readFileSync(join(root, 'scripts', 'fixtures', 'validation-vectors.tsv'), 'utf8')
    .split('\n').filter((l) => l && !l[0].match(/[#]/)).map((l) => l.split('\t'))
    .filter((r) => r[0] !== 'kind');
  const dec = (x) => decodeURIComponent(x.replace(/\+/g, ' '));
  const lines = [];
  let seen = 0;
  for (const [kind, name, value, expect] of rows) {
    const raw = dec(value);
    let bad;
    if (kind === 'key') {
      const row = SCHEMA.find((r) => r.name === name);
      bad = row ? V.valueProblem(row, raw) : 'no such key in the schema';
    } else if (kind === 'password') bad = V.passwordProblem(dec(name), raw);
    else if (kind === 'sshkey') {
      bad = V.sshKeyProblem(raw, lines);
      if (!bad) lines.push(raw);
    } else if (kind === 'ping') bad = V.pingProblem(raw);
    else if (kind === 'me') bad = V.meProblem(raw);
    else if (kind === 'entity') bad = V.entityProblem(raw);
    else bad = 'unknown kind ' + kind;
    seen++;
    if ((bad === null) !== (expect === 'ok')) {
      ok(false, `vector ${kind} ${name} ${value.slice(0, 50)}: the page says ${bad === null ? 'ok' : bad}, the table says ${expect}`);
    }
  }
  ok(seen > 150, `${seen} validation vectors agree with the page`);

  /* Rules that read another key: the page judges them from the pending edits,
     then the stored values, as the daemon does from the request, then the store. */
  const { EDITS } = await import(join(root, 'web', 'state.js'));
  const ip2 = SCHEMA.find((r) => r.name === 'LAN_IP_ADDR2');
  const en2 = SCHEMA.find((r) => r.name === 'LAN_ENABLE_IP2');
  const was = { ...S.VALUES };
  S.VALUES.LAN_IP_ADDR = '192.168.1.1';
  S.VALUES.LAN_ENABLE_IP2 = '0';
  ok(V.valueProblem(ip2, '192.168.1.1') === null, 'the second address may equal the first while it is off');
  EDITS.set('LAN_ENABLE_IP2', '1');
  ok(V.valueProblem(ip2, '192.168.1.1') !== null, 'the second address may not equal the first while it is on');
  ok(V.valueProblem(ip2, '192.168.100.1') === null, 'a different second address is fine');
  EDITS.set('LAN_IP_ADDR2', '192.168.1.1');
  ok(V.valueProblem(en2, '1') !== null, 'turning the second address on with it equal to the first is refused');
  EDITS.clear();
  Object.assign(S.VALUES, was);

  ok(V.tarProblem(new Uint8Array(512)) !== null, 'a header of zeros is not a tar archive');
  const th = new Uint8Array(512);
  th[0] = 0x61;
  th.set([0x75, 0x73, 0x74, 0x61, 0x72], 257);
  ok(V.tarProblem(th) === null, 'a 512-byte header with ustar at 257 is a tar archive');
  ok(V.tarProblem(th.slice(0, 300)) !== null, 'a short file is not a tar archive');
  ok(V.uploadSizeProblem(0) !== null && V.uploadSizeProblem(V.UPLOAD_MAX + 1) !== null
     && V.uploadSizeProblem(V.UPLOAD_MAX) === null, 'the upload size limit is 6 MiB, and empty is refused');
  ok(V.passwordProblem('admin', 'secret1', 'secret2') !== null, 'a repeated password that differs is refused');
  ok(V.passwordProblem('admin', 'secret1', 'secret1') === null, 'a repeated password that matches is fine');
}

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

/* --- the stick clock under NTP_SERVER ------------------------------------ */
{
  const { ntpLine } = await import(join(root, 'web', 'config.js'));
  const seen = Date.UTC(2026, 9, 18, 7, 52, 10) ;           /* browser: 2026-10-18 07:52:10 UTC */
  const at = (hms) => Date.UTC(2026, 9, 18, ...hms.split(':').map(Number)) / 1000;
  const synced = { event: 'step', time: String(at('07:41:00')), offset: '0.004', stratum: '2', last_sync: String(at('07:41:00')) };

  let p = ntpLine({ now: at('07:52:12'), ntp: synced }, seen, 'pool.ntp.org');
  ok(p.clock === 'Stick clock 2026-10-18 07:52:12 UTC, 2 s ahead of this browser' && !p.clockWarn,
     'ntp line: a stick 2 s ahead says so, without a warning');
  ok(p.ntp === 'Last NTP sync 07:41 UTC, corrected 0.004 s' && !p.ntpWarn,
     'ntp line: a synced stick shows the sync time and the correction');

  p = ntpLine({ now: at('07:52:11'), ntp: synced }, seen, 'pool.ntp.org');
  ok(p.clock.endsWith('matches this browser'), 'ntp line: under 2 s matches this browser');

  p = ntpLine({ now: at('07:50:00'), ntp: synced }, seen, 'pool.ntp.org');
  ok(p.clock.includes('2 min behind this browser') && p.clockWarn && p.clock.endsWith('one of the two clocks is wrong'),
     'ntp line: more than a minute off is a warning that says one of the clocks is wrong');

  p = ntpLine({ now: 3, ntp: null }, seen, 'pool.ntp.org');
  ok(p.clockWarn && p.clock.includes('1970-01-01') && p.clock.includes('57 years behind'),
     'ntp line: a stick that never set its clock shows 1970 and a warning');

  p = ntpLine({ now: at('07:52:10'), ntp: null }, seen, 'pool.ntp.org');
  ok(p.ntp.startsWith('No sync yet') && p.ntpWarn, 'ntp line: a server set and no status file is "No sync yet"');
  p = ntpLine({ now: at('07:52:10'), ntp: null }, seen, '');
  ok(p.ntp === 'NTP is off' && !p.ntpWarn, 'ntp line: no server is "NTP is off"');
  p = ntpLine({ now: at('07:52:10'), ntp: { event: 'unsync', time: String(at('07:50:00')), offset: '', stratum: '16', last_sync: String(at('07:41:00')) } },
    seen, 'pool.ntp.org');
  ok(p.ntp === 'Lost sync (last sync 07:41 UTC)' && p.ntpWarn, 'ntp line: unsync names the last sync');
  p = ntpLine({ now: at('07:52:10'), ntp: { event: 'unsync', time: '1', offset: '', stratum: '16', last_sync: '' } }, seen, 'x');
  ok(p.ntp === 'Lost sync (never synced)', 'ntp line: unsync with no earlier sync says never synced');
  p = ntpLine({ now: at('07:52:10'), ntp: { event: 'periodic', time: String(at('07:52:00')), offset: '-0.0125', stratum: '2', last_sync: String(at('07:52:00')) } },
    seen, 'x');
  ok(p.ntp === 'Last NTP sync 07:52 UTC, corrected 0.0125 s', 'ntp line: a negative offset is shown as a size');
  p = ntpLine({ now: at('07:52:10'), ntp: { event: 'stratum', time: String(at('07:52:00')), offset: '', stratum: '3', last_sync: '' } }, seen, 'x');
  ok(p.ntp === 'Last NTP sync 07:52 UTC', 'ntp line: an empty offset is left out, the event time stands in for the sync');
  p = ntpLine({ now: at('07:52:10'), ntp: { ...synced, last_sync: String(at('07:52:10') - 86400 * 2) } }, seen, 'x');
  ok(/^Last NTP sync 2026-10-16 07:52 UTC/.test(p.ntp), 'ntp line: a sync on another day carries its date');
  p = ntpLine({ now: at('07:52:10'), ntp: { ...synced, offset: '1792321465.657234' } }, seen, 'x');
  ok(p.ntp === 'Last NTP sync 07:41 UTC, set the clock (it was 57 years off)', 'ntp line: the boot step from 1970 reads as setting the clock');
  p = ntpLine(null, seen, 'x');
  ok(p.clock === '' && p.ntp.startsWith('No sync yet'), 'ntp line: no answer at all does not throw');
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

/* What the daemon would refuse is said before anything is written, and the
   backup is judged as a whole: an address is checked against the mask in the
   same file, not the one on the stick. */
const inv = classify(parseBackup([
  '<Value Name="DNS1" Value="192.168.010.001"/>',
  '<Value Name="SNMP_SYS_NAME" Value="a&amp;b"/>',
  '<Value Name="LAN_IP_ADDR" Value="192.168.0.0"/>',
  '<Value Name="LAN_SUBNET" Value="255.255.255.0"/>',
  '<Value Name="VLAN_MANU_TAG_VID" Value="110"/>',
].join('\n')));
ok(inv.invalid.map(([n]) => n).sort().join() === 'DNS1,LAN_IP_ADDR,LAN_SUBNET,SNMP_SYS_NAME',
   'values the daemon would refuse are listed as skipped, not queued: ' + JSON.stringify(inv.invalid));
ok(inv.change.some(([n]) => n === 'VLAN_MANU_TAG_VID') && !inv.change.some(([n]) => n === 'DNS1'),
   'and the rest of the backup still restores');
const wide = classify(parseBackup('<Value Name="LAN_IP_ADDR" Value="192.168.1.0"/><Value Name="LAN_SUBNET" Value="255.255.0.0"/>'));
ok(wide.invalid.length === 0, 'an address is judged under the mask the backup carries (192.168.1.0 is a host on a /16): ' + JSON.stringify(wide.invalid));

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
ok(/running/.test(text) && /committed/.test(text),
   'Active and Committed are read -- the card assumed IsActive/IsCommitted and showed neither');
ok(/HWTC/.test(text), 'the OLT vendor code is decoded from its hex word');
ok(/carries both the physical Ethernet UNI and the VEIP/.test(text),
   'ISP1: the bridge carries the UNI and the VEIP');

/* The same card on the other line, which is the difference that matters. */
OMCI[47] = OMCI_ISP2_47;
await renderServices(true);
const isp2Text = JSON.stringify(doc.querySelector('#services-cards'),
                                (k, v) => (k === 'classList' ? undefined : v));
ok(/carries the VEIP, not the physical port/.test(isp2Text),
   'ISP2: the bridge carries the VEIP alone');
OMCI[47] = fx('47-MacBriPortCfgData-isp1.txt');

/* ISP1's real ME 171: most rows add no tag at all (treatment PRI 15, a 3-bit
   field, so out of range and unspecified). Rendering those as "VLAN 0" is a
   VLAN id nobody set, printed as though the OLT had set it -- which is what
   the live page did until a stick showed it. */
OMCI[171] = OMCI_ISP1_171;
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

/* --- the MIB browser: tables, then entities, then attributes ----------- */
{
  const p84rows = parseOmci(OMCI[84]).instances;
  ok(p84rows.length === 2 && p84rows[0].raw.includes('EntityID: 0x04') && !p84rows[0].raw.includes('0x05'),
     'each parsed entity keeps its own raw lines, and only its own');

  const { renderMeBrowser, CATALOG } = await import(join(root, 'web', 'mebrowser.js'));
  const rowsOf = (sel) => doc.querySelector(sel).children.filter((node) => node.tagName === 'button');
  await renderMeBrowser();
  ok(rowsOf('#me-tables-list').length === CATALOG.length && CATALOG.length >= 82,
     `the MIB browser lists all ${CATALOG.length} classes`);
  ok(new Set(CATALOG.map((table) => table.classId)).size === CATALOG.length, 'each class id once');
  ok(CATALOG.every((table) => Number.isInteger(table.classId) && table.title && table.name),
     'every class has an id, an official name and a table name');
  ok(CATALOG.every((table) => table.query === String(table.classId)), 'every class is asked for by its id');
  const named = (id) => CATALOG.find((table) => table.classId === id);
  ok(named(268).title === 'GEM port network CTP' && named(263).title === 'ANI-G'
     && named(46).title === 'MAC bridge configuration data' && named(65529).title === 'ONU capability',
     'official names, including the classes the stock firmware lacks (46) and ours adds');
  ok(CATALOG.filter((table) => table.name === 'LargeString').map((table) => table.classId).join() === '157,307',
     'LargeString is two classes, 157 and 307, and two rows');
  const { meProblem } = await import(join(root, 'web', 'validate.js'));
  ok(CATALOG.every((table) => meProblem(table.query) === null),
     'every class id is one /api/omci accepts');
  ok(textOf(rowsOf('#me-tables-list').find((row) => textOf(row).startsWith('268'))).includes('GEM port network CTP')
     && textOf(rowsOf('#me-tables-list').find((row) => textOf(row).startsWith('268'))).includes('GemPortCtp'),
     'a row shows the official name and, under it, the table name');
  ok(rowsOf('#me-entities-list').length === 2, 'the default table (84) opens with its two entities');
  ok(textOf(doc.querySelector('#me-attrs-body')).includes('VID 75'), 'and the first entity\'s attributes');

  const table47 = rowsOf('#me-tables-list').find((row) => textOf(row).includes('MacBriPortCfgData'));
  await table47.onclick();
  const entities47 = parseOmci(OMCI[47]).instances;
  ok(rowsOf('#me-entities-list').length === entities47.length && entities47.length > 1,
     'opening a table lists every entity in its dump');
  rowsOf('#me-entities-list')[1].onclick();
  ok(doc.querySelector('#me-n-attrs').textContent.includes(
       '0x' + parseInt(entities47[1].id, 16).toString(16).padStart(4, '0')),
     'picking an entity shows that entity\'s attributes');
  doc.querySelector('#me-view-raw').onclick();
  ok(textOf(doc.querySelector('#me-attrs-body')) === entities47[1].raw, 'the raw view is that entity as printed');
  doc.querySelector('#me-view-parsed').onclick();
  ok(textOf(rowsOf('#me-tables-list').find((row) => textOf(row).includes('MacBriPortCfgData'))).endsWith(String(entities47.length)),
     'the table row counts the entities it read');

  doc.querySelector('#me-filter').value = '17';
  doc.querySelector('#me-filter').oninput();
  ok(rowsOf('#me-tables-list').some((row) => textOf(row).includes('ExtVlanTagOperCfgData'))
     && rowsOf('#me-tables-list').length < CATALOG.length, 'the filter matches a class id');
  doc.querySelector('#me-filter').value = 'gem port network';
  doc.querySelector('#me-filter').oninput();
  ok(rowsOf('#me-tables-list').some((row) => textOf(row).startsWith('268')), 'the filter matches an official name');
  doc.querySelector('#me-filter').value = 'macbriportcfg';
  doc.querySelector('#me-filter').oninput();
  ok(rowsOf('#me-tables-list').length === 1 && textOf(rowsOf('#me-tables-list')[0]).startsWith('47'),
     'and the vendor table name');
  doc.querySelector('#me-filter').value = '';
  doc.querySelector('#me-filter').oninput();
}

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

/* T-CONTs the OLT never assigned carry Alloc-ID 255 (G.988 9.2.2), and a
   live ISP1 stick has eleven of them beside five in use. SYNTHETIC, in the
   odi-oss dump shape, with that stick's five Alloc-IDs. */
{
  const rows = [282, 794, 1050, 1306, 538, ...Array(11).fill(255)];
  OMCI[262] = rows.map((a, i) => `262 Tcont ${32768 + i}\n    AllocID                  ${a.toString(16).padStart(4, '0')}\n`).join('')
    + rows.length + ' rows\n';
  await renderServices(true);
  const tc = textOf(doc.querySelector('#services-cards'));
  ok(/5 assigned, by allocation id: 282, 794, 1050, 1306, 538/.test(tc), 'only T-CONTs with an Alloc-ID are counted as assigned');
  ok(/11 unassigned/.test(tc) && !/16 provisioned/.test(tc), 'and Alloc-ID 255 is counted as unassigned');
  OMCI[262] = SAVED[262];
}
{
  const { bytes } = await import(join(root, 'web', 'dom.js'));
  ok(bytes(123.456789) === '123.46 B' && bytes(12345.678) === '12.3 kB' && bytes(1234.5) === '1.23 kB',
     'a rate never shows more than two decimals');
}

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
  const what = doc.querySelector('#trial-what').textContent;
  ok(/This image \(partition 0\) is not committed\. The next reboot returns to partition 1\./.test(what),
     'and says where the next reboot goes');
  ok(!/stock|holds/.test(what), 'without claiming what the other slot holds');
  ok(doc.querySelector('#trial-commit').hidden === false, 'with the Commit action');
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

/* --- the host-link banner and the Host port control ------------------------- */
{
  const { bannerText, trialLeft, renderHostlink } = await import(join(root, 'web', 'hostlink.js'));
  const keep = API['/api/hostlink'];
  const st = (o) => ({ setting: 'on', running: 'on', phase: 'steady', fallback: '0', ...o });

  let b = bannerText({ supported: true, state: st({}), safemode: null });
  ok(!b.show, 'host link: no banner in the default state');
  b = bannerText({ supported: true, state: st({ setting: 'off', running: 'off' }), safemode: null });
  ok(!b.show, 'host link: no banner while off runs as set');
  b = bannerText({ supported: true, state: st({ setting: 'off', running: 'on', fallback: '1' }), safemode: null });
  ok(b.show && !b.safe && !b.ack && /did not come up/.test(b.fallback) && !/\n/.test(b.fallback),
     'host link: the boot fallback raises its own bar, one short line, nothing to acknowledge');
  b = bannerText({ supported: true, state: st({}), safemode_now: null,
                  safemode: { short_boots: '5', cleared: 'none', build: 'v1.5.0' } });
  ok(b.show && b.ack && !b.fallback && /safe-mode boot happened \(build v1\.5\.0, after 5 short power cycles\)/.test(b.safe)
     && !/host port setting/.test(b.safe),
     'safe mode: a past safe-mode boot says the build and the count, with an acknowledgement');
  b = bannerText({ supported: true, state: st({}), safemode_now: { short_boots: '3', cleared: 'HOST_AUTONEG' },
                  safemode: { short_boots: '3', cleared: 'HOST_AUTONEG' } });
  ok(b.show && b.ack && /^Safe mode\./.test(b.safe) && /PON\) is off/.test(b.safe)
     && /default passwords/.test(b.safe) && /this boot only/.test(b.safe) && /host port setting/.test(b.safe)
     && b.safe.length < 220,
     'safe mode: this boot, one short line: PON off, default passwords for this boot only, what it cleared');
  b = bannerText({ supported: true, state: st({}), safemode_now: { short_boots: '5' }, safemode: null });
  ok(b.show && !b.ack && /Safe mode\./.test(b.safe) && /next boot is a normal boot/.test(b.safe),
     'safe mode: acknowledged during the boot, the bar stays without the button and says the next boot is normal');
  b = bannerText({ supported: false, state: {}, safemode_now: { short_boots: '5' }, safemode: {} });
  ok(b.show, 'safe mode: shown even on an image without host-autoneg.sh');
  b = bannerText({ supported: true, state: st({ setting: 'off', running: 'on', fallback: '1' }), safemode: {} });
  ok(b.safe && b.fallback && /several short/.test(b.safe), 'host link: a record and a fallback at once, two bars');
  ok(!bannerText({ supported: false, state: st({ fallback: '1', setting: 'off', running: 'on' }), safemode: null }).show,
     'host link: an image without host-autoneg.sh shows no fallback');
  ok(!bannerText(null).show, 'host link: an unreadable answer shows nothing');
  ok(trialLeft({ state: st({ phase: 'trial', trial_deadline: '420' }), uptime: '330' }) === 90,
     'host link: the countdown comes from the stick clock');
  ok(trialLeft({ state: st({}), uptime: '330' }) === null, 'host link: no trial, no countdown');

  API['/api/hostlink'] = { supported: true, state: st({ setting: 'off', running: 'on', fallback: '1' }),
                           safemode_now: null, safemode: { short_boots: '3' }, link: '1', uptime: '40' };
  await renderHostlink();
  const banner = doc.querySelector('#safebanner');
  ok(banner.hidden === false && doc.querySelector('#hostlink-ack').hidden === false,
     'host link: the safe-mode bar renders, with its Acknowledge button');
  ok(textOf(doc.querySelector('#safe-text')).includes('safe-mode boot happened'), 'host link: and its text');
  ok(doc.querySelector('#fallbackbanner').hidden === false
     && doc.querySelector('#safebanner').className === doc.querySelector('#trialbanner').className,
     'host link: the bars are the trial-boot band, and the fallback bar shows beside it');
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');
  ok(/id="safe-details" href="#system\/access"/.test(html) && /<details[^>]*id="safemode-help"/.test(html),
     'host link: Details points at the safe-mode help on System, Access, which exists');
  ok(!/id="hostlinkbanner"/.test(html), 'host link: the big card is gone');
  ok(textOf(doc.querySelector('#hostlink-now')).includes('Host link'), 'host link: status rows render');
  ok(doc.querySelector('#hostlink').hidden === false, 'host link: the Host port block shows on an image that has it');
  ok(doc.querySelector('#hostlink-keep-on').hidden === false,
     'host link: in the fallback the block offers to keep auto-negotiation on');
  ok(doc.querySelector('#hostlink-try').dataset.mode === 'off', 'host link: and to try off again');
  API['/api/hostlink'] = keep;
  await renderHostlink();
  ok(banner.hidden === true && doc.querySelector('#fallbackbanner').hidden === true,
     'host link: the default state takes the bars down again');
  ok(doc.querySelector('#hostlink-keep-on').hidden === true, 'host link: and the keep-on offer');
  API['/api/hostlink'] = { supported: false, state: {}, safemode: null, link: '', uptime: '1' };
  await renderHostlink();
  ok(doc.querySelector('#hostlink').hidden === true, 'host link: no block on an image without host-autoneg.sh');
  API['/api/hostlink'] = keep;
}

/* --- the management address trial ---------------------------------------- */
{
  const na = await import(join(root, 'web', 'netaddr.js'));
  const st = (o) => ({ phase: 'trial', applied: '1', trial_deadline: '420', prev_ip: '192.168.0.1',
                       old_LAN_ENABLE_IP2: '0', old_LAN_IP_ADDR2: '192.168.100.1',
                       new_LAN_IP_ADDR: '10.1.1.1', new_LAN_ENABLE_IP2: '0', new_LAN_IP_ADDR2: '192.168.100.1', ...o });
  const keep = API['/api/netaddr'];
  /* No real network and no real waiting: a loop left running would hold the process. */
  na.deps.probe = async () => false;
  na.deps.sleep = () => new Promise((r) => setImmediate(r));
  na.deps.navigate = () => {};

  ok(na.NET_KEYS.join() === 'LAN_IP_ADDR,LAN_SUBNET,LAN_ENABLE_IP2,LAN_IP_ADDR2,LAN_SUBNET2'
     && na.isNetKey('LAN_SUBNET2') && !na.isNetKey('HOST_AUTONEG') && !na.isNetKey('LAN_SDS_MODE'),
     'address trial: the five keys, and no other');
  ok(na.trialLeft({ state: st({}), uptime: '330' }) === 90, 'address trial: the countdown comes from the stick clock');
  ok(na.trialLeft({ state: st({ phase: 'steady' }), uptime: '330' }) === null, 'address trial: no trial, no countdown');
  ok(na.freshAddrs({ state: st({}) }).join() === '10.1.1.1', 'address trial: the new primary is the address to keep on');
  ok(na.freshAddrs({ state: st({ new_LAN_IP_ADDR: '192.168.0.1' }) }).length === 0,
     'address trial: nothing is new when only the netmask moved');
  ok(na.freshAddrs({ state: st({ new_LAN_IP_ADDR: '192.168.0.1', new_LAN_ENABLE_IP2: '1', new_LAN_IP_ADDR2: '172.20.0.1' }) }).join() === '172.20.0.1',
     'address trial: a new second address is the one to keep on');
  ok(na.freshAddrs({ state: st({ new_LAN_IP_ADDR: '192.168.100.1', old_LAN_ENABLE_IP2: '1' }) }).length === 0,
     'address trial: the old second address as the new primary already answered');
  let v = na.dialogView({ state: st({}), via: '192.168.0.1' });
  ok(!v.canKeep && v.link === 'http://10.1.1.1/' && /already had/.test(v.text) && /Revert works from here/.test(v.text),
     'address trial: on the old address the dialog points at the new one and offers no Keep');
  v = na.dialogView({ state: st({}), via: '10.1.1.1' });
  ok(v.canKeep && v.link === null && /new address \(10\.1\.1\.1\)/.test(v.text),
     'address trial: on the new address Keep is offered');
  v = na.dialogView({ state: st({ new_LAN_IP_ADDR: '192.168.0.1' }), via: '192.168.0.1' });
  ok(v.canKeep && /netmask/.test(v.text), 'address trial: a netmask-only change leaves the decision to the stick');

  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');
  for (const id of ['netaddr-dialog', 'netaddr-count', 'netaddr-text', 'netaddr-link', 'netaddr-keep', 'netaddr-revert',
                    'netaddr-dialog-out', 'netaddr-follow', 'netaddr-result', 'netaddr-result-text', 'netaddr-result-link', 'netaddr-result-ok']) {
    ok(html.includes(`id="${id}"`), `address trial: index.html has #${id}`);
  }

  API['/api/netaddr'] = { supported: true, state: { phase: 'steady' }, via: '192.168.0.1', peer: '192.168.0.50', uptime: '300' };
  await na.renderNetaddr();
  ok(na.netaddrActive(), 'address trial: an image with the script is active');
  API['/api/netaddr'] = { supported: false, state: {}, via: '192.168.0.1', peer: '', uptime: '300' };
  await na.renderNetaddr();
  ok(!na.netaddrActive(), 'address trial: an image without it, or a safe-mode boot, is not');
  API['/api/netaddr'] = { supported: true, state: st({}), via: '192.168.0.1', peer: '', uptime: '330' };
  await na.renderNetaddr();
  ok(doc.querySelector('#netaddr-dialog').hidden === false && doc.querySelector('#netaddr-keep').disabled === true
     && /Reverting in 90 s/.test(textOf(doc.querySelector('#netaddr-count')))
     && doc.querySelector('#netaddr-link').href === 'http://10.1.1.1/',
     'address trial: a page loaded mid-trial raises the dialog with the countdown and the new address');
  na.stopFollow();

  /* The redirect: where the browser is sent, and how the page finds out the
     new address answers. */
  ok(na.originOf('10.1.1.1', {}) === 'http://10.1.1.1/'
     && na.originOf('10.1.1.1', { protocol: 'https:', port: '8443' }) === 'https://10.1.1.1:8443/',
     'redirect: the scheme and the port the page was loaded with are kept');
  ok(na.redirectTargets({ state: st({}), via: '192.168.0.1' }).join() === 'http://10.1.1.1/',
     'redirect: from the old address the target is the new one');
  ok(na.redirectTargets({ state: st({}), via: '10.1.1.1' }).length === 0,
     'redirect: a page already on the new address goes nowhere');
  ok(na.redirectTargets({ state: st({ new_LAN_IP_ADDR: '192.168.0.1' }), via: '192.168.0.1' }).length === 0,
     'redirect: a netmask-only change has no address to go to');
  ok(na.redirectTargets({ state: st({ new_LAN_ENABLE_IP2: '1', new_LAN_IP_ADDR2: '172.20.0.1' }), via: '192.168.0.1' }).join()
     === 'http://10.1.1.1/,http://172.20.0.1/',
     'redirect: a new second address is a target too, after the primary');
  ok(na.redirectTargets({ state: st({ new_LAN_IP_ADDR: '192.168.0.1', new_LAN_ENABLE_IP2: '1', new_LAN_IP_ADDR2: '172.20.0.1' }), via: '192.168.0.1' }).join()
     === 'http://172.20.0.1/', 'redirect: only the second address changed, only it is a target');
  const seen = [];
  const answers = async (u, o) => { seen.push([u, o]); return {}; };
  const refuses = async () => { throw new TypeError('Failed to fetch'); };
  ok(await na.probeAddr('http://10.1.1.1/', answers, 50) === true
     && seen[0][1].mode === 'no-cors' && seen[0][1].credentials === 'omit' && seen[0][1].cache === 'no-store'
     && /^http:\/\/10\.1\.1\.1\/\?probe=\d+$/.test(seen[0][0]),
     'redirect: the probe is a no-cors fetch with no credentials, which needs no CORS grant');
  ok(await na.probeAddr('http://10.1.1.1/', refuses, 50) === false, 'redirect: an address that does not answer is not found');
  const only = (want) => async (u) => u === want;
  ok(await na.firstAnswering(['http://a/', 'http://b/'], only('http://b/')) === 'http://b/'
     && await na.firstAnswering(['http://a/', 'http://b/'], async () => true) === 'http://a/'
     && await na.firstAnswering(['http://a/'], async () => false) === null,
     'redirect: the first address that answers wins, the primary before the second');
  {
    let round = 0;
    const log = [], went = [];
    const hit = await na.followLoop(['http://10.1.1.1/'], {
      alive: () => true, probe: async () => ++round > 5, sleep: async () => {},
      status: (k) => log.push(k), go: (u) => went.push(u),
    });
    ok(hit === 'http://10.1.1.1/' && went.join() === 'http://10.1.1.1/' && log[0] === 'looking'
       && log.includes('stuck') && log[log.length - 1] === 'found',
       'redirect: it keeps looking, says so when nothing answers, and goes when it does');
    let n = 0;
    const gone = [];
    const none = await na.followLoop(['http://10.1.1.1/'], {
      alive: () => ++n < 4, probe: async () => false, sleep: async () => {}, status: () => {}, go: (u) => gone.push(u),
    });
    ok(none === null && !gone.length, 'redirect: when the trial ends it stops and goes nowhere');
  }
  ok(/password again/.test(na.followText('found', 'http://10.1.1.1/')) && /Revert/.test(na.followText('stuck', ['http://10.1.1.1/'])),
     'redirect: the page says the password is asked again, and what to do when nothing answers');
  {
    const store = new Map();
    globalThis.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    const h = { state: st({}), via: '192.168.0.1' };
    ok(!na.wasFollowed(h), 'redirect: a new trial has not been followed');
    na.markFollowed(h);
    ok(na.wasFollowed(h) && !na.wasFollowed({ state: st({ trial_deadline: '999' }) }),
       'redirect: followed once per trial, so Back from the new address does not bounce again');
    globalThis.sessionStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    ok(na.wasFollowed(h) === false, 'redirect: storage blocked, the page still works');
    store.clear();
    globalThis.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    const went = [];
    na.deps.navigate = (u) => went.push(u);
    na.deps.sleep = () => new Promise((r) => setImmediate(r));
    na.deps.probe = async () => true;
    API['/api/netaddr'] = { supported: true, state: st({}), via: '192.168.0.1', peer: '', uptime: '330' };
    await na.renderNetaddr();
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    ok(went.join() === 'http://10.1.1.1/' && store.get('odi-netaddr-followed') === '420',
       'redirect: a page on the old address, mid-trial, opens the new address once it answers');
    na.stopFollow();
    API['/api/netaddr'] = keep;
    await na.renderNetaddr();
    went.length = 0;
    API['/api/netaddr'] = { supported: true, state: st({}), via: '192.168.0.1', peer: '', uptime: '331' };
    await na.renderNetaddr();
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    ok(!went.length && /does not do it again/.test(textOf(doc.querySelector('#netaddr-follow'))),
       'redirect: coming back to the old page does not redirect again, and says so');
    na.stopFollow();
    store.clear();
    API['/api/netaddr'] = { supported: true, state: st({ new_LAN_IP_ADDR: '192.168.0.1' }), via: '192.168.0.1', peer: '', uptime: '331' };
    await na.renderNetaddr();
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    ok(!went.length, 'redirect: a netmask-only trial opens nothing');
    na.stopFollow();
    na.deps.probe = async () => false;
    API['/api/netaddr'] = { supported: true, state: st({}), via: '192.168.0.1', peer: '', uptime: '331' };
    await na.renderNetaddr();
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    ok(!went.length && /(Looking for the new address|does not answer from this computer yet)/.test(textOf(doc.querySelector('#netaddr-follow'))) && /10\.1\.1\.1/.test(textOf(doc.querySelector('#netaddr-follow'))),
       'redirect: while nothing answers the page stays, says what it is waiting for');
    na.stopFollow();
    na.deps.probe = null; na.deps.sleep = null;
    delete globalThis.sessionStorage;
  }
  API['/api/netaddr'] = keep;
  await na.renderNetaddr();
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
  ok(/Commit to partition 1/.test(t) && !/Keep/.test(t), 'the running, uncommitted slot offers Commit to partition 1');
  ok(/Committed/.test(t) && !/Kept/.test(t), 'and the committed slot is badged Committed');
  t = await fwText({ ...trialFW, exe: '/etc/config/confd/confd' });
  ok(/override in \/etc\/config is in use/.test(t), 'a confd run from /etc/config is an override');
  t = await fwText({ ...trialFW, env: { sw_active: '1', sw_commit: '1', sw_tryactive: '2' }, exe: '/bin/confd',
                     slots: { 0: { kernel: 'Linux Kernel Image', built: 1600000000 } } });
  ok(/Try partition 0/.test(t) && !/Try partition 1/.test(t), 'committed, Try is offered on the other slot only');
  t = await fwText({ ...trialFW, env: { sw_active: '1', sw_commit: '1', sw_tryactive: '2' }, exe: '/bin/confd' });
  ok(!/Try partition/.test(t) && /holds no kernel the bootloader would boot/.test(t),
     'a slot with no uImage header gets no Try button, and says why');
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
const GROUP_HOSTS = ['line', 'vlan', 'identity', 'expert', 'network', 'services', 'other'].map((g) => '#set-' + g);
const hostsOf = (sel) => (sel === '#common' ? GROUP_HOSTS : [sel]).map((h) => doc.querySelector(h));
const rowsOf = (sel) => {
  const out = [];
  for (const host of hostsOf(sel)) walk(host, (n) => { if (n.classList && n.classList.contains('setting')) out.push(n); });
  return out;
};
const inputsOf = (sel) => {
  let n = 0;
  /* A table editor is one control, however many rows it holds. */
  const count = (x) => {
    if (x.classList && x.classList.contains('fme')) { n++; return; }
    if (x.tagName === 'input' || x.tagName === 'select') n++;
    for (const c of x.children || []) count(c);
  };
  for (const host of hostsOf(sel)) count(host);
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
const { OWN_CONTROL } = await import(join(root, 'web', 'config.js'));
ok(rowsOf(stock).length === SCHEMA.length - SETT.length - OWN_CONTROL.length,
   'the stock keys are all on their own tab (the keys with a control of their own are on neither)');
ok(![stock, common].some((v) => /HOST_AUTONEG|Host port auto-negotiation/.test(textOf(doc.querySelector(v)))),
   'HOST_AUTONEG is no schema row: only the Host port control changes it');
ok(inputsOf(stock) === 0, 'and none of them can be edited there');
ok(doc.querySelector('#device-login').hidden === true,
   'the stock device-login section is not offered');

/* The two SERVICE RESTART keys are editable and validate as host[:port]. */
ok(tagsOf(common).includes('Service restart'), 'SYSLOG_SERVER / NTP_SERVER carry SERVICE RESTART');

/* Help text: one line shown, the rest behind Details, and nothing said twice.
   meta.tsv and settings.tsv were written apart, and the page used to print
   the syslog and NTP explanations twice over, and "re-ranges" on every VLAN
   row twice. */
const { splitHelp, GROUPS } = await import(join(root, 'web', 'config.js'));
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
const hwv = (v) => valueProblem({ name: 'ONU_HW_VERSION', type: 'ascii14' }, v);
ok(!hwv('HW-2.1') && !hwv('12345678901234') && !hwv(''),
   'ascii14 accepts up to 14 printable characters, and empty (it clears the key)');
ok(['123456789012345', 'a"b', 'a<b', 'a&b', 'caf\u00e9', 'a\tb'].every((v) => hwv(v)),
   'ascii14 rejects 15 characters, a quote, < and &, and anything outside printable ASCII');
/* Types chosen by what reads the key: the page and the daemon (src/mib.c) agree. */
const vp = (type, v) => valueProblem({ name: 'X', type }, v);
ok(['10.20.30.1', '192.168.100.1', '1.0.0.1', '223.255.255.254'].every((v) => !vp('ipv4host', v)),
   'ipv4host accepts addresses the kernel takes');
ok(['0.0.0.0', '127.0.0.1', '224.0.0.1', '255.255.255.255', '192.168.010.1', '192.168.1', '1.2.3.4.5', '256.1.1.1']
  .every((v) => vp('ipv4host', v)), 'ipv4host rejects 0/8, loopback, multicast, broadcast, leading zeros and malformed');
/* The address and its netmask are judged together (src/mib.c lan_pair_refusal,
   network.sh valid_host): the same values are accepted and refused. */
{
  const { S: St, EDITS: Ed } = await import(join(root, 'web', 'state.js'));
  const addr = (v, name = 'LAN_IP_ADDR') => valueProblem({ name, type: 'ipv4host' }, v);
  const mask = (v, name = 'LAN_SUBNET') => valueProblem({ name, type: 'netmask' }, v);
  const keep = St.VALUES;
  St.VALUES = {};
  Ed.clear();
  ok(['192.168.1.0', '192.168.1.255', '10.0.0.0', '10.255.255.255'].every((v) => /network or broadcast/.test(addr(v))),
     'with no stored netmask the address is judged on a /24: network and broadcast are refused');
  ok(['192.168.1.1', '192.168.1.254', '10.0.0.1'].every((v) => !addr(v)), 'and its neighbours are accepted');
  ok(/network or broadcast/.test(addr('192.168.100.255', 'LAN_IP_ADDR2')) && !addr('192.168.100.1', 'LAN_IP_ADDR2'),
     'the second address is held to the same rule');
  St.VALUES = { LAN_SUBNET: '255.255.254.0', LAN_IP_ADDR: '192.168.0.0' };
  ok(/network or broadcast/.test(addr('192.168.1.255')) && !addr('192.168.1.0') && /network or broadcast/.test(addr('192.168.0.0')),
     'against the stored /23: 192.168.1.255 and 192.168.0.0 are refused, 192.168.1.0 is a host');
  ok(/netmask that makes/.test(mask('255.255.254.0')) && !mask('255.0.0.0'),
     'a netmask is judged against the stored address: the /23 makes 192.168.0.0 a network address, a /8 does not');
  Ed.set('LAN_SUBNET', '255.255.255.252');
  ok(/network or broadcast/.test(addr('192.168.1.7')) && /network or broadcast/.test(addr('192.168.1.4')) && !addr('192.168.1.5'),
     'a pending netmask edit counts: on a /30, .4 and .7 are refused, .5 is a host');
  Ed.clear();
  St.VALUES = { LAN_SUBNET: '255.0.255.0' };
  ok(!addr('192.168.1.255'), 'an unusable stored netmask is not this check (it has its own message)');
  St.VALUES = keep;
}
ok(['255.255.255.0', '255.0.0.0', '255.255.255.252', '255.255.128.0'].every((v) => !vp('netmask', v)),
   'netmask accepts ones then zeros from /8 to /30');
ok(['255.0.255.0', '0.0.0.0', '255.255.255.255', '255.255.255.254', '254.0.0.0', '255.255.255.1', '255.255.255.00']
  .every((v) => vp('netmask', v)), 'netmask rejects a gap in the ones, /0, /31, /32, shorter than /8 and leading zeros');
ok(!vp('gponsn', 'ODI0123456aB') && !vp('gponsn', 'TMBB0077D9B9'), 'gponsn accepts four characters and eight hex digits');
ok(['ODI12345678', 'ODI0123456789', 'ODI01234567G', 'OD 012345678', 'ODI"01234567', ''].every((v) => vp('gponsn', v)),
   'gponsn rejects 11 and 13 characters, a non-hex serial, a space and a quote');
ok(!vp('hex20', '31323334353637383930'), 'hex20 accepts 20 hex digits');
ok(['3132333435363738393', '313233343536373839303132', '1234', 'zz323334353637383930'].every((v) => vp('hex20', v)),
   'hex20 rejects odd, longer, shorter and non-hex values (the kernel would read a shorter one as text)');
ok(!vp('str14', 'V1.1.6-2402021') && vp('str14', 'V1.1.6-24020212') && vp('str14', 'a"b') && vp('str14', 'caf\u00e9'),
   'strN accepts up to N printable characters and rejects one more, a quote and non-ASCII');
ok(!vp('elanmac', '023a21282716') && vp('elanmac', '010203040506') && vp('elanmac', '000000000000') && vp('elanmac', '0102030405'),
   'elanmac rejects a multicast and an all-zero address');
ok(!vp('mac', '023a21282716') && !vp('mac', '010203040506') && !vp('mac', '000000000000') && vp('mac', '0102030405'),
   'mac is plain 12 hex digits: HW_SERIAL_NO and WLAN_MAC_ADDR are not held to the unicast rule');
ok(S.SCHEMA.find((r) => r.name === 'ELAN_MAC_ADDR').type === 'elanmac'
   && S.SCHEMA.find((r) => r.name === 'HW_SERIAL_NO').type === 'mac', 'only ELAN_MAC_ADDR has the unicast type');
ok(['LAN_IP_ADDR', 'LAN_IP_ADDR2'].every((n) => S.SCHEMA.find((r) => r.name === n).type === 'ipv4host')
   && ['LAN_SUBNET', 'LAN_SUBNET2'].every((n) => S.SCHEMA.find((r) => r.name === n).type === 'netmask')
   && S.SCHEMA.find((r) => r.name === 'GPON_SN').type === 'gponsn'
   && S.SCHEMA.find((r) => r.name === 'GPON_PLOAM_PASSWD').type === 'hex20',
   'the schema gives the address, mask, serial number and PLOAM keys their checks');
const fme = (v) => valueProblem({ name: 'OMCI_FIXED_ME', type: 'fixedme' }, v);
ok(!fme('200:0x0011aa') && !fme('200:0x0011aa,201:01020304') && !fme('1:aa 65535:0XAB, 7:'+'ff'.repeat(25)) && !fme(''),
   'fixedme accepts one or more CLASS:HEX entries, either separator, and empty (it clears the key)');
ok(['0:aa', '65536:aa', '200aa', '200:abc', '200:zz', '200:0x', '200:aa,200:bb', '200:' + 'ff'.repeat(26),
  ',200:aa', '200:aa,', ...Array(1).fill(Array.from({ length: 17 }, (_, i) => `${i + 1}:aa`).join(','))].every((v) => fme(v)),
   'fixedme rejects class 0 and 65536, a missing colon, odd digits, non-hex, 26 bytes, a duplicate class and 17 entries');
ok(!fme(Array.from({ length: 16 }, (_, i) => `${i + 1}:aa`).join(',')), 'fixedme accepts sixteen entries');
ok(!fme('188:0x8001:1:0x0011aa') && !fme('188:32769:1:00,188:0x8001:2:ff 188:0xFFFF:16:' + 'ab'.repeat(25))
   && !fme('188:0:1:00,200:aa') && !fme('188:1:1:00 188:1:2:00 188:2:1:00'),
   'fixedme accepts CLASS:INSTANCE:ATTR:HEX, decimal or 0x instance, several attributes, and both forms on different classes');
ok(['188:0x8001:0:00', '188:0x8001:17:00', '188:0x8001:001:00x', '188:0x10000:1:00', '188:65536:1:00',
  '188:0x:1:00', '188:-1:1:00', '188:1:1', '188::1:00', '188:1::00', '188:1:2:3:00', '0xbc:1:1:00',
  '188:1:1:0', '188:1:1:0x', '188:1:1:' + 'ff'.repeat(26),
  '188:1:1:00,188:0x1:1:01', '188:0x8001:1:00 188:32769:1:01',   /* the same slot twice, spelled two ways */
  '188:00,188:1:1:00', '188:1:1:00,188:00']   /* a class in both forms, either order */
  .every((v) => fme(v)),
  'fixedme rejects attribute 0 and 17, an instance past 65535, a missing field, a slot twice and a class in both forms');
{
  const rows = fixedMeParse('200:0011aa,188:0x8001:1:ff');
  ok(rows.length === 2 && rows[0].inst === 'any' && rows[0].attr === 'any' && rows[0].hex === '0011aa'
     && rows[1].cls === '188' && rows[1].inst === '0x8001' && rows[1].attr === '1' && rows[1].hex === 'ff',
     'fixedMeParse: the legacy form reads as any/any, the entry form as typed');
  ok(fixedMeSerialise(rows) === '200:0011aa,188:0x8001:1:ff', 'fixedMeSerialise: the round trip keeps the text');
  ok(fixedMeSerialise([{ cls: '', inst: '', attr: '', hex: '' }, { cls: '5', inst: 'any', attr: '', hex: 'aa' }]) === '5:aa',
     'fixedMeSerialise: an empty row is dropped, any/empty is the legacy form');
  ok(fme(fixedMeSerialise([{ cls: '5', inst: '1', attr: '', hex: 'aa' }])), 'an unfinished row serialises to a string the check refuses');
  ok(fixedMeRowProblems({ cls: '0', inst: 'x', attr: '3', hex: 'a' }).cls && fixedMeRowProblems({ cls: '0', inst: 'x', attr: '3', hex: 'a' }).inst
     && fixedMeRowProblems({ cls: '0', inst: 'x', attr: '3', hex: 'a' }).hex && !fixedMeRowProblems({ cls: '5', inst: 'any', attr: '', hex: 'aa' }).inst,
     'fixedMeRowProblems names the fields that are wrong');
  /* The editor: one table row per entry, and a row it adds. */
  const ed = renderFixedMeEditor('200:0011aa,188:0x8001:1:ff', () => {});
  const trs = ed.tableLine.children[0].children[1].children;
  ok(trs.length === 2 && trs[0].inputs.map((i) => i.value).join('|') === '200|any|any|0011aa'
     && trs[1].inputs.map((i) => i.value).join('|') === '188|0x8001|1|ff',
     'the expert editor shows one row per entry, the legacy form as any/any');
  let seen = null;
  const ed2 = renderFixedMeEditor('', (v) => { seen = v; });
  ok(ed2.tableLine.children[0].children[1].children.length === 0, 'the expert editor with no value has no rows');
  ed2.children[2].onclick();
  const row0 = ed2.tableLine.children[0].children[1].children[0];
  row0.inputs[0].value = '188'; row0.inputs[0].oninput();
  ok(seen === '188:', 'a half-typed row is handed on as typed, so the check holds the save');
  row0.inputs[1].value = '0x8001'; row0.inputs[1].oninput();
  row0.inputs[2].value = '1'; row0.inputs[2].oninput();
  row0.inputs[3].value = '0011aa'; row0.inputs[3].oninput();
  ok(seen === '188:0x8001:1:0011aa' && !fme(seen), 'a finished row serialises to the entry form');
  ed2.children[2].onclick();
  const r1 = ed2.tableLine.children[0].children[1].children[1];
  r1.inputs[0].value = '188'; r1.inputs[0].oninput();
  r1.inputs[3].value = '00'; r1.inputs[3].oninput();
  ok(fme(seen) && /both forms/.test(fme(seen)), 'a legacy row for a class that has an entity says both forms');
  r1.children[4].children[0].onclick();
  ok(seen === '188:0x8001:1:0011aa', 'removing a row removes its entry');
}
{
  const setting = (n) => SETT.find((r) => r.name === n);
  ok(['VLAN_CFG_TYPE', 'VLAN_MANU_MODE', 'VLAN_MANU_TAG_VID', 'VLAN_MANU_TAG_PRI']
    .every((n) => setting(n) && setting(n).apply === 'live' && setting(n).action === 'omci'),
  'the four VLAN keys are live and applied by omci');
  ok(setting('OLT_SW_DOWNLOAD').apply === 'live' && setting('OLT_SW_DOWNLOAD').action === 'none',
    'OLT_SW_DOWNLOAD is live with nothing to apply');
  ok(setting('OMCI_ACCEPT_REBOOT').apply === 'live' && setting('OMCI_ACCEPT_REBOOT').action === 'none',
    'OMCI_ACCEPT_REBOOT is live with nothing to apply');
  ok(['ONU_HW_VERSION', 'OMCI_UNKNOWN_ME_OK', 'OMCI_FIXED_ME', 'GPON_SN'].every((n) => setting(n).apply === 'internet' && setting(n).action === 'omci'),
    'the hardware version, unknown-entity answers and serial number re-register the ONU');
  /* A value that can cut the service says so in its own label, and the
     one that cannot does not: the choice is made in the dropdown, where the
     help text is not. */
  const opts = (n) => Object.fromEntries(META.find((x) => x.name === n).options.split('|')
    .map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
  const cuts = /service stops unless the router tags/;
  const mode = opts('VLAN_MANU_MODE');
  ok(META.find((x) => x.name === 'VLAN_MANU_MODE').options.split('|').map((p) => p[0]).join(',') === '1,0'
     && /Stick tags/.test(mode[1]) && /Router tags \(transparent\)/.test(mode[0]),
    'VLAN_MANU_MODE offers stick tags and router tags (transparent)');
  ok(cuts.test(mode[0]) && !cuts.test(mode[1]),
    'VLAN_MANU_MODE: router tags says the service stops unless the router tags, stick tags does not');
  const type = opts('VLAN_CFG_TYPE');
  ok(cuts.test(type[0]) && !cuts.test(type[1]),
    'VLAN_CFG_TYPE: transparent says the service stops unless the router tags, manual does not');
  ok(/silently missing/.test(opts('OMCI_UNKNOWN_ME_OK')[1]) && !/missing/.test(opts('OMCI_UNKNOWN_ME_OK')[0]),
    'OMCI_UNKNOWN_ME_OK: on names its risk in the label, off does not');
  ok(Object.values(opts('OLT_SW_DOWNLOAD')).every((l) => /service is not touched/.test(l)),
    'OLT_SW_DOWNLOAD: both values say the service is not touched');
  ok(/removes it at once/.test(opts('LAN_ENABLE_IP2')[0]),
    'LAN_ENABLE_IP2: off says the address goes at once');
  /* The first sentence is the one shown without opening Details. */
  const first = (n) => splitHelp(META.find((x) => x.name === n).help,
    (SETT.find((r) => r.name === n) || {}).note).first;
  for (const [n, re] of [['VLAN_CFG_TYPE', /service then stops/], ['VLAN_MANU_MODE', /service stops/],
    ['VLAN_MANU_TAG_VID', /stops the service at once/], ['GPON_SN', /no service/],
    ['GPON_PLOAM_PASSWD', /refuses the ONU/], ['LOID', /refuses the ONU/]]) {
    ok(re.test(first(n)), `${n}: the visible help says how a value can cut the service`);
  }
  ok(['ONU_HW_VERSION', 'OLT_SW_DOWNLOAD', 'OMCI_ACCEPT_REBOOT'].every((n) => GROUPS.identity.includes(n)),
    'the new OLT-facing keys sit on the ONU identity subtab');
  ok(GROUPS.expert.join() === 'OMCI_UNKNOWN_ME_OK,OMCI_FIXED_ME,OMCI_VEIP,OMCI_VEIP_SLOT_ID,OMCI_PRIVATE_ME,OMCI_POTS_PORTS,OMCI_POTS_SLOT_ID,OMCI_VOIP_LINE_REPORT'
     && !GROUPS.identity.includes('OMCI_FIXED_ME') && !GROUPS.identity.includes('OMCI_UNKNOWN_ME_OK'),
    'the unknown-entity, fixed-entity, VEIP and vendor-private keys are expert settings, not in the ONU identity list');
  ok(['OMCI_VEIP', 'OMCI_VEIP_SLOT_ID', 'OMCI_PRIVATE_ME'].every((n) => setting(n).apply === 'internet' && setting(n).action === 'omci'),
    'the VEIP, VEIP slot and vendor-private keys re-register the ONU');
  ok(setting('OMCI_VEIP').unset === '1' && setting('OMCI_PRIVATE_ME').unset === '1',
    'the VEIP and the vendor-private entities are created while the key is unset');
  const veipOpts = META.find((x) => x.name === 'OMCI_VEIP').options.split('|').map((p) => p[0]).join(',');
  ok(veipOpts === '1,0' && /PPTP-only/.test(opts('OMCI_VEIP')[0]),
    'OMCI_VEIP offers create and none, and none says what it means');
  ok(META.find((x) => x.name === 'OMCI_VEIP_SLOT_ID').range === '2-254',
    'OMCI_VEIP_SLOT_ID takes a slot of 2 to 254');
}

EDITS.set('LOID', 'someone');
const pw = withPairs([...EDITS.entries()]);
ok(pw.some(([k, v]) => k === 'LOID_OLD' && v === 'someone'),
   'saving LOID writes LOID_OLD too, since the OLD value wins');
EDITS.clear();

/* The VLAN keys are LIVE, so a value that stops the traffic is asked about
   before the save, not after it: the ONU stays in O5 and nothing else would
   say so. */
{
  const { vlanRisk } = state;
  const base = { VLAN_CFG_TYPE: '1', VLAN_MANU_MODE: '1', VLAN_MANU_TAG_VID: '11', VLAN_MANU_TAG_PRI: '0' };
  ok(/stops tagging VLAN 11/.test(vlanRisk(base, { ...base, VLAN_MANU_MODE: '0' }) || ''),
     'vlanRisk: router tags stops the stick tagging VLAN 11');
  ok(/stops tagging VLAN 11/.test(vlanRisk(base, { ...base, VLAN_CFG_TYPE: '0' }) || ''),
     'vlanRisk: config mode 0 does the same');
  ok(/VLAN 12 instead of 11/.test(vlanRisk(base, { ...base, VLAN_MANU_TAG_VID: '12' }) || ''),
     'vlanRisk: another VLAN ID says which one replaces which');
  ok(/starts tagging untagged frames with VLAN 11/.test(
       vlanRisk({ ...base, VLAN_MANU_MODE: '0' }, base) || ''),
     'vlanRisk: turning tagging on names the VLAN');
  ok(vlanRisk(base, { ...base, VLAN_MANU_TAG_PRI: '3' }) === null && vlanRisk(base, base) === null,
     'vlanRisk: a priority change, or no change, asks nothing');

  const { save, refreshSaveBar, followUp } = await import(join(root, 'web', 'save.js'));
  const realFetch = globalThis.fetch;
  const posts = [];
  globalThis.fetch = async (path, opts) => {
    if (opts && opts.method === 'POST') posts.push([String(path), String(opts.body)]);
    return realFetch(path, opts);
  };
  const asked = [];
  globalThis.confirm = (t) => { asked.push(t); return false; };
  EDITS.set('VLAN_MANU_MODE', '0');
  refreshSaveBar();
  await save();
  ok(asked.length === 1 && /stops tagging VLAN 1\b/.test(asked[0]) && /^\u25AE Live/.test(asked[0]),
     'save: router tags asks first, as a Live change that stops the tagging');
  ok(posts.length === 0 && /Not saved/.test(textOf(doc.querySelector('#saveout'))),
     'save: declined, nothing is written');
  globalThis.confirm = (t) => { asked.push(t); return true; };
  await save();
  ok(posts.some(([p, b]) => p === '/api/config' && /VLAN_MANU_MODE=0/.test(b)),
     'save: accepted, the change is written');
  EDITS.clear();
  globalThis.fetch = realFetch;
  globalThis.confirm = () => false;

  /* A key the firmware ignores is shown, not offered, and says why; choosing
     the mode that reads it unlocks it before anything is saved. */
  {
    const { invalidEdits } = await import(join(root, 'web', 'validate.js'));
    const field = (name) => {
      let f = null;
      walk(doc.querySelector('#set-vlan'), (x) => {
        if ((x.tagName === 'input' || x.tagName === 'select') && x.dataset && x.dataset.name === name) f = x;
      });
      return f;
    };
    const vidRow = () => rowsOf('#set-vlan').find((r) => r.dataset.name === 'VLAN_MANU_TAG_VID');
    renderAll();
    ok(field('VLAN_MANU_TAG_VID') !== null, 'gated: the VLAN ID is editable in manual mode');
    EDITS.set('VLAN_MANU_TAG_VID', '100');
    const mode = field('VLAN_CFG_TYPE');
    mode.value = '0';
    mode.oninput();
    ok(field('VLAN_MANU_TAG_VID') === null && /Not editable now/.test(textOf(vidRow()))
       && /VLAN_CFG_TYPE=1/.test(textOf(vidRow())),
       'gated: config mode 0 locks the VLAN ID and names the key that unlocks it');
    ok(/Not used in this mode/.test(textOf(vidRow())) && /Stored/.test(textOf(vidRow())),
       'gated: and shows no value in the field, only under Details');
    ok(!EDITS.has('VLAN_MANU_TAG_VID'), 'gated: and drops the VLAN ID edit made before');
    field('VLAN_CFG_TYPE').value = '1';
    field('VLAN_CFG_TYPE').oninput();
    ok(field('VLAN_MANU_TAG_VID') !== null && !EDITS.has('VLAN_CFG_TYPE'),
       'gated: setting mode 1 back unlocks it, with nothing pending');
    EDITS.set('VLAN_CFG_TYPE', '0');
    EDITS.set('VLAN_MANU_TAG_VID', '100');
    ok(invalidEdits().some(([k, why]) => k === 'VLAN_MANU_TAG_VID' && /ignored by the firmware/.test(why)),
       'gated: Save refuses a leftover edit to an ignored key');
    EDITS.clear();
    renderAll();
  }

  /* OMCI_VEIP_SLOT_ID does nothing without bit 256 of OMCI_CUSTOM_ME, which
     the page cannot edit: the row says so, and says what to run. */
  {
    const slotRow = () => rowsOf('#set-expert').find((r) => r.dataset.name === 'OMCI_VEIP_SLOT_ID');
    S.VALUES.OMCI_CUSTOM_ME = '65536';
    renderAll();
    ok(slotRow() && /Has no effect yet/.test(textOf(slotRow())) && /flash set OMCI_CUSTOM_ME 65792/.test(textOf(slotRow())),
       'VEIP slot: without bit 256 the row says it does nothing and gives the value to set');
    S.VALUES.OMCI_CUSTOM_ME = '65792';
    renderAll();
    ok(slotRow() && !/Has no effect yet/.test(textOf(slotRow())), 'VEIP slot: with bit 256 set there is no warning');
    S.VALUES.OMCI_CUSTOM_ME = '1';
    renderAll();
  }

  /* An identity key the switch keeps from the OLT changes nothing on the
     line: no cost in the save bar, and no Apply now after the save. */
  EDITS.set('OMCI_SW_VER1', 'V9');
  refreshSaveBar();
  ok(textOf(doc.querySelector('#saveclasses')) === '',
     'save bar: an unreported identity key carries no cost');
  EDITS.clear();
  refreshSaveBar();
  const out1 = new El('div');
  await followUp({ needs: ['omci'], interrupts: true }, ['OMCI_SW_VER1'], out1);
  ok(/Not reported to the OLT/.test(textOf(out1)) && !/Apply now/.test(textOf(out1)),
     'followUp: an unreported identity key is not offered Apply now');
  const out2 = new El('div');
  await followUp({ needs: ['omci'], interrupts: true }, ['GPON_SN'], out2);
  ok(/Apply now/.test(textOf(out2)), 'followUp: the serial number is offered Apply now');
  const out3 = new El('div');
  await followUp({ needs: ['omci'], interrupts: true }, ['OMCI_SW_VER1', 'GPON_SN'], out3);
  ok(/Apply now/.test(textOf(out3)), 'followUp: and so is a batch with one reported key in it');
}

/* Without the table, the page is what it was: every key offered. */
for (const k of Object.keys(S.SETTINGS)) delete S.SETTINGS[k];
renderAll();
ok(inputsOf('#sections') > 100,
   'with no settings table every key is editable, as before');

/* The theme toggle: default follows the browser, a click sets data-theme on
   <html>, persists it, and flips the label; storage that throws is survived. */
{
  const dom = await import(join(root, 'web', 'dom.js'));
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  globalThis.matchMedia = () => ({ matches: false, addEventListener: () => {} });
  const btn = doc.querySelector('#themetoggle');
  let click;
  btn.addEventListener = (ev, fn) => { if (ev === 'click') click = fn; };
  ok(!doc.documentElement.dataset.theme && dom.currentTheme() === 'dark',
     'theme: no choice made follows the browser (dark here)');
  dom.wireTheme();
  ok(btn.getAttribute('aria-label') === 'Switch to light mode', 'theme: label names the mode it switches to');
  ok(doc.querySelector('#ico-sun').getAttribute('hidden') === null && doc.querySelector('#ico-moon').getAttribute('hidden') !== null,
     'theme: in dark mode the sun is shown');
  click();
  ok(doc.documentElement.dataset.theme === 'light' && store.get(dom.THEME_KEY) === 'light',
     'theme: a click sets data-theme and persists it');
  ok(btn.getAttribute('aria-label') === 'Switch to dark mode' && doc.querySelector('#ico-moon').getAttribute('hidden') === null && doc.querySelector('#ico-sun').getAttribute('hidden') !== null,
     'theme: the label and icon follow the choice');
  click();
  ok(doc.documentElement.dataset.theme === 'dark' && store.get(dom.THEME_KEY) === 'dark',
     'theme: a second click goes back');
  globalThis.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  let threw = false;
  try { click(); } catch (e) { threw = true; }
  ok(!threw && doc.documentElement.dataset.theme === 'light', 'theme: works with storage blocked');
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  ok(/<script>[^<]*localStorage\.getItem\("odi-theme"\)[^<]*<\/script>/.test(head) &&
     head.indexOf('localStorage') < head.indexOf('style.css'),
     'theme: an inline script in the head sets the attribute before the stylesheet');
  ok(dom.THEME_KEY === 'odi-theme', 'theme: the head script and dom.js use one storage key');
  const css = readFileSync(join(root, 'web', 'style.css'), 'utf8');
  ok(/:root\[data-theme="light"\]\s*\{/.test(css) && /:root:not\(\[data-theme="dark"\]\)/.test(css),
     'theme: style.css lets data-theme override the media query');
  delete doc.documentElement.dataset.theme;
}

/* Receive and transmit are read at the same size, weight and unit styling. */
{
  const css = readFileSync(join(root, 'web', 'style.css'), 'utf8');
  const rules = [...css.matchAll(/([^{}]*\.m-read[^{}]*)\{([^}]*)\}/g)].map((m) => [m[1].trim(), m[2].trim()]);
  const forMeter = (sel) => rules.filter(([s]) => s.split(',').some((x) => x.includes(sel)));
  ok(forMeter('#rx').length === 0 && forMeter('#tx').length === 0,
     'readout: no rule sizes receive or transmit differently');
  ok(rules.filter(([s]) => /\.m-read \.num\b/.test(s)).length === 1 &&
     rules.filter(([s]) => /\.m-read \.unit\b/.test(s)).length === 1,
     'readout: one rule for the number and one for the unit, shared by both meters');
}

/* --- the Phone view: the parser of `omcicli voip` ---------------------- */
{
  const { parseVoip } = await import(join(root, 'web', 'phone.js'));
  const masked = [
    'port 0x201 (voice CTP 0x1)',
    '  sip user 0x1: aor MASKED-5678, display name MASKED-mple',
    '  sip user login 0x3: username MASKED-user, password set (8 bytes), realm example.net',
    '  sip agent 0x1',
    '    proxy sip:proxy.example.net',
    '    registrar registrar.example.net',
    '    port 5060/udp',
    '    expiry 3600 s',
    '  media profile 0x1: codecs PCMU/20ms PCMA/20ms, dtmf out of band',
    '    rtp ports 50000-50100 dscp 46',
    '  voice vlan 100 priority 5 (IP host 0x1)',
    '  line status config done (14)',
  ].join('\n');
  const v = parseVoip(masked);
  const rows = Object.fromEntries(v.ports[0].rows);
  ok(v.ports.length === 1 && v.ports[0].status === 'config done (14)', 'phone: one port, its line status');
  ok(rows['SIP user'] === 'MASKED-5678' && rows.Password === 'set (8 bytes)' && rows.Realm === 'example.net',
     'phone: the masked user and password are shown as printed');
  ok(rows.Proxy === 'sip:proxy.example.net' && rows.Registrar === 'registrar.example.net' && rows['SIP port'] === '5060/udp',
     'phone: proxy, registrar and port');
  ok(rows.Codecs === 'PCMU/20ms PCMA/20ms' && rows['Voice VLAN'] === '100 priority 5 (IP host 0x1)',
     'phone: codecs and the voice VLAN');
  ok(!('Other' in rows), 'phone: every line of the output is understood');
  ok(parseVoip('no voice provisioned\n').none === true, 'phone: no voice provisioned');
  const sec = parseVoip('port 0x201 (voice CTP 0x1)\n  sip user login 0x3: username u, ok, password p, w, realm r.net\n');
  ok(Object.fromEntries(sec.ports[0].rows).Password === 'p, w', 'phone: a password with a comma is kept whole');
}


/*
 * The update notice. The release list comes from the internet, so what is
 * tested is mostly what it may NOT do: the version rules, the daily limit, the
 * notes rendering inert, and storage failing.
 */
{
  const U = await import(join(root, 'web', 'updates.js'));
  const v = U.parseVersion;
  const lt = (a, b) => U.compareVersions(v(a), v(b)) < 0;
  ok(v('v1.12.0') && v('v1.12.0').minor === 12 && v('v1.13.0-beta.1').pre.join('.') === 'beta.1',
     'updates: release tags parse, with and without a prerelease');
  ok(['hostserdes4', '1.12.0', 'v1.12', 'v1.12.0+x', 'v1.2.3-', 'ODI-260910-6861b53', '', undefined, 'v1.12.0 '].every((t) => v(t) === null),
     'updates: anything else is not a release tag');
  ok(lt('v1.13.0-beta.1', 'v1.13.0') && !lt('v1.13.0', 'v1.13.0-beta.1'),
     'updates: 1.13.0-beta.1 is older than 1.13.0');
  ok(lt('v1.12.9', 'v1.13.0-beta.1') && lt('v1.9.0', 'v1.10.0'), 'updates: numbers compare as numbers');
  ok(lt('v1.13.0-alpha', 'v1.13.0-beta') && lt('v1.13.0-beta.2', 'v1.13.0-beta.11') && lt('v1.13.0-beta', 'v1.13.0-beta.1')
     && lt('v1.13.0-1', 'v1.13.0-a') && lt('v1.13.0-rc.1', 'v1.13.0'), 'updates: prerelease identifiers follow semver precedence');
  ok(U.compareVersions(v('v1.2.3'), v('v1.2.3')) === 0, 'updates: equal versions compare equal');

  const rel = (tag, extra) => ({ tag_name: tag, published_at: '2026-10-20T10:00:00Z',
    html_url: 'https://github.com/AndreZiviani/odi-oss/releases/tag/' + tag, body: 'notes ' + tag, ...extra });
  const LIST = [rel('v1.13.0-beta.1', { prerelease: true }), rel('v1.12.1'), rel('v1.12.0'), rel('v1.11.0'),
    rel('v1.14.0', { draft: true }), rel('not-a-version'), rel('v1.13.0-beta.2', { prerelease: true })];
  const tags = (run) => U.newerReleases(LIST, run).map((r) => r.tag);
  ok(tags('v1.12.0').join() === 'v1.12.1', 'updates: a stable stick is offered stable releases only, drafts and odd tags skipped');
  ok(tags('v1.13.0-beta.1').join() === 'v1.13.0-beta.2', 'updates: a pre-release stick is not offered an older stable one');
  ok(tags('v1.12.1-rc.1').join() === 'v1.13.0-beta.2,v1.13.0-beta.1,v1.12.1',
     'updates: a pre-release stick is offered pre-releases too, newest first');
  ok(tags('v1.12.1').join() === '', 'updates: nothing newer, nothing offered');
  ok(tags('hostserdes4').length === 0 && tags(undefined).length === 0, 'updates: a non-release running version offers nothing');
  ok(U.newerReleases(LIST, 'v1.12.0')[0].url === 'https://github.com/AndreZiviani/odi-oss/releases/tag/v1.12.1',
     'updates: each release carries its tag, date and page link');
  const odd = U.cleanRelease(rel('v1.12.5', { html_url: 'javascript:alert(1)' }));
  ok(odd.url === 'https://github.com/AndreZiviani/odi-oss/releases/tag/v1.12.5', 'updates: a page link that is not on github.com is replaced');
  ok(U.cleanRelease(rel('v1.12.5', { html_url: 'https://evil.example/x' })).url.startsWith('https://github.com/'),
     'updates: a page link on another host is replaced');

  /* The daily check, with storage. */
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, x) => { mem.set(k, String(x)); } };
  let calls = 0, mode = 'ok';
  const fake = async (url, opt) => {
    calls++;
    if (url !== U.API_URL || opt.credentials !== 'omit' || opt.referrerPolicy !== 'no-referrer') throw new Error('bad request');
    if (mode === 'throw') throw new Error('offline');
    if (mode === '403') return { ok: false, status: 403, json: async () => ({}) };
    if (mode === 'junk') return { ok: true, status: 200, json: async () => ({ message: 'x' }) };
    return { ok: true, status: 200, json: async () => LIST };
  };
  const fw = (running, off) => ({ running, switches: { 'update-check.off': !!off } });
  const T0 = 1760000000000;
  let got = await U.offered(fw('v1.12.0'), T0, fake);
  ok(calls === 1 && got.length === 1 && got[0].tag === 'v1.12.1', 'updates: the first look fetches once and offers the newer release');
  got = await U.offered(fw('v1.12.0'), T0 + 3600 * 1000, fake);
  ok(calls === 1 && got.length === 1, 'updates: within a day the cache answers, no second fetch');
  got = await U.offered(fw('v1.12.1'), T0 + 7200 * 1000, fake);
  ok(calls === 1 && got.length === 0, 'updates: a new running version is judged from the cache, not refetched');
  mode = '403';
  got = await U.offered(fw('v1.12.0'), T0 + U.DAY_MS + 1000, fake);
  ok(calls === 2 && got.length === 1, 'updates: after a day it asks again; a refusal keeps the old list');
  await U.offered(fw('v1.12.0'), T0 + U.DAY_MS + 2000, fake);
  ok(calls === 2, 'updates: a failed attempt is not retried before the next day');
  mem.clear(); mode = 'throw';
  got = await U.offered(fw('v1.12.0'), T0, fake);
  ok(got.length === 0, 'updates: offline is silent and offers nothing');
  mem.clear(); mode = 'junk';
  got = await U.offered(fw('v1.12.0'), T0, fake);
  ok(got.length === 0, 'updates: an answer that is not a list is silent');
  mem.set(U.CACHE_KEY, '{not json');
  mode = 'ok';
  got = await U.offered(fw('v1.12.0'), T0, fake);
  ok(got.length === 1, 'updates: a damaged cache is ignored');
  const before = calls;
  ok((await U.offered(fw('v1.12.0', true), T0 + 9 * U.DAY_MS, fake)).length === 0 && calls === before,
     'updates: switched off on the stick, nothing is fetched or offered');
  ok((await U.offered(fw('hostserdes4'), T0 + 9 * U.DAY_MS, fake)).length === 0 && calls === before,
     'updates: a local build name is skipped without a fetch');

  /* Storage that throws: no crash, and the answer still comes. */
  globalThis.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  calls = 0;
  got = await U.offered(fw('v1.12.0'), T0, fake);
  ok(got.length === 1 && calls === 1, 'updates: storage that throws still gives the notice');
  delete globalThis.localStorage;
  got = await U.offered(fw('v1.12.0'), T0, fake);
  ok(got.length === 1, 'updates: no storage at all still gives the notice');

  /* What the dialog leaves out. */
  const page = Array.from({ length: 30 }, (_, i) => rel('v1.' + (30 - i) + '.0'));
  mem.clear(); globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, x) => { mem.set(k, String(x)); } };
  const fakePage = async () => ({ ok: true, status: 200, json: async () => page });
  let lk = await U.lookup(fw('v1.5.0'), T0, fakePage);
  ok(lk.offer.length === 25 && !lk.cut && U.olderLine(lk.offer.length, lk.cut) === '15 older releases not shown',
     'updates: more newer releases than the dialog lists says how many are left out');
  lk = await U.lookup(fw('v1.5.0'), T0 + 1000, fakePage);
  ok(lk.offer.length === 25, 'updates: the cached list gives the same count');
  mem.clear();
  lk = await U.lookup(fw('v1.0.0'), T0, fakePage);
  ok(lk.cut && U.olderLine(lk.offer.length, lk.cut) === 'Older releases not shown',
     'updates: a full page whose oldest is newer than the running version may have cut older ones off');
  mem.clear();
  lk = await U.lookup(fw('v1.12.0'), T0, async () => ({ ok: true, json: async () => page.slice(0, 10) }));
  ok(!lk.cut && U.olderLine(5, false) === '' && U.olderLine(11, false) === '1 older release not shown',
     'updates: a short page, or a running version inside it, leaves nothing out');
  lk = await U.lookup(fw('v1.12.0'), T0 + 1000, fakePage);
  ok(!lk.cut, 'updates: a running version inside a full page leaves nothing out');
  {
    const n = U.olderNode(25, false), a = n.children[0];
    ok(U.olderNode(10, false) === null && a.textContent === '15 older releases not shown' && a.attrs.href === 'https://github.com/AndreZiviani/odi-oss/releases'
       && a.attrs.rel === 'noopener noreferrer' && a.attrs.target === '_blank' && U.olderNode(3, true).children[0].textContent === 'Older releases not shown',
       'updates: the last line is a noopener link to the releases list, and absent when nothing is left out');
  }

  /* Dismissal is per version. */
  const offer = U.newerReleases(LIST, 'v1.12.0');
  ok(U.barShown(offer, null) && !U.barShown(offer, 'v1.12.1') && U.barShown(offer, 'v1.11.0') && !U.barShown([], null),
     'updates: the bar hides for the dismissed version and returns for a newer one');

  /* The notes: markdown from the internet, shown as text. */
  const walk = (n, f) => { f(n); for (const c of n.children || []) walk(c, f); };
  const nodesOf = (body) => { const all = []; walk(U.notesNode(body), (n) => all.push(n)); return all; };
  const hostile = [
    '## Changes', '- fixed **bold** and `code`', '- <script>alert(1)</script>', '',
    '<img src=x onerror="alert(2)">', '[click](javascript:alert(3)) [ok](https://example.com/a?b=1) [d](data:text/html,x)',
    '[cred](https://user:pw@example.com/) [h](http://example.com) <a href=//x.example>y</a>', 'see https://github.com/AndreZiviani/odi-oss/pull/12.',
  ].join('\n');
  const all = nodesOf(hostile);
  const tagsUsed = new Set(all.filter((n) => n.tagName).map((n) => n.tagName));
  ok([...tagsUsed].every((t) => ['div', 'p', 'ul', 'li', 'strong', 'code', 'a'].includes(t)),
     'updates: notes build only div, p, ul, li, strong, code and a elements: ' + [...tagsUsed].join(' '));
  const links = all.filter((n) => n.tagName === 'a');
  ok(links.length === 2 && links[0].attrs.href === 'https://example.com/a?b=1' && links.every((a) => /^https:\/\//.test(a.attrs.href) && a.attrs.rel === 'noopener noreferrer' && a.attrs.target === '_blank'),
     'updates: only https links are made, opened with noopener noreferrer in a new tab');
  ok(links[1].attrs.href === 'https://github.com/AndreZiviani/odi-oss/pull/12' && links[1].textContent === 'https://github.com/AndreZiviani/odi-oss/pull/12',
     'updates: a bare URL becomes a link without its closing full stop');
  const shown = textOf(U.notesNode(hostile));
  ok(shown.includes('<script>alert(1)</script>') && shown.includes('<img src=x onerror="alert(2)">')
     && shown.includes('<a href=//x.example>') && shown.includes('click') && shown.includes('data:') === false,
     'updates: markup in the notes is shown as text, not built');
  ok(all.every((n) => !n.attrs || !Object.keys(n.attrs).some((k) => /^on/i.test(k))), 'updates: no element gets an event handler attribute');
  ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(readFileSync(join(root, 'web', 'updates.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')),
     'updates: updates.js never sets HTML from a string');
  const long = U.parseNotes(Array.from({ length: 500 }, (_, i) => '- item ' + i + '\n\npara ' + i).join('\n'));
  const bullets = U.parseNotes(Array.from({ length: 500 }, (_, i) => '- item ' + i).join('\n'));
  ok(long.blocks.length <= 62 && long.more && bullets.blocks[0].items.length <= 60 && bullets.more,
     'updates: a long body, or a very long list, is cut, and says so');
  ok(U.cleanRelease(rel('v1.12.5', { body: 'x'.repeat(100000) })).body.length === 6000, 'updates: the stored notes are capped');
  const h = U.parseNotes('# T\ntext one\ntext two\n* a\n* b\n1. c\n\nlast');
  ok(h.blocks.map((b) => b.t).join() === 'h,p,ul,p' && h.blocks[2].items.length === 3,
     'updates: headings, paragraphs and bullet lists');
}

const githubCalls = [];
{
  const base = globalThis.fetch;
  globalThis.fetch = async (path, ...rest) => {
    if (String(path).includes('api.github.com')) { githubCalls.push(path); throw new Error('no network'); }
    return base(path, ...rest);
  };
}
await import(join(root, 'web', 'app.js'));
await new Promise((r) => setTimeout(r, 50));
ok(true, 'app.js bootstraps without throwing');
ok(githubCalls.length === 0, 'updates: a stick running a non-release image never contacts GitHub');

console.log(failed ? `\n${failed} failed` : '\nweb modules ok');
process.exit(failed ? 1 : 0);
