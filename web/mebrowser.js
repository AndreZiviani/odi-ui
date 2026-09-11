/*
 * The MIB, unedited.
 *
 * Everything the OLT built, in whatever shape the firmware prints it. The
 * Services tab answers six questions; this one answers the rest, and it is the
 * page to reach for when a thread asks you to post `omcicli mib get 84` --
 * because that is exactly what it runs.
 *
 * Two views of the same dump, deliberately: a table when the parser could make
 * sense of it, and the bytes underneath when you want to be sure the table is
 * not lying to you. Nothing here decides what an attribute means.
 */

import { $, el } from './dom.js';
import { fetchOmci, fetchMe } from './omci.js';

/*
 * The tables this image can register, from /lib/omci/mib_*.so in the base
 * itself rather than from a list someone typed. The device is still asked at
 * load time -- only the running stack knows which of these it actually
 * registered, and on a line that never reached O5 the difference is the answer
 * -- but the picker is useful before that returns, and remains useful if the
 * `get tables` output turns out to be shaped differently than expected.
 */
const TABLES = [
  'Anig', 'Authen_Sec_Method', 'Cardholder', 'CircuitPack',
  'Dot1RateLimiter', 'EthExtPmData', 'EthPmData2', 'EthPmData3',
  'EthPmDataDs', 'EthPmDataUs', 'EthPmHistoryData', 'EthUni',
  'ExtVlanTagOperCfgData', 'ExtendedIpHostCfgData', 'ExtendedMcastOperProf',
  'ExtendedOnuG', 'FecPMHD', 'GalEthProf', 'GemIwTp', 'GemPortCtp',
  'GemPortNetworkCtpPMHD', 'GemPortPMHD', 'GemTrafficDescriptor',
  'GeneralPurposeBuffer', 'GenericPortal', 'IpHostConfigData', 'LargeString',
  'LctUni', 'LoidAuth', 'LoopDetect', 'MacBriPortBriTblData',
  'MacBriPortCfgData', 'MacBriServProf', 'MacBridgePortFilterPreassign',
  'MacBridgePortFilterTable', 'MacBridgePortPmMonitorHistoryData',
  'Map8021pServProf', 'McastOperProf', 'McastSubConfInfo', 'McastSubMonitor',
  'Me242', 'Me243', 'Me350', 'Me370', 'Me373', 'MeZteMcastTag', 'MeZteSntp',
  'MultiGemIwTp', 'Network_addr', 'OctetString', 'OltG',
  'OltLocationCfgData', 'Omci', 'Ont2g', 'OntData', 'OntSelfLoopDetect',
  'OntSystemMgmt', 'Ontg', 'OnuCapability', 'OnuLoopDetection',
  'OnuPwrShedding', 'OnuRemoteDbg', 'PriQ', 'PrivateTellionOntStatistics',
  'PrivateTqCfg', 'PrivateVlanCfg', 'PseudowireMaintenanceProfile',
  'SWImage', 'Scheduler', 'TR069ManageServer', 'Tcont', 'TcpUdpCfgData',
  'ThresholdData1', 'ThresholdData2', 'Unig', 'VEIP', 'VlanTagFilterData',
  'VlanTagOpCfgData', 'hsq_default', 'hsq_wan', 'hsq_wan_deti'
];

/* The class ids people quote in threads, so the picker speaks both dialects. */
const SHORTCUTS = [
  ['84', 'VLAN tag filters (84)'],
  ['171', 'Extended VLAN tagging (171)'],
  ['7', 'Software images (7)'],
  ['131', 'OLT-G (131)'],
  ['262', 'T-CONT (262)'],
  ['268', 'GEM port CTP (268)'],
  ['47', 'MAC bridge port config (47)'],
  ['11', 'PPTP Ethernet UNI (11)'],
  ['329', 'VEIP (329)'],
];

