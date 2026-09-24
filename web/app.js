/*
 * Entry point: wire the tabs, load everything the page renders from, and start
 * the status poll.
 *
 * The UI renders from /api/schema, so a new config key appears without touching
 * any of this.
 */

import { $, el, fail, get, wireLore } from './dom.js';
import { S, EDITS } from './state.js';
import { renderStatus } from './status.js';
import { renderAll } from './config.js';
import { save, refreshSaveBar, renderIdentitySwitch } from './save.js';
import { renderFirmware, wireFirmware } from './firmware.js';
import { renderServices } from './services.js';
import { renderMeBrowser } from './mebrowser.js';
import { wireRestore } from './restore.js';
import { renderL2 } from './l2.js';
import { renderTools } from './tools.js';

const TABS = ['status', 'config', 'advanced', 'services', 'omci', 'tools', 'admin', 'firmware'];
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
    if (b.dataset.tab === 'tools') renderTools();
    if (b.dataset.tab === 'admin') renderSshKeys();
  };
}
$('#filter').oninput = () => renderAll();
$('#save').onclick = save;
$('#services-reload').onclick = () => renderServices(true);
$('#pw-save').onclick = savePassword;
$('#sshkey-add').onclick = addSshKey;
$('#reset-go').onclick = resetConfig;
wireRestore();
wireFirmware();
/* Every tab's markup is in the document from the start, hidden or not, so one
   pass at boot wires the footnotes on all seven. */
wireLore();
/* On demand, not on the poll: it is another diag fork and most visits to the
   status page do not need it. Not on an image whose diag has no L2-table
   command yet (odi-oss: it needs a kernel readback first) -- the button is
   disabled in the page and says so. */
if (!$('#l2-load').disabled) $('#l2-load').onclick = renderL2;
$('#gopassword').onclick = () => { showTab('admin'); $('#pw-pass').focus(); };
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
    S.FW = fw;
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
 * of every factory-reset stick, and a credential that can only be set from a
 * shell is one that stays at its default.
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

/*
 * SSH public keys for the device login. The list is the file as it is, so a
 * key added over ssh by hand shows up here too, and a delete names the line
 * number the server reported rather than re-sending the key text.
 */
async function renderSshKeys() {
  const box = $('#sshkeys');
  box.textContent = '';
  try {
    const j = await get('/api/sshkeys');
    if (!j.keys.length) { box.append(el('p', 'field-note', 'No keys yet: SSH accepts the root password only.')); return; }
    const t = el('table', 'kv');
    for (const k of j.keys) {
      const tr = el('tr');
      const parts = k.line.split(/\s+/);
      const blob = parts[1] || '';
      tr.append(el('td', null, parts[0] || ''));
      tr.append(el('td', 'mono', blob.length > 24 ? blob.slice(0, 12) + '\u2026' + blob.slice(-8) : blob));
      tr.append(el('td', null, parts.slice(2).join(' ')));
      const del = el('button', null, 'Remove');
      del.type = 'button';
      del.onclick = () => delSshKey(k.i);
      const td = el('td'); td.append(del); tr.append(td);
      t.append(tr);
    }
    box.append(t);
  } catch (e) { box.append(el('div', 'bad', String(e.message || e))); }
}

async function addSshKey() {
  const out = $('#sshkey-out');
  const key = $('#sshkey-new').value.trim();
  out.textContent = '';
  try {
    const r = await fetch('/api/sshkeys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key }).toString(),
    });
    const j = await r.json();
    if (!j.ok) { out.append(el('div', 'bad', j.error || 'refused')); return; }
    $('#sshkey-new').value = '';
    out.append(el('div', 'good', 'Added. dropbear reads the file on every login; nothing to restart.'));
    await renderSshKeys();
  } catch (e) { out.append(el('div', 'bad', String(e.message || e))); }
}

