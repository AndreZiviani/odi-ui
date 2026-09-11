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
import { wireRestore } from './restore.js';
import { renderL2 } from './l2.js';
import { renderTools } from './tools.js';

const TABS = ['status', 'config', 'advanced', 'services', 'omci', 'tools', 'firmware'];
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
  };
}
$('#filter').oninput = (e) => renderConfig('#sections', S.SCHEMA, e.target.value);
$('#save').onclick = save;
$('#services-reload').onclick = () => renderServices(true);
$('#pw-save').onclick = savePassword;
$('#reset-go').onclick = resetConfig;
wireRestore();
/* On demand, not on the poll: it is another diag fork and most visits to the
   status page do not need it. */
$('#l2-load').onclick = renderL2;
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
  if (!confirm('Reset the service configuration to image defaults?\n\n'
      + 'VLAN, management IP, device mode and the OMCI settings go back to '
      + 'defaults, and the PLOAM password is cleared. The serial number, MAC '
      + 'key and MAC address are NOT touched.\n\nA backup downloads first.')) return;

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
    out.append(el('div', 'warn', 'Written. It takes effect at the next reboot.'));

    /*
     * The management IP is in the cs store, so the reset takes it back to
     * 192.168.1.1 -- and on our lines that is off one stick's management
     * subnet and collides with the other. The runbook's rule is to restore it
     * BEFORE rebooting, which is a step that only works if you remember it, so
     * offer it here with the old value already in hand.
     */
    const wasIp = S.VALUES.LAN_IP_ADDR;
    if (wasIp && wasIp !== '192.168.1.1') {
      out.append(el('div', 'warn', `The management IP was ${wasIp} and the reset `
        + 'has set it back to 192.168.1.1. Put it back before rebooting, or this '
        + 'stick comes up on an address you may not be able to reach.'));
      const fix = el('button', 'fwbtn', `Restore the management IP to ${wasIp}`);
      fix.type = 'button';
      fix.onclick = async () => {
        fix.disabled = true;
        const w = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ LAN_IP_ADDR: wasIp }).toString(),
        });
        const wj = await w.json();
        const r0 = (wj.results || [])[0] || {};
        out.append(el('div', r0.ok ? 'good' : 'bad',
          r0.ok ? `Management IP restored to ${r0.value}.`
                : `Could not restore it: ${r0.error || 'unknown'}`));
      };
      out.append(fix);
    }

    const rb = el('button', 'fwbtn danger', 'Reboot now');
    rb.type = 'button';
    rb.onclick = () => fetch('/api/firmware', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=reboot',
    });
    out.append(rb);
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
