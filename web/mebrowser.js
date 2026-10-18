/*
 * The MIB, unedited, as three linked lists: every table this stack can
 * register, the entities the selected one holds, and the attributes of the
 * selected entity.
 *
 * Everything the OLT built, in whatever shape the firmware prints it. The
 * Services tab answers six questions; this one answers the rest, and it is the
 * page to reach for when a thread asks you to post `omcicli mib get 84` --
 * because that is exactly what it runs, once per table opened, and nothing
 * else. Entities and attributes come out of that one dump; there is no second
 * query per entity, so clicking through a table costs the MIB service nothing.
 *
 * Two views of the same dump, deliberately: a table when the parser could make
 * sense of it, and the lines underneath when you want to be sure the table is
 * not lying to you. Nothing here decides what an attribute means.
 */

import { $, el } from './dom.js';
import { fetchOmci, fetchMe, unavailable } from './omci.js';
import { meProblem, entityProblem } from './validate.js';

/*
 * Every managed entity class this stack knows, as [class id, table name,
 * official name]: the model odi-oss recovers from the stock firmware's OMCI
 * plugins, which is also what omcid answers to. Regenerate it with
 * scripts/gen-mib-classes.py; do not edit the rows.
 *
 * Captured rather than queried, because `omcicli get tables` returns zero
 * bytes and wedges the stock omci_app responder until it is restarted. omcid
 * answers it safely, but this page also runs against the stock daemon, so the
 * list stays static.
 *
 * The official name leads each row. The table name is the one omcicli prints
 * (the vendor's), kept as the secondary label and still searchable. LargeString
 * is two classes (157 and 307) and so two rows.
 */
