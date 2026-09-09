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
    tr.append(el('td', null, env['sw_version' + p] || 'empty'));

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
