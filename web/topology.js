/*
 * The path the OLT provisioned, drawn: T-CONT, GEM port, interworking TP,
 * 802.1p mapper, bridge port, bridge, bridge port, UNI.
 *
 * The Services tab answers six questions and the MIB browser shows one class
 * at a time. Neither says how the entities hang together, and that is the
 * question behind most "O5 but no traffic" threads: does a GEM port the OLT
 * created actually reach a UNI? Answering it by hand means following a dozen
 * pointers across six tables. This page follows them.
 *
 * It reads the same `omcicli mib get <class>` the MIB browser runs, once per
 * class, on demand only: no polling, nothing written. Every edge is a pointer
 * attribute the OLT set. Where G.988 leaves the target class to another
 * attribute (the TP type of a bridge port), this page resolves it the way odi-oss
 * omcid does (src/omci/respond/apply_bridge.c), so the picture shows what
 * the stick builds from, not a second opinion. The rule this page shares with
 * services.js: never invent a meaning. A pointer it cannot place is drawn as
 * one, not guessed.
 */

import { $, el } from './dom.js';
import { fetchMe, attr, unavailable } from './omci.js';

/* The classes read, in order. 84 and 171 only annotate boxes. */
const CLASSES = ['262', '268', '266', '281', '130', '47', '45', '11', '329', '134', '84', '171'];

/* G.988 says which side creates each class; the ONU makes these at MIB reset. */
const ONU_MADE = new Set(['262', '11', '329', '134']);

const COLUMNS = ['T-CONT', 'GEM port', 'Interworking', '802.1p mapper',
  'Bridge port', 'Bridge', 'Bridge port', 'UNI'];

/* The TP type of a bridge port (G.988 9.3.4, attribute 3): which class its TP
   pointer names, and which side of the bridge that puts it on. Type 3 is
   resolved separately, below. */
const TP_TYPE = {
  1: { cls: '11', side: 'uni', text: 'Ethernet UNI' },
  4: { cls: '134', side: 'uni', text: 'IP host' },
  5: { cls: '266', side: 'ani', text: 'GEM IW TP' },
  6: { cls: '281', side: 'ani', text: 'multicast IW TP' },
  11: { cls: '329', side: 'uni', text: 'VEIP' },
};

/* Extended VLAN tagging (171) association type -> the class it names. */
const ASSOC = { 0: '47', 1: '130', 2: '11', 3: '134', 5: '266', 6: '281', 10: '329' };

const IW_OPT = { 0: 'circuit emulation', 1: 'MAC bridged', 5: '802.1p mapper', 6: 'downstream broadcast' };
const DIR = { 1: 'upstream', 2: 'downstream', 3: 'both ways' };

/* 0x0001, 0x601, 1, 01 (odi-oss hex) -> 1; anything else -> NaN. */
function num(v) {
  const s = String(v ?? '').trim();
  if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
  if (/^\d+$/.test(s)) return Number(s);
  return NaN;
}

const hex = (n) => '0x' + n.toString(16).padStart(4, '0');

/* The entity id of one parsed instance. The vendor dump prints it as an
   attribute, the odi-oss dump in its header; omci.js puts both in inst.id. */
function idOf(inst) {
  const n = num(inst.id || attr(inst, 'EntityID'));
  return Number.isNaN(n) ? null : n;
}

/*
 * A pointer that names nothing. G.988 uses 0xffff; OLTs also leave 0 in
 * pointers they do not use (the ISP1 IW TPs carry IwTpPtr 0). 0 counts as a
 * pointer only when an entity 0 of the target class exists.
 */
const isNull = (n, exists) => Number.isNaN(n) || n === 0xffff || (n === 0 && !exists);

/*
 * The graph, from the parsed dumps: { cls: dump } as fetchOmci returns them.
 * Pure, so scripts/web-check.mjs drives it with fixtures.
 *
 * Returns { nodes, edges, dangling, notes }:
 *   nodes     Map cls/id -> { key, cls, id, col, title, lines[], onu, used }
 *   edges     [{ from, to, label }], drawn left to right (fibre to UNI)
 *   dangling  [{ from, what, target }] pointers to an entity that is not there
 *   notes     sentences about how an ambiguous pointer was read
 */