/* BEGIN GENERATED: scripts/gen-mib-classes.py */
/* From odi-oss src/omci/generated/omci_mib.json at 1d36d8b. [class id, table name, official name] */
const CLASSES = [
  [2, 'OntData', 'ONU data'],
  [5, 'Cardholder', 'Cardholder'],
  [6, 'CircuitPack', 'Circuit Pack'],
  [7, 'SWImage', 'Software Image'],
  [11, 'EthUni', 'PPTP Ethernet UNI'],
  [24, 'EthPmHistoryData', 'Ethernet performance monitoring history data'],
  [45, 'MacBriServProf', 'MAC Bridge Service Profile'],
  [46, 'MacBriCfgData', 'MAC bridge configuration data'],
  [47, 'MacBriPortCfgData', 'MAC Bridge Port Configuration Data'],
  [49, 'MacBridgePortFilterTable', 'MAC bridge port filter table data'],
  [50, 'MacBriPortBriTblData', 'MAC Bridge Port Bridge Table Data'],
  [52, 'MacBridgePortPmMonitorHistoryData', 'MAC bridge port performance monitoring history data'],
  [78, 'VlanTagOpCfgData', 'VLAN Tag Operate Configuration Data'],
  [79, 'MacBridgePortFilterPreassign', 'MAC bridge port filter pre-assign table'],
  [83, 'LctUni', 'PPTP LCT UNI'],
  [84, 'VlanTagFilterData', 'VLAN Tag Filter Data'],
  [89, 'EthPmData2', 'Ethernet PM History Data 2'],
  [130, 'Map8021pServProf', '802.1p Mapper Service Profile'],
  [131, 'OltG', 'OLT-G'],
  [133, 'OnuPwrShedding', 'ONU power shedding'],
  [134, 'IpHostCfgData', 'IP host config data'],
  [136, 'TcpUdpCfgData', 'TCP/UDP config data'],
  [137, 'NetworkAddress', 'Network address'],
  [148, 'AuthSecMethod', 'Authentication security method'],
  [157, 'LargeString', 'Large string'],
  [158, 'OnuRemoteDebug', 'ONU remote debug'],
  [171, 'ExtVlanTagOperCfgData', 'Extended VLAN tagging operation configure data'],
  [240, 'OntSystemMgmt', 'ONT system management'],
  [242, 'Me242', 'ME242'],
  [243, 'PrivateQueueMap', 'Private queue map'],
  [244, 'OntSelfLoopDetect', 'Ont Self Loop Detect'],
  [245, 'HSQDefault', 'Default to factory'],
  [248, 'WANConfigCata', 'config wan interface'],
  [249, 'WANConfigCataDeti', 'config wan interface Deti'],
  [250, 'ExtIpHostCfgData', 'Pppoe interface'],
  [253, 'LoopDetect', 'Loop Detect'],
  [255, 'PrivateTellionOntStatistics', 'Private ONU statistics'],
  [256, 'Ontg', 'ONU-G'],
  [257, 'Ont2g', 'ONU2-G'],
  [262, 'Tcont', 'T-CONT'],
  [263, 'Anig', 'ANI-G'],
  [264, 'Unig', 'UNI-G'],
  [266, 'GemIwTp', 'GEM Interworking TP'],
  [267, 'GemPortPmhd', 'GEM port performance monitoring history data'],
  [268, 'GemPortCtp', 'GEM port network CTP'],
  [272, 'GalEthProf', 'GAL Ethernet profile'],
  [273, 'ThresholdData1', 'Threshold data 1'],
  [274, 'ThresholdData2', 'Threshold data 2'],
  [277, 'PriQ', 'Priority Queue-G'],
  [278, 'Scheduler', 'Traffic Scheduler-G'],
  [280, 'TrafficDescriptor', 'Traffic Descriptor'],
  [281, 'MultiGemIwTp', 'Multicast GEM Interworking TP'],
  [284, 'PseudowireMaintenanceProfile', 'Pseudowire maintenance profile'],
  [287, 'Omci', 'OMCI'],
  [296, 'EthPmData3', 'Ethernet PM History Data 3'],
  [298, 'Dot1RateLimiter', 'Dot1 rate limiter'],
  [307, 'LargeString', 'Large string'],
  [308, 'GeneralPurposeBuffer', 'General purpose buffer'],
  [309, 'McastOperProf', 'Multicast Operation Profile'],
  [310, 'McastSubConfInfo', 'Multicast subscriber configure inforation'],
  [311, 'McastSubMonitor', 'Multicast subscriber monitor'],
  [312, 'FecPmhd', 'FEC performance monitoring history data'],
  [321, 'EthPmDataDs', 'Ethernet frame performance monitoring history data downstream'],
  [322, 'EthPmDataUs', 'Ethernet frame performance monitoring history data upstream'],
  [329, 'VEIP', 'Virtual Ethernet interface point'],
  [330, 'GenericStatusPortal', 'Generic status portal'],
  [334, 'EthExtPmData', 'Ethernet frame extended PM'],
  [340, 'TR069ManageServer', 'TR-069 management server'],
  [341, 'GpncPmhd', 'GEM port network CTP performance monitoring history data'],
  [350, 'Me350', 'Private ME 350'],
  [370, 'Me370', 'Private ME 370'],
  [373, 'Me373', 'Private ME 373'],
  [65282, 'PrivateMcastTag', 'Private multicast tag'],
  [65294, 'PrivateSntp', 'Private SNTP'],
  [65408, 'ExtendedOnuG', 'Extended ONU-G'],
  [65527, 'OLTLocationConfigData', 'OLT Location Config Data'],
  [65528, 'CTCOnuOnuLoopDetection', 'CTC Loop Detection'],
  [65529, 'OnuCapability', 'ONU capability'],
  [65530, 'LoIdAuth', 'LOID authentication'],
  [65531, 'ExtendedMcastOperProf', 'Extended Multicast Operation Profiles'],
  [65534, 'PrivateTqCfg', 'Private Tcont Queue Configuration'],
  [65535, 'PrivateVlanCfg', 'Private Vlan Configuration'],
];
/* END GENERATED */

/*
 * One row per class, and every class is asked for by its id: omcicli takes a
 * class id as well as a table name, and the id is unique where the name is not
 * (LargeString), so it is the only thing that picks the right registration.
 */
const CATALOG = CLASSES.map(([classId, name, title]) => ({
  name,
  title,
  classId,
  query: String(classId),
  entity: '',
}));

const DUMPS = [
  ['conn', 'Data path connections'],
  ['srvflow', 'Data path service flows'],
  ['qmap', 'T-CONT queue mapping'],
  ['tasks', 'OMCI tasks'],
];

