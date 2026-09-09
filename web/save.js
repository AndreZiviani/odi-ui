/*
 * The save bar, the write, and applying it.
 *
 * Nothing is applied implicitly: a config write on this device does nothing
 * until omci_app restarts or the stick reboots, so the response says which and
 * the user decides.
 */

import { $, el, get } from './dom.js';
import { S, EDITS } from './state.js';
import { invalidEdits } from './validate.js';
import { renderAll } from './config.js';

/* config.js raises this whenever a field changes; it does not import this
   module, so the dependency runs one way only. */
document.addEventListener('edits-changed', () => refreshSaveBar());

function refreshSaveBar() {
  const bar = $('#savebar');
  const n = EDITS.size;
  bar.hidden = n === 0;
  $('#savecount').textContent = n === 1 ? '1 change' : n + ' changes';
  /* Disabled rather than failing on click: the field is already marked, and a
     Save button that does nothing is worse than one that says it cannot. */
  const bad = invalidEdits();
  $('#save').disabled = bad.length > 0;
  $('#save').title = bad.length
    ? bad.map(([k, w]) => `${k}: ${w}`).join('\n') : '';
  const identity = [...EDITS.keys()].filter(
    (k) => (S.SCHEMA.find((r) => r.name === k) || {}).writable === 'identity');
  $('#confirmwrap').hidden = identity.length === 0;
  $('#confirmwhat').textContent = identity.join(', ');
}

function encode(pairs) {
  return pairs.map(([k, v]) =>
    encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
}

async function save() {
  const out = $('#saveout');
  out.textContent = '';
  const pairs = [...EDITS.entries()];
  if (!pairs.length) return;

  if (!$('#confirmwrap').hidden && !$('#confirm').checked) {
    out.append(el('div', 'bad', 'Identity keys need the confirmation ticked.'));
    return;
  }

  /* The red marking on a field used to be the only consequence of an invalid
     value: save() never consulted it and POSTed anyway. The daemon rejects
     these too, but saying so here means the whole batch is not sent to find
     out. */
  const bad = invalidEdits();
  if (bad.length) {
    for (const [name, why] of bad) {
      out.append(el('div', 'bad', `${name}: ${why}`));
    }
    return;
  }
  if ($('#confirm').checked) pairs.push(['_confirm', 'identity']);

  $('#save').disabled = true;
  try {
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: encode(pairs),
    });
    if (r.status === 401) { location.href = '/'; return; }
    const res = await r.json();

    for (const item of res.results || []) {
      const line = el('div', item.ok ? 'good' : 'bad');
      line.textContent = item.ok
        ? `${item.name} = ${item.value}`
        : `${item.name}: ${item.error}`;
      out.append(line);
      if (item.ok) EDITS.delete(item.name);
    }

    /* Nothing is applied implicitly: a write on this device does nothing until
       omci_app restarts or the stick reboots, so say which and let the user
       choose. */
    if (res.apply === 'restart:omci') {
      const b = el('button', 'apply', 'Apply now (restarts OMCI, ~6s, no reboot)');
      b.onclick = doApply;
      out.append(b);
    } else if (res.apply === 'reboot') {
      /* Two different statements, and the daemon now distinguishes them: a key
         known to be read only at boot, versus a key nothing in the image was
         seen reading at all. 159 of the 184 are the second kind, so collapsing
         them into one sentence made the confident case sound like a guess. */
      out.append(el('div', 'warn', res.untraced
        ? 'Nothing in the image was seen reading these keys, so assume a ' +
          'reboot is needed. Nothing here reboots the stick for you.'
        : 'These keys are read at boot, so a reboot is needed for them to ' +
          'take effect. Nothing here reboots the stick for you.'));
    }

    S.VALUES = await get('/api/values');
    renderAll();
  } catch (e) {
    out.append(el('div', 'bad', String(e.message || e)));
  } finally {
    $('#save').disabled = false;
    refreshSaveBar();
  }
}

async function doApply(ev) {
  const out = $('#saveout');
  ev.target.disabled = true;
  ev.target.textContent = 'Restarting OMCI…';
  try {
    const r = await fetch('/api/apply', { method: 'POST' });
    const res = await r.json();
    out.append(el('div', res.applied ? 'good' : 'bad',
      res.applied ? 'Applied — omci_app restarted and the ONU is re-registering.'
                  : 'Apply failed: ' + (res.error || 'unknown')));
  } catch (e) {
    out.append(el('div', 'bad', String(e.message || e)));
  } finally {
    ev.target.remove();
    await refresh();
  }
}

export { refreshSaveBar, save, doApply };
