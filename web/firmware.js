/*
 * The Firmware tab: which partition is which, and the one-shot trial boot.
 *
 * sw_tryactive boots a partition ONCE with the watchdog armed, so an image that
 * does not come up reverts itself. Keeping it is a separate, deliberate act.
 */

import { $, el, fail, get, bytes } from './dom.js';
import { CLASS_LABEL } from './state.js';

/* How often the page asks how a background write is going. */
const WRITE_POLL_MS = 3000;

/*
 * An image sitting in /tmp, if one has been uploaded this session. The device
 * is not asked -- a stale /tmp/img.tar from some previous attempt is exactly
 * what should NOT quietly become writable with one click.
 */
let UPLOADED = null;

/*
 * Upload. XHR rather than fetch, for the one thing fetch cannot do: report
 * progress while the body is going out. Three megabytes over a link this
 * device drives at its own pace is long enough that a button which simply
 * greys out looks broken.
 */
function uploadImage() {
  const out = $('#fw-upload-out');
  const f = $('#fw-file').files && $('#fw-file').files[0];

  out.textContent = '';
  if (!f) { out.append(el('div', 'bad', 'Pick the tarball first.')); return; }

  const btn = $('#fw-upload');
  const bar = el('div', 'progress');
  const fill = el('div', 'fill');

  bar.append(fill);
  out.append(el('div', null, `Uploading ${f.name} (${bytes(f.size)})…`));
  out.append(bar);
  btn.disabled = true;

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload');
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) fill.style.width = Math.round((e.loaded / e.total) * 100) + '%';
  };
  xhr.onload = () => {
    btn.disabled = false;
    let j = {};
    try { j = JSON.parse(xhr.responseText); } catch (e) { /* reported below */ }
    if (!j.ok) {
      out.append(el('div', 'bad', j.error || `upload failed: HTTP ${xhr.status}`));
      return;
    }
    UPLOADED = { name: f.name, bytes: j.bytes, md5: j.md5 };
    out.append(el('div', 'good', `${bytes(j.bytes)} received.`));
    /* The device's own md5, to compare with the one beside the image you
       built. The updater checks the kernel and rootfs md5s from inside the tar
       before it erases anything, so this is about the transfer. */
    if (j.md5) out.append(el('div', 'mono', 'md5 ' + j.md5));
    renderFirmware();
  };
  xhr.onerror = () => {
    btn.disabled = false;
    out.append(el('div', 'bad', 'The upload did not complete.'));
  };
  xhr.send(f);
}

async function writeImage(part) {
  const out = $('#fwout');

  if (!confirm(`Write the uploaded image to partition ${part}?\n\n`
      + 'This takes about eighty seconds and the stick must not lose power '
      + 'meanwhile. The partition you are running now is not touched, and '
      + 'nothing boots the new one until you try it.')) return;

  out.textContent = '';
  out.append(el('div', 'warn', `Writing partition ${part}.`));
  try {
    const r = await fetch('/api/firmware', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'write', partition: part }).toString(),
    });
    const j = await r.json();
    if (j.output) out.append(el('pre', null, String(j.output).trim()));
    if (!j.ok) {
      out.append(el('div', 'bad', j.error || 'the updater refused'));
      return;
    }
    /* An image whose starter writes in the background leaves a state in
       /api/firmware to follow; one whose starter blocks has already
       finished, and its answer above is the whole story. */
    await followWrite(part);
  } catch (e) {
    out.append(el('div', 'bad', String(e.message || e)));
  }
}

/* Poll a background write until it says ok or failed. One poll at a time:
   a re-render while writing would otherwise start another. */
async function followWrite(part) {
  if (FOLLOWING) return;
  FOLLOWING = true;
  try { await followLoop(part); } finally { FOLLOWING = false; }
  renderFirmware();
}