const DEFAULT_TABLE = 84;   /* VLAN tag filter data */

/*
 * What the browser holds. Dumps are kept per query for the page's life, so a
 * table read once (or counted) opens again without asking the device; Read
 * again is the only thing that replaces one.
 */
const browser = {
  dumps: new Map(),
  reading: new Set(),
  table: null,
  entityIndex: -1,
  attributeView: 'parsed',
  counting: false,
  stopCounting: false,
};

let wired = false;

const dumpKey = (table) => table.query + (table.entity ? ' ' + table.entity : '');

/* An entity id as a number, from whichever spelling the dump used (0x01,
   0x0001, 1). NaN for an instance printed without one. */
function entityNumber(instance) {
  const id = String(instance.id || '').trim();
  if (/^0x[0-9a-f]+$/i.test(id)) return parseInt(id, 16);
  if (/^\d+$/.test(id)) return Number(id);
  return NaN;
}
const entityHex = (instance) => {
  const number = entityNumber(instance);
  return Number.isNaN(number) ? (instance.id || '(unnamed)') : '0x' + number.toString(16).padStart(4, '0');
};
const entityAttributes = (instance) => instance.attrs.filter(([key]) => !/^entity\s*id$/i.test(key));
const attributeCount = (instance) => entityAttributes(instance).length + instance.groups.length;

/* The Ent column: a count only for a dump that is a real answer. A daemon that
   said nothing, or listed its tables instead, has not said "0". */
function entityCountCell(table) {
  const key = dumpKey(table);
  if (browser.reading.has(key)) return { text: '…', cls: 'mib-dim', title: 'Reading' };
  const dump = browser.dumps.get(key);
  if (!dump) return { text: '–', cls: 'mib-dim', title: 'Not read yet' };
  const problem = unavailable(dump);
  if (problem) return { text: '?', cls: 'bad', title: problem };
  return { text: String(dump.instances.length), cls: dump.instances.length ? '' : 'mib-dim', title: '' };
}

function rowButton(rowKey, cells, selected, onSelect) {
  const button = el('button', 'mib-row');
  button.type = 'button';
  button.dataset.row = rowKey;
  if (selected) button.setAttribute('aria-current', 'true');
  for (const cell of cells) {
    const span = el('span', cell.cls || '', cell.text);
    if (cell.title) span.title = cell.title;
    /* A second, smaller line: the vendor's table name under the official one. */
    if (cell.sub) span.append(el('small', 'mib-sub', cell.sub));
    button.append(span);
  }
  button.onclick = onSelect;
  return button;
}

/* A list is rebuilt on every change, which would drop its scroll position and
   the keyboard focus on it: both are put back on the row with the same key. */
function rebuildList(list, fill, keepScroll = true) {
  const scrolled = keepScroll ? list.scrollTop : 0;
  const active = document.activeElement;
  const focusedRow = active && list.contains && list.contains(active) ? active.dataset.row : null;
  list.textContent = '';
  fill();
  list.scrollTop = scrolled;
  if (focusedRow === null) return;
  const again = [...list.children].find((node) => node.dataset && node.dataset.row === focusedRow);
  if (again) again.focus({ preventScroll: true });
}

/* Up and down move between the rows of one list. A table row only takes the
   focus (opening one is a query); an entity row is selected as well, since
   that is read from the dump already in hand. */
function arrowKeys(list, selectOnMove) {
  list.onkeydown = (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [...list.children].filter((node) => String(node.tagName).toLowerCase() === 'button');
    const at = rows.indexOf(document.activeElement);
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (!next) return;
    event.preventDefault();
    next.focus();
    if (selectOnMove) next.click();
  };
}

/* ------------------------------------------------------------- the panes */

function tableMatches(table, filter) {
  if (!filter) return true;
  if (/^\d+$/.test(filter)) return String(table.classId).startsWith(filter);
  const wanted = filter.toLowerCase();
  return table.title.toLowerCase().includes(wanted) || table.name.toLowerCase().includes(wanted);
}

