/*
 * Entry point: wire the tabs, load everything the page renders from, and start
 * the status poll.
 *
 * The UI renders from /api/schema, so a new config key appears without touching
 * any of this.
 */

import { $, el, fail, get } from './dom.js';
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
$('#pw-save').onclick = savePassword;
$('#gopassword').onclick = () => { showTab('config'); $('#pw-pass').focus(); };
$('#discard').onclick = () => { EDITS.clear(); renderAll(); refreshSaveBar(); $('#saveout').textContent = ''; };

/*
 * Say so, loudly and everywhere, while the built-in credential is in force.
 * The fallback exists so a freshly flashed stick is reachable at all; leaving
 * it in place is a different decision, and one the operator has to be able to
 * see they are making.
 */
async function checkAuth() {
  try {
    const fw = await get('/api/firmware');
    $('#defaultauth').hidden = !fw.defaultauth;
  } catch (e) { /* the banner is advisory; a failed read must not blank the page */ }
}

const showTab = (name) => {
  for (const b of document.querySelectorAll('nav button')) {
    b.classList.toggle('on', b.dataset.tab === name);
    if (b.dataset.tab === name) b.click();
  }
};

/*
 * Change the credential this page authenticates with, creating the file if it
 * is not there. That last part is the point: the state this fixes is the state
 * of every factory-reset stick, and an operator who has to find an ssh client
 * that still speaks to a 2007 dropbear will leave the default in place.
 */
async function savePassword() {
  const out = $('#pw-out');
  const user = $('#pw-user').value.trim();
  const pass = $('#pw-pass').value;

  out.textContent = '';
  try {
    const r = await fetch('/api/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user, password: pass }).toString(),
    });
    const j = await r.json();
    if (!j.ok) { out.append(el('div', 'bad', j.error || 'refused')); return; }
    out.append(el('div', 'good', 'Saved to /etc/config/confd.auth.'));
    /* The browser still holds the OLD credential and will replay it on the
       next request, which now answers 401. Saying nothing here turns a
       successful change into what looks like a broken page. */
    out.append(el('div', null,
      'Your browser is still using the old one. Sign out, then sign back in as '
      + user + '.'));
    $('#pw-pass').value = '';
    await checkAuth();
  } catch (e) { out.append(el('div', 'bad', String(e.message || e))); }
}

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
  await checkAuth();
  await refresh();
  /* A scrape is three forks of ~35 ms each on a ~300 BogoMIPS core, so this is
     deliberately unhurried. */
  setInterval(refresh, 15000);
})();