async function followLoop(part) {
  const out = $('#fwout');
  const log = el('pre', null, '');
  out.append(log);
  for (;;) {
    let fw;
    try { fw = await get('/api/firmware'); } catch (e) { fw = {}; }
    const w = fw.write;
    if (!w) {
      out.append(el('div', 'good', `Partition ${part} written. Press Try on it — a `
        + 'trial boots once, and reverts by itself if the image does not come up.'));
      break;
    }
    log.textContent = String(w.log || '').trim();
    if (w.state === 'ok') {
      out.append(el('div', 'good', `Partition ${w.slot} written and read back. Press Try `
        + 'on it — a trial boots once, and reverts by itself if the image does not '
        + 'come up.'));
      break;
    }
    if (w.state === 'failed') {
      out.append(el('div', 'bad', `The write of partition ${w.slot} failed`
        + (w.rc ? ` (exit ${w.rc})` : '') + '. The log above says whether it got as '
        + 'far as erasing; the running partition was not touched.'));
      break;
    }
    await new Promise((res) => setTimeout(res, WRITE_POLL_MS));
  }
}

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

  const writing = fw.write && fw.write.state === 'running';
  for (const p of ['0', '1']) {
    const tr = el('tr');
    tr.append(el('td', null, 'Partition ' + p));
    /*
       The running partition shows what it runs: the image name from the build
       manifest, or /etc/version. sw_version<p> in the U-Boot environment is
       only what the updater last recorded there, and this image's fwu.sh
       records nothing unless asked -- so on a trial of ours it still names the
       stock firmware the slot held before, which is what this cell used to
       show as the running version.
    */
    const vcell = el('td');
    const recorded = env['sw_version' + p];
    if (p === booted) {
      const running = (fw.build || {}).image || fw.running || recorded || 'unknown';
      vcell.append(el('div', null, running));
      if (recorded && recorded !== running) {
        vcell.append(el('div', 'aside', 'U-Boot records ' + recorded));
      }
    } else {
      vcell.append(el('div', null, recorded || 'empty'));
      vcell.append(el('div', 'aside', 'as U-Boot records it'));
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
        `Partition ${p} will boot once, at the next reboot. If it fails, the stick `
        + `returns to partition ${committed} on its own.`);
      acts.append(b);
    }
    /*
       Offered only for the partition this stick is NOT running. The daemon
       refuses the running one as well -- fwu.sh would too -- but finding that
       out after the erase has started is not where anyone should learn it.
    */
    /* `booted !== undefined` matters: with sw_active unreadable this offered to
       write BOTH partitions, including the running one. The daemon refuses
       that by reading sw_active itself, so nothing could have come of it -- but
       an interface that offers a destructive action it cannot justify is one
       nobody should trust the rest of. */
    if (UPLOADED && booted !== undefined && p !== booted && !writing) {
      const b = el('button', 'fwbtn danger', 'Write the uploaded image to ' + p);
      b.onclick = () => writeImage(p);
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
    '# on your machine, in the odi-oss checkout',
    'make image                     # -> out/image/<version>.tar',
    '',
    'IMG=out/image/<version>.tar',
    `cat "$IMG" | ssh root@${location.hostname} 'cat > /tmp/img.tar'`,
    `md5 -q "$IMG"; ssh root@${location.hostname} 'md5sum /tmp/img.tar'`,
    '',
    `# writes partition ${other}, the one this stick is not running, and waits`,
    `ssh root@${location.hostname} '/etc/scripts/fwu_starter.sh --foreground ${other} /tmp/img.tar'`,
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

  if (writing) {
    host.append(el('p', 'warn', `Partition ${fw.write.slot} is being written. `
      + 'Do not reboot or power off until it finishes.'));
    followWrite(fw.write.slot);
  }

  const trial = booted !== undefined && committed !== undefined && booted !== committed;
  const rb = el('button', 'fwbtn danger', 'Reboot now — ' + CLASS_LABEL.reboot);
  rb.onclick = () => fwAction('reboot', '',
    'The stick reboots and the fibre service drops for about two minutes.'
    + (trial ? ` This is a trial of partition ${booted}: the reboot comes back on `
      + `partition ${committed}, the committed one, not on this image.` : ''));
  host.append(rb);
}

/* Set while a write is being followed, so a re-render does not start a
   second poll loop. */
let FOLLOWING = false;

async function fwAction(action, partition, warning) {
  const out = $('#fwout');
  out.textContent = '';
  if (!confirm((action === 'reboot' ? CLASS_LABEL.reboot + '\n\n' : '') + warning + '\n\nContinue?')) return;
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

function wireFirmware() {
  $('#fw-upload').onclick = uploadImage;
}

export { renderFirmware, wireFirmware };