function buildGraph(dumps) {
  const nodes = new Map();
  const edges = [];
  const dangling = [];
  const notes = [];
  const rows = {};

  for (const cls of CLASSES) {
    rows[cls] = new Map();
    for (const inst of (dumps[cls] && dumps[cls].instances) || []) {
      const id = idOf(inst);
      if (id !== null) rows[cls].set(id, inst);
    }
  }
  const has = (cls, id) => rows[cls].has(id);
  const key = (cls, id) => cls + '/' + id;
  const val = (inst, name) => num(attr(inst, name));

  const add = (cls, id, col, title, lines) => {
    const k = key(cls, id);
    if (!nodes.has(k))
      nodes.set(k, { key: k, cls, id, col, title, lines: lines || [], onu: ONU_MADE.has(cls), used: false });
    return nodes.get(k);
  };
  const link = (fromCls, fromId, toCls, toId, label) =>
    edges.push({ from: key(fromCls, fromId), to: key(toCls, toId), label: label || '' });
  /* Follow one pointer: an edge when the target exists, a dangling record
     when it names an entity that does not, nothing when it is null. */
  const follow = (owner, what, ptr, cls, edge) => {
    if (isNull(ptr, has(cls, 0))) return false;
    if (has(cls, ptr)) { edge(); return true; }
    dangling.push({ from: owner, what, target: 'ME ' + cls + ' ' + hex(ptr) });
    return false;
  };

  for (const [id, inst] of rows['262']) {
    const alloc = val(inst, 'AllocID');
    /* 0x00ff and 0xffff mean "not assigned" in G.988. A T-CONT in use can
       still show it: the Alloc-ID also comes by PLOAM, and omcli tcont
       says which one the stick runs on. */
    const unset = alloc === 0xff || alloc === 0xffff;
    add('262', id, 0, 'T-CONT ' + hex(id),
      [unset ? 'Alloc-ID not set (' + hex(alloc) + ')' : 'Alloc-ID ' + alloc]).spare = unset;
  }
  for (const [id, inst] of rows['268']) {
    const port = val(inst, 'PortID');
    const dir = val(inst, 'Direction');
    const n = add('268', id, 1, 'GEM ' + (Number.isNaN(port) ? '?' : port),
      [hex(id) + ', ' + (DIR[dir] || 'direction ' + dir)]);
    follow(n.key, 'T-CONT pointer', val(inst, 'TcAdapterPtr'), '262', () => link('262', val(inst, 'TcAdapterPtr'), '268', id));
  }
  for (const cls of ['266', '281']) {
    for (const [id, inst] of rows[cls]) {
      const opt = val(inst, 'IwOpt');
      const n = add(cls, id, 2, (cls === '281' ? 'Multicast IW ' : 'IW TP ') + hex(id),
        [cls === '281' ? 'multicast' : (IW_OPT[opt] || 'option ' + opt)]);
      follow(n.key, 'GEM port pointer', val(inst, 'GemCtpPtr'), '268', () => link('268', val(inst, 'GemCtpPtr'), cls, id));
    }
  }
  for (const [id, inst] of rows['130']) {
    const n = add('130', id, 3, 'Mapper ' + hex(id), []);
    const by = new Map();      /* IW TP id -> the p-bits that reach it */
    for (let p = 0; p < 8; p++) {
      const ptr = val(inst, 'IwTpPtrPbit' + p);
      /* 0 is unset here whatever exists: omcid skips a p-bit pointer of 0
         or 0xffff (apply_bridge.c). */
      if (Number.isNaN(ptr) || ptr === 0 || ptr === 0xffff) continue;
      if (!has('266', ptr)) { dangling.push({ from: n.key, what: 'p-bit ' + p, target: 'ME 266 ' + hex(ptr) }); continue; }
      if (!by.has(ptr)) by.set(ptr, []);
      by.get(ptr).push(p);
    }
    for (const [iw, bits] of by) {
      const label = 'p-bit' + (bits.length > 1 ? 's ' : ' ') + ranges(bits);
      n.lines.push(label + ' → IW ' + hex(iw));
      link('266', iw, '130', id, label);
    }
    if (!by.size) n.lines.push('no p-bit points anywhere');
  }
  for (const [id, inst] of rows['45'])
    add('45', id, 5, 'Bridge ' + hex(id), []);
  for (const cls of ['11', '329', '134']) {
    const name = { 11: 'Ethernet UNI', 329: 'VEIP', 134: 'IP host' }[cls];
    for (const [id] of rows[cls]) add(cls, id, 7, name + ' ' + hex(id), []);
  }

  const quirk = [];
  for (const [id, inst] of rows['47']) {
    const type = val(inst, 'TPType');
    const ptr = val(inst, 'TPPointer');
    let target = TP_TYPE[type] ? TP_TYPE[type].cls : null;
    let to = ptr;
    let side = TP_TYPE[type] ? TP_TYPE[type].side : 'ani';
    let kind = TP_TYPE[type] ? TP_TYPE[type].text : 'TP type ' + type;

    /* TP type 3 is "802.1p mapper" in G.988, and some OLTs point it at the
       GEM IW TP instead (ISP1). omcid takes the IW TP when one of that id
       exists, unless a mapper of the same id names a different IW TP, which
       makes it the mapper (ISP3). Same rule here. */
    if (type === 3) {
      const mapper = rows['130'].get(ptr);
      let iw = has('266', ptr);
      if (iw && mapper) {
        for (let p = 0; p < 8; p++) {
          const t = val(mapper, 'IwTpPtrPbit' + p);
          if (t !== 0 && t !== 0xffff && t !== ptr) iw = false;
        }
      }
      target = iw ? '266' : '130';
      kind = '802.1p mapper';
      if (iw) {
        /* omcid then takes the p-bits from the mapper the IW TP names as
           its service profile, so that mapper is on the path: drawn as
           IW TP -> mapper -> bridge port. When that mapper has the id of
           the pointer (ISP1), reading the pointer as G.988 says, as the
           mapper, draws the same thing: the MIB cannot tell which the OLT
           meant, so nothing is said. Only a pointer the two readings
           place apart gets the note. */
        const sp = val(rows['266'].get(ptr), 'ServProPtr');
        const via = has('130', sp) ? ', through mapper ' + hex(sp) : '';
        if (via) { target = '130'; to = sp; }
        if (!(via && sp === ptr)) {
          kind = 'TP type 3, names IW TP ' + hex(ptr);
          quirk.push(hex(id) + ' \u2192 IW TP ' + hex(ptr) + via);
        }
      }
    }
    const n = add('47', id, side === 'uni' ? 6 : 4, 'Bridge port ' + hex(id), [kind]);
    n.side = side;
    /* omcid builds no service on an IW TP of interworking option 6, the
       downstream broadcast GEM: apply_qos.c programs it as the broadcast
       flow. Still drawn, since frames do take it, but said. */
    if (type === 5 && has('266', ptr) && val(rows['266'].get(ptr), 'IwOpt') === 6)
      n.lines.push('broadcast GEM: a flow, not a service');
    if (target) {
      if (side === 'uni') follow(n.key, 'TP pointer', to, target, () => link('47', id, target, to));
      else follow(n.key, 'TP pointer', to, target, () => link(target, to, '47', id));
    } else {
      n.lines.push('TP type ' + type + ' is not drawn');
    }
    const br = val(inst, 'BridgeIdPtr');
    if (side === 'uni') follow(n.key, 'bridge pointer', br, '45', () => link('45', br, '47', id));
    else follow(n.key, 'bridge pointer', br, '45', () => link('47', id, '45', br));
  }

  if (quirk.length)
    notes.push((quirk.length === 1 ? 'A bridge port has TP type 3 (802.1p mapper) but points'
      : quirk.length + ' bridge ports have TP type 3 (802.1p mapper) but point') + ' at a GEM IW TP: ' + quirk.join('; ')
      + '. omcid reads each as that IW TP, with the p-bits of the mapper the IW TP names, '
      + 'and the picture follows omcid.');

  /* Annotations: the VIDs a bridge port filters on, and how many extended
     VLAN rules sit on an entity. Neither is decoded beyond that; the
     Services tab says what the rules do. */
  for (const [id, inst] of rows['84']) {
    const n = nodes.get(key('47', id));
    const vids = inst.attrs.filter(([k]) => /^FilterTbl\[/i.test(k))
      .map(([, v]) => (/VID\s+(\d+)/.exec(v) || [])[1]).filter(Boolean);
    if (n && vids.length) n.lines.push('VLAN ' + vids.join(', '));
  }
  for (const [, inst] of rows['171']) {
    /* The stock dump prints AssociatedMePoint after the rule table, so the
       parser files it under the last INDEX row. */
    const deep = (name) => attr(inst, name) ?? inst.groups.map((g) => attr(g, name)).find((v) => v != null);
    const cls = ASSOC[num(deep('AssociationType'))];
    const n = cls && nodes.get(key(cls, num(deep('AssociatedMePoint'))));
    const count = inst.groups.filter((g) => /^INDEX\b/i.test(g.label)).length;
    if (n) n.lines.push('VLAN rules: ' + count);
  }

  markUsed(nodes, edges);
  return { nodes, edges, dangling, notes };
}

/* [0,1,2,3,5] -> 0-3, 5 */
function ranges(bits) {
  const out = [];
  for (let i = 0; i < bits.length; i++) {
    let j = i;
    while (j + 1 < bits.length && bits[j + 1] === bits[j] + 1) j++;
    out.push(j > i ? bits[i] + '–' + bits[j] : String(bits[i]));
    i = j;
  }
  return out.join(', ');
}

/*
 * In use: on a complete path from a GEM port to a UNI. Anything else the OLT
 * created is stored and carries nothing, which is worth seeing (a GEM port
 * with no bridge behind it is the classic half-provisioned line). A T-CONT
 * counts when a GEM port in use names it.
 */
function markUsed(nodes, edges) {
  const fwd = new Map();
  const back = new Map();
  for (const e of edges) {
    (fwd.get(e.from) || fwd.set(e.from, []).get(e.from)).push(e.to);
    (back.get(e.to) || back.set(e.to, []).get(e.to)).push(e.from);
  }
  const walk = (starts, next) => {
    const seen = new Set(starts);
    const todo = [...starts];
    while (todo.length) for (const k of next.get(todo.pop()) || []) if (!seen.has(k)) { seen.add(k); todo.push(k); }
    return seen;
  };
  const all = [...nodes.values()];
  const fromGem = walk(all.filter((n) => n.cls === '268').map((n) => n.key), fwd);
  const toUni = walk(all.filter((n) => n.col === 7).map((n) => n.key), back);
  for (const n of all) n.used = fromGem.has(n.key) && toUni.has(n.key);
  for (const e of edges) {
    const a = nodes.get(e.from);
    if (a && a.cls === '262' && nodes.get(e.to) && nodes.get(e.to).used) a.used = true;
  }
}

/* Every node a click on `k` concerns: what feeds it and what it feeds. */
function pathOf(k, edges) {
  const out = new Set([k]);
  for (const dir of ['from', 'to']) {
    const other = dir === 'from' ? 'to' : 'from';
    const todo = [k];
    const seen = new Set([k]);
    while (todo.length) {
      const cur = todo.pop();
      for (const e of edges) if (e[other] === cur && !seen.has(e[dir])) { seen.add(e[dir]); todo.push(e[dir]); out.add(e[dir]); }
    }
  }
  return out;
}

/* --- rendering ------------------------------------------------------------ */

let RUN = 0;
let loaded = false;
let GRAPH = null;

function box(n) {
  const b = el('button', 'topo-box' + (n.onu ? ' onu' : ' olt') + (n.used ? '' : ' unused'));
  b.type = 'button';
  b.dataset.key = n.key;
  b.setAttribute('aria-pressed', 'false');
  b.append(el('span', 'topo-title', n.title));
  for (const l of n.lines) b.append(el('span', 'topo-line', l));
  /* What the ONU made for itself (a UNI, an IP host) sits unbridged on many
     lines; only a T-CONT says something by being unused. */
  if (!n.used && n.cls === '262') b.append(el('span', 'topo-line topo-flag', 'no GEM port in use'));
  else if (!n.used && !n.onu) b.append(el('span', 'topo-line topo-flag', 'stored, not in a path'));
  b.onclick = () => select(n.key);
  return b;
}

function select(k) {
  const host = $('#topo-graph');
  if (!host || !GRAPH) return;
  host.dataset.sel = host.dataset.sel === k ? '' : k;
  paint(host);
}

/* Apply the selection to the boxes and the connectors. drawEdges() calls it
   too: a resize redraws the connectors, and they must come back faded. */
function paint(host) {
  const on = host.dataset.sel || null;
  const keep = on ? pathOf(on, GRAPH.edges) : null;
  for (const b of host.querySelectorAll('.topo-box')) {
    const hit = keep && keep.has(b.dataset.key);
    b.classList.toggle('faded', !!keep && !hit);
    b.setAttribute('aria-pressed', on === b.dataset.key ? 'true' : 'false');
  }
  for (const p of host.querySelectorAll('.topo-edge'))
    p.classList.toggle('faded', !!keep && !(keep.has(p.dataset.from) && keep.has(p.dataset.to)));
}

/*
 * The connectors: one SVG over the columns, a curve from the right edge of
 * one box to the left edge of the next, recomputed whenever the layout
 * moves. The boxes stand on their own without it (each says what it points
 * at), so a browser that cannot measure still shows the whole graph.
 */
function drawEdges(host, g) {
  const svg = host.querySelector('svg.topo-lines');
  if (!svg || typeof host.getBoundingClientRect !== 'function') return;
  const base = host.getBoundingClientRect();
  const at = new Map();
  for (const b of host.querySelectorAll('.topo-box')) at.set(b.dataset.key, b.getBoundingClientRect());
  svg.setAttribute('width', String(host.scrollWidth));
  svg.setAttribute('height', String(host.scrollHeight));
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  for (const e of g.edges) {
    const a = at.get(e.from);
    const b = at.get(e.to);
    if (!a || !b) continue;
    const x1 = a.right - base.left + host.scrollLeft;
    const y1 = a.top + a.height / 2 - base.top + host.scrollTop;
    const x2 = b.left - base.left + host.scrollLeft;
    const y2 = b.top + b.height / 2 - base.top + host.scrollTop;
    const mid = (x1 + x2) / 2;
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`);
    const used = g.nodes.get(e.from).used && g.nodes.get(e.to).used;
    p.setAttribute('class', 'topo-edge' + (used ? '' : ' unused'));
    p.dataset.from = e.from;
    p.dataset.to = e.to;
    svg.appendChild(p);
  }
  if (host.dataset.sel) paint(host);
}

/*
 * Order inside a column: walk from each bridge outwards, so a GEM port lands
 * near the mapper that names it and most connectors run level. What no walk
 * reaches keeps its id order at the bottom.
 */
function orderColumns(g) {
  const cols = COLUMNS.map(() => []);
  const placed = new Set();
  const put = (k) => {
    if (placed.has(k)) return;
    const n = g.nodes.get(k);
    if (!n) return;
    placed.add(k);
    cols[n.col].push(n);
  };
  const inbound = (k) => g.edges.filter((e) => e.to === k).map((e) => e.from);
  const outbound = (k) => g.edges.filter((e) => e.from === k).map((e) => e.to);
  const left = (k) => { for (const f of inbound(k)) { put(f); left(f); } };

  const sorted = [...g.nodes.values()].sort((a, b) => (b.used - a.used) || a.cls.localeCompare(b.cls) || a.id - b.id);
  for (const br of sorted.filter((n) => n.cls === '45')) {
    put(br.key);
    for (const p of inbound(br.key)) { put(p); left(p); }
    for (const p of outbound(br.key)) { put(p); for (const u of outbound(p)) put(u); }
  }
  for (const n of sorted) { put(n.key); left(n.key); }
  /* Spare T-CONTs (no Alloc-ID, nothing on them) fold into one line. */
  const spare = cols[0].filter((n) => n.spare && !n.used && !g.edges.some((e) => e.from === n.key));
  if (spare.length > 1) cols[0] = cols[0].filter((n) => !spare.includes(n)).concat([{ fold: spare.length }]);
  return cols;
}

function renderGraph(host, g) {
  const grid = el('div', 'topo-grid');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'topo-lines');
  svg.setAttribute('aria-hidden', 'true');
  const cols = orderColumns(g);
  COLUMNS.forEach((name, i) => {
    const col = el('div', 'topo-col');
    col.append(el('h4', '', name));
    for (const n of cols[i]) {
      if (n.fold) {
        col.append(el('div', 'topo-box spare', n.fold + ' T-CONTs without an Alloc-ID'));
        continue;
      }
      col.append(box(n));
    }
    grid.append(col);
  });
  host.append(svg, grid);
}

async function renderTopology(force) {
  const host = $('#topo-graph');
  const msg = $('#topo-msg');
  if (!host) return;
  if (loaded && !force) return;
  loaded = true;
  const run = ++RUN;
  const facts = $('#topo-facts');
  host.textContent = '';
  host.dataset.sel = '';
  if (facts) facts.textContent = '';
  msg.textContent = 'Reading ' + CLASSES.length + ' tables…';

  const dumps = {};
  const failed = [];
  const partial = [];
  for (let i = 0; i < CLASSES.length; i++) {
    const cls = CLASSES[i];
    const d = await fetchMe(cls);
    if (run !== RUN) return;
    const why = unavailable(d);
    /* An empty table is a finding (no mapper on this line); a table that
       could not be read is not, and is named so the picture is not taken
       for the whole truth. The T-CONTs are the exception: the ONU always
       makes them, so none means the read came back incomplete, as on the
       Services tab. */
    if (why && !/does not know this table/.test(why)) failed.push('ME ' + cls);
    else if (!why && cls === '262' && !d.instances.length) failed.push('ME ' + cls);
    else if (!why && d.truncated) partial.push('ME ' + cls);
    dumps[cls] = why ? { instances: [] } : d;
    /* Each read waits up to 2 s, and confd answers nothing else meanwhile:
       after one timeout the daemon is stuck, and the rest would only add to
       the wait. */
    if (why && /timed out/.test(why)) {
      for (const rest of CLASSES.slice(i + 1)) { failed.push('ME ' + rest); dumps[rest] = { instances: [] }; }
      break;
    }
  }

  GRAPH = buildGraph(dumps);
  msg.textContent = '';
  if (!GRAPH.nodes.size) {
    msg.textContent = failed.length
      ? 'The MIB could not be read (' + failed.join(', ') + '). Check the MIB browser for the reason.'
      : 'The MIB holds nothing to draw: the OLT has not provisioned this ONU yet.';
    return;
  }
  renderGraph(host, GRAPH);
  drawEdges(host, GRAPH);

  if (!facts) return;
  if (failed.length)
    facts.append(el('p', 'me-note bad', 'Not read: ' + failed.join(', ')
      + '. Boxes from those tables are missing, so a path may look broken when it is not.'));
  if (partial.length)
    facts.append(el('p', 'me-note bad', 'Read only in part, the dump was longer than the daemon will hold: '
      + partial.join(', ') + '. Entities past the cut are missing, so a pointer to one shows as naming '
      + 'nothing and a path may look broken when it is not.'));
  for (const d of GRAPH.dangling)
    facts.append(el('p', 'me-note bad', GRAPH.nodes.get(d.from).title + ': its ' + d.what
      + ' names ' + d.target + ', which does not exist.'));
  for (const t of GRAPH.notes) facts.append(el('p', 'me-note', t));
}

/* Re-measure when the panel changes size: the columns wrap on a phone. */
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function')
  window.addEventListener('resize', () => {
    const host = $('#topo-graph');
    if (host && GRAPH && !host.hidden) drawEdges(host, GRAPH);
  });

export { renderTopology, buildGraph, pathOf };