function renderTables() {
  const list = $('#me-tables-list');
  const filter = String($('#me-filter').value || '').trim();
  const shown = CATALOG.filter((table) => tableMatches(table, filter));

  $('#me-n-tables').textContent = filter ? `${shown.length} of ${CATALOG.length}` : String(CATALOG.length);
  rebuildList(list, () => {
    if (!shown.length) {
      list.append(el('p', 'hint mib-empty', 'No table matches that. Look up reads a class id or name that is not listed.'));
      return;
    }
    for (const table of shown) {
      list.append(rowButton(
        String(table.classId),
        [{ text: String(table.classId), cls: '' },
          { text: table.title, sub: table.name, cls: 'mib-name', title: `${table.title} (${table.name})` }, entityCountCell(table)],
        browser.table === table,
        () => openTable(table),
      ));
    }
  });
}

/* Bring the selected table into its list's view, without scrolling the page:
   for a selection the user did not click on (the default, a look-up). */
function revealSelectedTable() {
  const list = $('#me-tables-list');
  const row = [...list.children].find((node) => node.getAttribute && node.getAttribute('aria-current') === 'true');
  if (row && row.offsetTop !== undefined)
    list.scrollTop = Math.max(0, row.offsetTop - list.clientHeight / 2);
}

/* The entities list keeps its scroll while the same table is shown, and
   starts at the top for another one. */
let entitiesShownFor = null;

function renderEntities() {
  const list = $('#me-entities-list');
  const sameTable = entitiesShownFor === browser.table;
  entitiesShownFor = browser.table;
  rebuildList(list, () => fillEntities(list), sameTable);
}

function fillEntities(list) {
  const source = $('#me-entities-src');
  const table = browser.table;

  source.textContent = '';
  $('#me-n-entities').textContent = '';
  if (!table) {
    list.append(el('p', 'hint mib-empty', 'Pick a table.'));
    return;
  }

  const key = dumpKey(table);
  const command = 'omcicli mib get ' + table.query + (table.entity ? ' ' + table.entity : '');
  const dump = browser.dumps.get(key);

  if (browser.reading.has(key)) {
    source.textContent = command;
    list.append(el('p', 'hint mib-empty', 'Reading…'));
    return;
  }
  if (!dump) return;

  /* The name the device answered with, not the one asked for: that is what
     keeps a wrong class id from being quietly mislabelled. */
  source.textContent = dump.name && dump.name !== table.name
    ? command + ', which the device calls ' + dump.name
    : command;

  const problem = unavailable(dump);
  if (problem) {
    list.append(el('p', 'me-note bad mib-empty', problem));
    if (dump.raw) list.append(rawDetails(dump.raw));
    return;
  }
  if (dump.truncated)
    list.append(el('p', 'me-note bad', 'Truncated: this table is longer than the daemon will hold, '
      + 'so the last entities are missing. Look up one entity id to read it in full.'));
  $('#me-n-entities').textContent = String(dump.instances.length);
  if (!dump.instances.length) {
    /* Not "the OLT created none": omcid has answered 0 rows for entities the
       ONU always has, so an empty answer is only what the MIB said. */
    list.append(el('p', 'hint mib-empty', dump.rows === 0
      ? 'The MIB answered 0 rows for this table.'
      : 'No entities in this dump.'));
    if (dump.raw) list.append(rawDetails(dump.raw));
    return;
  }
  dump.instances.forEach((instance, index) => {
    const number = entityNumber(instance);
    list.append(rowButton(
      String(index),
      [
        { text: entityHex(instance), cls: 'mib-name' },
        { text: Number.isNaN(number) ? '–' : String(number), cls: 'mib-dim' },
        { text: String(attributeCount(instance)), cls: 'mib-dim' },
      ],
      index === browser.entityIndex,
      () => openEntity(index),
    ));
  });
}

function rawDetails(raw) {
  const details = el('details', 'me-raw');
  details.append(el('summary', '', 'Raw output'), el('pre', '', raw));
  return details;
}

function keyValues(pairs) {
  const list = el('dl', 'me-kv');
  for (const [key, value] of pairs)
    list.append(el('dt', '', key), value === '' ? el('dd', 'mib-dim', 'empty') : el('dd', '', value));
  return list;
}

