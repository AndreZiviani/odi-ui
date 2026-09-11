/*
 * Entry point: wire the tabs, load everything the page renders from, and start
 * the status poll.
 *
 * The UI renders from /api/schema, so a new config key appears without touching
 * any of this.
 */

import { $, fail, get } from './dom.js';
import { S, EDITS } from './state.js';
import { renderStatus } from './status.js';
import { renderConfig, renderAll } from './config.js';
import { save, refreshSaveBar } from './save.js';
import { renderFirmware } from './firmware.js';
import { renderServices } from './services.js';
import { renderMeBrowser } from './mebrowser.js';

const TABS = ['status', 'config', 'advanced', 'services', 'omci', 'firmware'];
for (const b of document.querySelectorAll('nav button')) {
  b.onclick = () => {
    for (const o of document.querySelectorAll('nav button')) o.classList.toggle('on', o === b);
    for (const t of TABS) $('#' + t).hidden = b.dataset.tab !== t;
    if (b.dataset.tab === 'firmware') renderFirmware();
    /* The MIB tabs read the device, so they are loaded on first sight rather
       than at boot: six forks of ~35 ms each is not something to spend before
       the status page has painted. */
    if (b.dataset.tab === 'services') renderServices();
    if (b.dataset.tab === 'omci') renderMeBrowser();
  };
}
$('#filter').oninput = (e) => renderConfig('#sections', S.SCHEMA, e.target.value);
$('#save').onclick = save;
$('#services-reload').onclick = () => renderServices(true);
$('#discard').onclick = () => { EDITS.clear(); renderAll(); refreshSaveBar(); $('#saveout').textContent = ''; };

async function refresh() {
  try {
    const st = await get('/api/status');
    if (st.error) throw new Error(st.error);
    renderStatus(st.raw);
  } catch (e) { fail(e); }
}

(async function init() {
  try {
    let metaRows, consRows, baseRows, featRows;
    [S.SCHEMA, S.VALUES, metaRows, consRows, S.DEFAULTS, baseRows, featRows] = await Promise.all([
      get('/api/schema'), get('/api/values'), get('/api/meta'),
      get('/api/consumers'), get('/api/defaults'), get('/api/baseline'),
      get('/api/features'),
    ]);
    for (const m of metaRows) S.META[m.name] = m;
    for (const c of consRows) S.CONS[c.name] = c;
    for (const b of baseRows) S.BASELINE[b.name] = b.value;
    for (const f of featRows) (S.FEATURES[f.mask] ||= []).push(f);
    renderAll();
  } catch (e) { fail(e); }
  await refresh();
  /* A scrape is three forks of ~35 ms each on a ~300 BogoMIPS core, so this is
     deliberately unhurried. */
  setInterval(refresh, 15000);
})();