async function delSshKey(i) {
  const out = $('#sshkey-out');
  out.textContent = '';
  try {
    const r = await fetch('/api/sshkeys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ delete: String(i) }).toString(),
    });
    const j = await r.json();
    if (!j.ok) { out.append(el('div', 'bad', j.error || 'refused')); return; }
    await renderSshKeys();
  } catch (e) { out.append(el('div', 'bad', String(e.message || e))); }
}

/*
 * Reset the service config, backup first.
 *
 * The backup is fetched as a blob and handed to the browser BEFORE the
 * destructive call, and the reset does not run if that fails. A link the
 * operator is told to click first is not a precondition -- it is a hope, and
 * the whole reason this device has bricked sticks in the field is resets done
 * without one.
 */
async function resetConfig() {
  const out = $('#reset-out');
  const btn = $('#reset-go');

  out.textContent = '';
  if (!confirm('Reset the service configuration to the image defaults?\n\n'
      + 'The keys in /etc/config_default.xml go back to their defaults: the four '
      + 'LOID keys are emptied, and DEVICE_TYPE, DUAL_MGMT_MODE and the three '
      + 'OMCI_CUSTOM masks (read only by the stock firmware) are reset. The '
      + 'management IP, the VLAN, the PLOAM password, the serial number and the '
      + 'MAC keys are NOT touched.\n\nA backup downloads first.')) return;

  btn.disabled = true;
  try {
    out.append(el('div', null, 'Downloading a backup…'));
    const r = await fetch('/api/backup', { cache: 'no-store' });
    if (!r.ok) throw new Error('backup failed: HTTP ' + r.status);
    const blob = await r.blob();
    if (!blob.size) throw new Error('the backup came back empty');

    /* Name it for the stick and the day, so a folder of these is still
       readable in six months. */
    const stamp = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `odi-config-${location.hostname}-${stamp}.xml`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    out.append(el('div', 'good', `Backup saved (${blob.size} bytes).`));

    const p = await fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'store=cs&_confirm=reset',
    });
    const j = await p.json();
    if (j.output) out.append(el('pre', null, j.output.trim()));
    if (!j.ok) { out.append(el('div', 'bad', j.error || 'the reset reported a failure')); return; }
    S.VALUES = await get('/api/values');
    renderAll();
    /* Of the reset keys, only the LOID ones are read here, by omcid, and
       they apply the way every omcid key does. */
    out.append(el('div', 'warn', 'Written. The LOID keys take effect when OMCI is '
      + 'applied (Apply now, on the Config tab save bar) or at the next reboot; the '
      + 'rest are read only by the stock firmware.'));
  } catch (e) {
    out.append(el('div', 'bad', String(e.message || e)));
    out.append(el('div', null, 'Nothing was reset.'));
  } finally {
    btn.disabled = false;
  }
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
    let metaRows, consRows, baseRows, featRows, settRows;
    [S.SCHEMA, S.VALUES, metaRows, consRows, S.DEFAULTS, baseRows, featRows, settRows, S.FW] =
      await Promise.all([
        get('/api/schema'), get('/api/values'), get('/api/meta'),
        get('/api/consumers'), get('/api/defaults'), get('/api/baseline'),
        get('/api/features'), get('/api/settings').catch(() => []),
        get('/api/firmware').catch(() => ({})),
      ]);
    for (const m of metaRows) S.META[m.name] = m;
    for (const r of settRows) S.SETTINGS[r.name] = r;
    for (const c of consRows) S.CONS[c.name] = c;
    for (const b of baseRows) S.BASELINE[b.name] = b.value;
    for (const f of featRows) (S.FEATURES[f.mask] ||= []).push(f);
    renderAll();
    renderIdentitySwitch();
  } catch (e) { fail(e); }
  await checkAuth();
  await refresh();
  /* A scrape is three forks of ~35 ms each on a ~300 BogoMIPS core, so this is
     deliberately unhurried. */
  setInterval(refresh, 15000);
})();