function renderAttributes() {
  const body = $('#me-attrs-body');
  const dump = browser.table && browser.dumps.get(dumpKey(browser.table));
  const instance = dump && !unavailable(dump) ? dump.instances[browser.entityIndex] : null;

  body.textContent = '';
  $('#me-n-attrs').textContent = '';
  for (const [view, button] of [['parsed', $('#me-view-parsed')], ['raw', $('#me-view-raw')]])
    button.setAttribute('aria-pressed', String(browser.attributeView === view));
  if (!instance) {
    body.append(el('p', 'hint mib-empty', 'Pick an entity.'));
    return;
  }
  $('#me-n-attrs').textContent = 'entity ' + entityHex(instance);

  if (browser.attributeView === 'raw') {
    body.append(el('pre', 'mib-pre', instance.raw || dump.raw || '(no output)'));
    return;
  }
  const attributes = entityAttributes(instance);
  if (attributes.length) body.append(keyValues(attributes));
  for (const group of instance.groups) {
    body.append(el('h5', 'mib-group', group.label));
    if (group.attrs.length) body.append(keyValues(group.attrs));
  }
  if (!attributes.length && !instance.groups.length)
    body.append(el('p', 'hint', 'This entity printed no attributes beyond its id.'));
  if (instance.truncated)
    body.append(el('p', 'me-note bad', 'omcid cut this row short: the attributes above are not all of it.'));
}

function renderAll() {
  renderTables();
  renderEntities();
  renderAttributes();
}

/* A phone has room for one pane: the browser says which, and the CSS shows it. */
function showPane(pane) {
  const host = $('#me-browser');
  const changed = host.dataset.pane !== pane;
  host.dataset.pane = pane;
  /* The pane just shown starts where the tapped row was, possibly far down
     the page: bring its top into view. Only where one pane is shown. */
  if (changed && typeof matchMedia === 'function' && matchMedia('(max-width: 720px)').matches && host.scrollIntoView)
    host.scrollIntoView({ block: 'start' });
}

/* ------------------------------------------------------------- reading */

async function readTable(table) {
  const key = dumpKey(table);
  browser.reading.add(key);
  renderAll();
  const dump = await fetchMe(table.query, table.entity);
  browser.reading.delete(key);
  browser.dumps.set(key, dump);
  return dump;
}

/* The first entity is selected with its table, so the attributes pane is never
   blank beside a table that has some. */
async function openTable(table, { reread = false, pane = 'entities' } = {}) {
  browser.table = table;
  browser.entityIndex = -1;
  showPane(pane);
  const key = dumpKey(table);
  if (reread || !browser.dumps.has(key)) await readTable(table);
  if (browser.table !== table) return;   /* another table was picked meanwhile */
  const dump = browser.dumps.get(key);
  if (dump && !unavailable(dump) && dump.instances.length) browser.entityIndex = 0;
  renderAll();
}

function openEntity(index) {
  browser.entityIndex = index;
  showPane('attributes');
  renderEntities();
  renderAttributes();
}

/* Look up: a class id or name a thread quotes that is not in the list, or one
   entity of a table too long to arrive whole. Matching a listed table selects
   that row; anything else is browsed as a row of its own. */
async function lookUp() {
  const query = String($('#me-classid').value || '').trim();
  const entity = String($('#me-entity').value || '').trim();
  const status = $('#me-status');

  if (!query) {
    status.textContent = 'Type a class id or a table name to look up.';
    return;
  }
  const problem = meProblem(query) || entityProblem(entity);
  if (problem) {
    status.textContent = 'Look up needs ' + problem + '.';
    return;
  }
  status.textContent = '';
  const listed = CATALOG.find((table) => table.query === query || String(table.classId) === query
    || table.name.toLowerCase() === query.toLowerCase());
  const table = listed && !entity ? listed : {
    name: listed ? listed.name : query,
    title: listed ? listed.title : '',
    classId: listed ? listed.classId : (/^\d+$/.test(query) ? Number(query) : null),
    query: listed ? listed.query : query,
    entity,
  };
  await openTable(table, { reread: true });
  revealSelectedTable();
}

/*
 * Count entities: every listed table, one at a time, so the Ent column is
 * filled for the whole MIB. It is the same `GET /api/omci?cmd=me` a click on a
 * table makes, once per table, so it needs nothing new from the daemon -- but
 * a run is one read per table, so it starts only from its button and stops on
 * its button. It also stops by itself on the first answer that says the MIB
 * service has stopped servicing requests (omcicli failed or timed out, or
 * printed its table listing instead): walking on would only fill the column
 * with the same failure.
 */
