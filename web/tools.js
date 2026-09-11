/*
 * The two diagnostics that need a device rather than a config file: what the
 * kernel has been complaining about, and whether this stick can reach anything.
 */

import { $, el, get } from './dom.js';

/*
 * Kernel messages carry a priority in angle brackets -- <4> is a warning, <3>
 * an error. Worth colouring rather than stripping: the interesting lines on
 * this device are exactly the ones that carry one, and the RT_ERR_ switch
 * errors arrive as bare continuation lines under a <4> header, which is why a
 * line with no prefix inherits the last one seen.
 */
function renderLogLines(text, host) {
  let level = null;

  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;

    const m = /^<(\d)>(.*)$/.exec(line);
    let body = line;
    if (m) { level = Number(m[1]); body = m[2]; }
    /* A bare `<4>` with nothing after it is real -- the kernel emits them --
       and rendering it as an empty row is noise. Take the level from it and
       drop the row. */
    if (!body.trim()) continue;

    const cls = level === null ? '' : level <= 3 ? 'bad' : level === 4 ? 'warn' : '';
    host.append(el('div', 'logline ' + cls, body));
  }
}

async function renderLog() {
  const host = $('#log-out');

  host.textContent = 'Reading…';
  let d;
  try { d = await get('/api/log'); } catch (e) { host.textContent = String(e.message || e); return; }
  host.textContent = '';

  if (d.error) { host.append(el('p', 'me-note bad', d.error)); return; }
  if (!String(d.raw || '').trim()) {
    host.append(el('p', 'hint', 'The ring buffer is empty.'));
    return;
  }
  if (d.truncated)
    host.append(el('p', 'me-note bad', 'Only the newest part of the buffer fits '
      + 'here; the oldest lines were dropped.'));

  const box = el('div', 'log');
  renderLogLines(d.raw, box);
  host.append(box);
  /* Newest last, like a terminal. Scroll there so a refresh lands on what just
     happened rather than on what happened at boot. */
  box.scrollTop = box.scrollHeight;
}

async function runPing() {
  const out = $('#ping-out');
  const btn = $('#ping-go');
  const host = $('#ping-host').value.trim();

  out.textContent = '';
  if (!host) return;
  btn.disabled = true;
  out.append(el('div', null, `Pinging ${host}…`));
  try {
    const r = await fetch('/api/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ host }).toString(),
    });
    const j = await r.json();
    if (j.output) out.append(el('pre', null, j.output.trim()));
    /* An error from the daemon and a silent host are different findings: one
       sends you to the image, the other to the network. */
    if (j.error) out.append(el('div', 'bad', j.error));
    else if (!j.ok) out.append(el('div', 'bad', 'No reply.'));
  } catch (e) {
    out.append(el('div', 'bad', String(e.message || e)));
  } finally {
    btn.disabled = false;
  }
}

let wired = false;

function renderTools() {
  if (!wired) {
    wired = true;
    $('#log-reload').onclick = renderLog;
    $('#ping-go').onclick = runPing;
    $('#ping-host').onkeydown = (e) => { if (e.key === 'Enter') runPing(); };
  }
  renderLog();
}

export { renderLogLines, renderTools };