const DUMPS = [
  ['conn', 'Data path connections'],
  ['srvflow', 'Data path service flows'],
  ['qmap', 'T-CONT queue mapping'],
  ['tasks', 'OMCI tasks'],
];

let wired = false;

function renderTable(host, dump) {
  if (!dump.instances.length) {
    host.append(el('p', 'hint', 'No instances. The table is registered but the '
      + 'OLT has not created anything in it.'));
    return;
  }
  for (const inst of dump.instances) {
    const box = el('section', 'me-inst');

    box.append(el('h4', '', 'Entity ' + (inst.id || '(unnamed)')));
    const dl = el('dl', 'me-kv');
    for (const [k, v] of inst.attrs) {
      if (/^entity\s*id$/i.test(k)) continue;
      dl.append(el('dt', '', k), el('dd', '', v));
    }
    if (inst.attrs.length > 1) box.append(dl);

    for (const g of inst.groups) {
      box.append(el('h5', '', g.label));
      if (!g.attrs.length) continue;
      const gdl = el('dl', 'me-kv');
      for (const [k, v] of g.attrs) gdl.append(el('dt', '', k), el('dd', '', v));
      box.append(gdl);
    }
    host.append(box);
  }
}

function show(dump, asked) {
  const host = $('#me-out');

  host.textContent = '';

  if (!dump.ok && dump.error) {
    host.append(el('p', 'me-note bad', dump.error));
    if (!dump.raw) return;
  }

  host.append(el('p', 'me-src', dump.name
    ? asked + ' — the device calls this ' + dump.name
    : asked));

  if (dump.truncated)
    host.append(el('p', 'me-note bad', 'Truncated: this dump is longer than the '
      + 'daemon will hold. Ask for a single entity to see all of it.'));

  renderTable(host, dump);

  const det = el('details', 'me-raw');
  det.append(el('summary', '', 'Raw output'));
  det.append(el('pre', '', dump.raw || '(no output)'));
  host.append(det);
}

async function load() {
  const me = String($('#me-pick').value || '').trim();
  const entity = String($('#me-entity').value || '').trim();

  if (!me) return;
  $('#me-out').textContent = 'Reading…';
  show(await fetchMe(me, entity), 'ME ' + me + (entity ? ' entity ' + entity : ''));
}

async function loadDump(what, label) {
  $('#me-out').textContent = 'Reading…';
  show(await fetchOmci({ cmd: 'dump', what }), label);
}

function renderMeBrowser() {
  if (wired) return;
  wired = true;

  /* A datalist, not a select: the 81 names below are every table this image
     can register, but omcicli also takes a bare class id and a thread will
     always quote one this list does not have a name for. Offering the list
     without refusing anything else is the only shape that serves both. */
  const list = $('#me-tables-list');
  for (const [v, label] of SHORTCUTS) {
    const o = el('option', '', label);
    o.value = v;
    list.append(o);
  }
  for (const t of TABLES) {
    const o = el('option');
    o.value = t;
    list.append(o);
  }
  $('#me-pick').value = '84';

  const bar = $('#me-dumps');
  for (const [what, label] of DUMPS) {
    const b = el('button', '', label);
    b.type = 'button';
    b.onclick = () => loadDump(what, label);
    bar.append(b);
  }

  $('#me-go').onclick = load;
  $('#me-pick').onkeydown = (e) => { if (e.key === 'Enter') load(); };
  $('#me-entity').onkeydown = (e) => { if (e.key === 'Enter') load(); };

  /*
   * What the running stack registered, verbatim. It is in a details block
   * rather than parsed into the picker on purpose: the picker's list comes from
   * the image and is known-good, and nothing here has yet seen what
   * `omcicli get tables` prints on a live stick.
   */
  fetchOmci({ cmd: 'tables' }).then((d) => {
    $('#me-tables').textContent = d.raw || d.error || '(no output)';
  });

  load();
}

export { renderMeBrowser };