async function countEntities() {
  const button = $('#me-count');
  const status = $('#me-status');

  if (browser.counting) {
    browser.stopCounting = true;
    return;
  }
  browser.counting = true;
  browser.stopCounting = false;
  button.textContent = 'Stop counting';
  let done = 0;
  let stoppedBy = '';
  for (const table of CATALOG) {
    if (browser.stopCounting) break;
    status.textContent = `Counting entities: ${done} of ${CATALOG.length} tables read…`;
    if (!browser.dumps.has(dumpKey(table))) {
      const dump = await readTable(table);
      /* Empty is not enough to stop on: a name this omcicli does not know
         also answers with nothing. A failed or timed-out run, or the table
         listing in place of a table, is the service itself. */
      if (/timed out|could not run|no omcicli/.test(dump.error) || /listed its tables/.test(unavailable(dump) || '')) {
        stoppedBy = table.name + ': ' + unavailable(dump);
        break;
      }
    }
    done++;
    renderTables();
  }
  browser.counting = false;
  button.textContent = 'Count entities';
  status.textContent = stoppedBy
    ? `Stopped after ${done} tables. ${stoppedBy}`
    : browser.stopCounting ? `Stopped after ${done} of ${CATALOG.length} tables.`
      : `Counted all ${CATALOG.length} tables.`;
  renderAll();
}

/* ------------------------------------------------------------- data path */

/* The data-path dumps are not MIB tables: no entities, no attributes, just
   what omcicli printed. */
async function loadDump(what, label) {
  const host = $('#me-out');
  host.textContent = '';
  host.append(el('p', 'hint', 'Reading…'));
  const dump = await fetchOmci({ cmd: 'dump', what });
  host.textContent = '';
  host.append(el('p', 'me-src', 'omcicli dump ' + what + ' (' + label + ')'));
  if (!dump.ok && dump.error) host.append(el('p', 'me-note bad', dump.error));
  if (dump.truncated)
    host.append(el('p', 'me-note bad', 'Truncated: this dump is longer than the daemon will hold.'));
  host.append(el('pre', '', dump.raw || '(no output)'));
}

function renderMeBrowser() {
  if (wired) return null;
  wired = true;

  const dumpBar = $('#me-dumps');
  for (const [what, label] of DUMPS) {
    const button = el('button', 'chip', label);
    button.type = 'button';
    button.onclick = () => loadDump(what, label);
    dumpBar.append(button);
  }

  $('#me-filter').oninput = renderTables;
  $('#me-go').onclick = lookUp;
  $('#me-classid').onkeydown = (event) => { if (event.key === 'Enter') lookUp(); };
  $('#me-entity').onkeydown = (event) => { if (event.key === 'Enter') lookUp(); };
  $('#me-refresh').onclick = () => { if (browser.table) openTable(browser.table, { reread: true, pane: $('#me-browser').dataset.pane }); };
  $('#me-count').onclick = countEntities;
  $('#me-view-parsed').onclick = () => { browser.attributeView = 'parsed'; renderAttributes(); };
  $('#me-view-raw').onclick = () => { browser.attributeView = 'raw'; renderAttributes(); };
  $('#me-back-tables').onclick = () => showPane('tables');
  $('#me-back-entities').onclick = () => showPane('entities');
  arrowKeys($('#me-tables-list'), false);
  arrowKeys($('#me-entities-list'), true);

  /*
   * The device is deliberately NOT asked for its table list.
   * `omcicli get tables` returns nothing and leaves the stock MIB service unable
   * to answer anything until omci_app is restarted -- so this tab used to disable
   * the diagnostics it exists to show, just by being opened. The list above
   * came off a stick once and changes only with the base.
   */
  renderAll();
  /* The page opens on a phone at the list, and on a desktop with one table
     already read, so the three panes are not empty on arrival. */
  return openTable(CATALOG.find((table) => table.classId === DEFAULT_TABLE), { pane: 'tables' })
    .then(revealSelectedTable);
}

export { renderMeBrowser, CATALOG };
