/*
 * The Firmware tab: which partition is which, and the one-shot trial boot.
 *
 * sw_tryactive boots a partition ONCE with the watchdog armed, so an image that
 * does not come up reverts itself. Keeping it is a separate, deliberate act.
 */

import { $, el, fail, get } from './dom.js';

async function renderFirmware() {
  const host = $('#parts');
  host.textContent = '';
  let fw;
  try {
    fw = await get('/api/firmware');
  } catch (e) { fail(e); return; }

  const env = fw.env || {};
  const committed = env.sw_commit;
  const booted = env.sw_active;
  const pending = env.sw_tryactive;

  const t = el('table');
  const head = el('tr');
  for (const h of ['Partition', 'Version', 'State']) head.append(el('th', null, h));
  t.append(head);

  for (const p of ['0', '1']) {
    const tr = el('tr');
    tr.append(el('td', null, 'Partition ' + p));
    /*
       Two version strings per partition, and they are not the same thing.
       sw_version<p> is written by the updater from the image's fwu_ver.
       sw_custom_version<p> is an override the base's chk_swver_fix.sh prefers,
       and it is the documented-nowhere answer to the most-asked question about
       this device: how to stop OMCI_SW_VER reverting at every boot
       (Anime4000/RTL960x#30). The thread's advice is OMCI_OLT_MODE=21, which
       that same script calls "a hack" that "causes sigsegv of /bin/checkomci".
    */
    const vcell = el('td');
    const custom = env['sw_custom_version' + p];
    vcell.append(el('div', null, env['sw_version' + p] || 'empty'));
    if (custom) {
      vcell.append(el('div', 'aside', 'reported as ' + custom));
      vcell.append(el('span', 'tag identity', 'custom version'));
    }
    tr.append(vcell);

    const st = el('td');
    if (p === committed) st.append(el('span', 'tag omci', 'kept'));
    if (p === booted) st.append(el('span', 'tag', 'booted'));
    if (p === pending && pending !== '2') st.append(el('span', 'tag identity', 'trial pending'));

    const acts = el('div');
    if (p !== committed) {
      const b = el('button', 'fwbtn', 'Try partition ' + p);
      b.onclick = () => fwAction('try', p,
        `Partition ${p} will boot once. If it fails, the stick returns to partition ${committed} on its own.`);
      acts.append(b);
    }
    if (p !== committed && p === booted) {
      const b = el('button', 'fwbtn', 'Keep partition ' + p);
      b.onclick = () => fwAction('commit', p,
        `Partition ${p} becomes the one the stick boots from now on.`);
      acts.append(b);
    }
    st.append(acts);
    tr.append(st);
    t.append(tr);
  }
  host.append(t);

  /* Spell the commands out with this stick's own address and the partition it
     is not running, so they can be pasted without being adapted. */
  const other = booted === '0' ? '1' : '0';
  $('#upload').textContent = [
    '# on your machine, in ~/git/odi-sandbox',
    'make image                     # -> firmware/out/*.tar',
    '',
    'IMG=firmware/out/<image>.tar',
    `cat "$IMG" | ssh admin@${location.hostname} 'cat > /tmp/img.tar'`,
    `md5 -q "$IMG"; ssh admin@${location.hostname} 'md5sum /tmp/img.tar'`,
    '',
    `# writes partition ${other}, the one this stick is not running`,
    `ssh admin@${location.hostname} '/etc/scripts/fwu_starter.sh ${other} /tmp/img.tar'`,
  ].join('\n');

  const foot = el('p', 'hint');
  /* Which confd is answering, not which one the image shipped. A binary at
     /etc/config/confd/confd overrides the image's copy and survives reflashing,
     so the two drift apart silently; reporting the build makes that a question
     you can ask rather than one you have to go and look. */
  foot.textContent = 'Running ' + (fw.running || 'unknown') +
    ' from partition ' + (booted === undefined ? '?' : booted) +
    '. Config UI build ' + (fw.confd || 'unknown') + '.';
  host.append(foot);

  /* What this image was built from, if it says. A stick running an override
     has no manifest, and saying so is more useful than an empty panel: it
     means the daemon answering is not the one the image ships. */
  const b = fw.build || {};
  const keys = Object.keys(b);
  if (keys.length) {
    host.append(el('h2', null, 'This image'));
    const t = el('table');
    for (const k of ['image', 'base', 'confd', 'exporter', 'built']) {
      if (!(k in b)) continue;
      const tr = el('tr');
      tr.append(el('td', null, k), el('td', 'mono', b[k]));
      t.append(tr);
    }
    host.append(t);
    if (b.confd && fw.confd && b.confd !== fw.confd) {
      host.append(el('p', 'warn',
        `The config UI answering is build ${fw.confd}, but this image ships ` +
        `${b.confd} — so an override in /etc/config is being used.`));
    }
  } else {
    host.append(el('p', 'hint',
      'No /etc/odi-build in this image, so it predates build manifests.'));
  }

  if (fw.mem) $('#memtotal').textContent = fw.mem;

  const rb = el('button', 'fwbtn danger', 'Reboot now');
  rb.onclick = () => fwAction('reboot', '',
    'The stick reboots. It will be unreachable for about a minute.');
  host.append(rb);
}

async function fwAction(action, partition, warning) {
  const out = $('#fwout');
  out.textContent = '';
  if (!confirm(warning + '\n\nContinue?')) return;
  try {
    const r = await fetch('/api/firmware', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=' + action + '&partition=' + encodeURIComponent(partition),
    });
    const res = await r.json();
    if (!res.ok) { out.append(el('div', 'bad', res.error || 'failed')); return; }

    if (action === 'try') {
      out.append(el('div', 'warn',
        `Partition ${partition} is armed for one boot. Reboot to try it; if it ` +
        `does not come up the stick returns here on its own.`));
    } else if (action === 'commit') {
      out.append(el('div', 'good', `Partition ${partition} is now the one it boots.`));
    } else {
      out.append(el('div', 'warn', 'Rebooting. This page will stop responding.'));
    }
    if (action !== 'reboot') await renderFirmware();
  } catch (e) {
    out.append(el('div', 'bad', String(e.message || e)));
  }
}

export { renderFirmware };
