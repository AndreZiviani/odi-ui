/*
 * The host port: auto-negotiation with the router on the SFP edge
 * (odi-oss HOST_AUTONEG), and the banner that says when the image changed it
 * by itself.
 *
 * A wrong mode takes down the only way into the stick, so the page never
 * stores the key. "Try" asks host-autoneg.sh for a trial: the image applies
 * the mode a second later, in RAM, and reverts it by itself at the end of the
 * window unless "Keep" (confirm) arrives first. Keep can only arrive over the
 * link being tried, which is the point: a mode that breaks the link cannot
 * be kept. The dialog counts the window down and polls the stick; a poll
 * that fails says the link may be down in this mode, and that the stick
 * reverts by itself.
 *
 * The banner covers the states in which the image changed what runs by
 * itself, so none goes unseen:
 *   - the boot fallback: HOST_AUTONEG is off, this boot found no host link
 *     forced and the link came up only with auto-negotiation. It clears by
 *     itself at the next boot that brings the forced link up;
 *   - a safe-mode boot (odi-oss safe-mode.sh): a run of short power-ups made
 *     this boot a recovery boot, with the PON off, the host port on
 *     auto-negotiation and the default password, for this boot only;
 *   - a safe-mode record: a safe-mode boot happened and nobody acknowledged
 *     it yet. It stays until acknowledged, from the banner.
 */

import { $, el, get } from './dom.js';

const POLL_MS = 3000;
let H = null;          /* the last /api/hostlink answer */
let tick = 0;          /* the countdown interval, while a trial dialog is up */
let polling = false;

const modeText = (m) => (m === 'off' ? 'off (forced 1000BASE-X full duplex)' : 'on');

/*
 * What the bars say for a /api/hostlink answer:
 *   { show, safe, fallback, ack }
 * safe is the text of the safe-mode bar (or null), fallback that of the boot
 * fallback bar (or null), ack whether the safe bar offers Acknowledge. One
 * short line each: the long explanation is under System, Access. Pure, so
 * make check can drive it with fixtures.
 */
function bannerText(h) {
  const out = { show: false, safe: null, fallback: null, ack: false };
  if (!h) return out;
  const st = h.state || {};
  const now = h.safemode_now;
  const rec = h.safemode;
  const cleared = (s) => (s && s.cleared === 'HOST_AUTONEG' ? ' It also cleared the host port setting.' : '');
  if (now) {
    out.safe = 'Safe mode. A recovery boot: the fibre (PON) is off and the default passwords work for this boot only.'
      + cleared(now) + (rec ? '' : ' Acknowledged: the next boot is a normal boot.');
    out.ack = !!rec;
  } else if (rec) {
    const n = rec.short_boots || 'several';
    const build = rec.build ? `build ${rec.build}, ` : '';
    out.safe = `A safe-mode boot happened (${build}after ${n} short power cycles).` + cleared(rec);
    out.ack = true;
  }
  if (h.supported && st.fallback === '1' && st.setting === 'off' && st.running === 'on') {
    out.fallback = 'Host link fallback. The host port is set to auto-negotiation off, but this boot the link '
      + 'did not come up that way, so the stick runs auto-negotiation on to stay reachable. The setting is kept.';
  }
  out.show = !!(out.safe || out.fallback);
  return out;
}

function renderBanner() {
  const b = bannerText(H);
  const bar = (id, textId, text) => {
    $(id).hidden = !text;
    const p = $(textId);
    p.textContent = '';
    if (!text) return;
    const i = text.indexOf('. ');
    const head = /^(Safe mode|Host link fallback)\./.test(text) ? text.slice(0, i + 1) : '';
    if (head) { p.append(el('strong', null, head), document.createTextNode(' ' + text.slice(i + 2))); } else p.append(document.createTextNode(text));
  };
  bar('#safebanner', '#safe-text', b.safe);
  bar('#fallbackbanner', '#fallback-text', b.fallback);
  $('#hostlink-ack').hidden = !b.ack;
}

/* Seconds left in the trial, from the stick's own clock: the deadline and the
   uptime come from the same /proc/uptime. */
function trialLeft(h) {
  const st = (h && h.state) || {};
  const d = Number(st.trial_deadline), u = Number(h && h.uptime);
  if (st.phase !== 'trial' || !Number.isFinite(d) || !Number.isFinite(u)) return null;
  return Math.max(0, d - u);
}

function renderBlock() {
  const box = $('#hostlink');
  if (!H || !H.supported) { box.hidden = true; return; }
  box.hidden = false;
  const st = H.state || {};
  const link = H.link === '1' ? 'up' : H.link === '0' ? 'down' : 'unknown';
  const now = $('#hostlink-now');
  now.textContent = '';
  const row = (k, v, cls) => {
    const r = el('div', 'setting');
    const ctl = el('div', 's-control');
    ctl.append(el('span', 's-ro' + (cls ? ' ' + cls : ''), v));
    r.append(el('div', 's-label', k), ctl);
    now.append(r);
  };
  row('Auto-negotiation now', modeText(st.running || 'on'));
  row('Stored setting', modeText(st.setting || 'on'));
  row('Host link', link, link === 'up' ? 'good' : link === 'down' ? 'bad' : '');
  if (st.phase === 'watch') row('Boot check', 'Still deciding the mode; try again in a minute.', 'warn');
  if (st.message) row('Last event', st.message);
  const busy = st.phase === 'trial' || st.phase === 'watch';
  const other = (st.running || 'on') === 'off' ? 'on' : 'off';
  const btn = $('#hostlink-try');
  btn.textContent = other === 'off' ? 'Try auto-negotiation off' : 'Try auto-negotiation on';
  btn.dataset.mode = other;
  btn.disabled = busy;
  /* The fallback runs on while the setting says off: offer to keep on. */
  const keepOn = $('#hostlink-keep-on');
  keepOn.hidden = !(st.setting === 'off' && st.running === 'on' && !busy);
  if (st.phase === 'trial' && !tick) openDialog();
}

async function refresh() {
  try { H = await get('/api/hostlink'); } catch (e) { H = null; }
  renderBanner();
  renderBlock();
  return H;
}

async function post(body) {
  const r = await fetch('/api/hostlink', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return r.json();
}

function say(where, cls, text) {
  const out = $(where);
  out.textContent = '';
  if (text) out.append(el('div', cls, text));
}

async function tryMode(mode) {
  const warn = mode === 'off'
    ? 'Turn host port auto-negotiation off?\n\nIf the router port still negotiates, the link drops and this page '
      + 'stops answering. Nothing is stored until you keep it: the stick goes back by itself after two minutes.'
    : 'Turn host port auto-negotiation back on?\n\nIf the router port has it off, the link drops and this page '
      + 'stops answering. Nothing is stored until you keep it: the stick goes back by itself after two minutes.';
  if (!confirm(warn)) return;
  say('#hostlink-out', null, '');
  try {
    const res = await post('action=try&mode=' + encodeURIComponent(mode));
    if (!res.ok) { say('#hostlink-out', 'bad', res.error || res.output || 'not started'); return; }
  } catch (e) { say('#hostlink-out', 'bad', String(e.message || e)); return; }
  await refresh();
  openDialog();
}

/* The keep-or-revert dialog. A <dialog> where the browser has one, shown
   modal so nothing else is clicked meanwhile. */
function openDialog() {
  const d = $('#hostlink-dialog');
  if (typeof d.showModal === 'function' && !d.open) d.showModal(); else d.hidden = false;
  say('#hostlink-dialog-out', null, '');
  let left = trialLeft(H);
  const count = $('#hostlink-count');
  const paint = () => { count.textContent = left === null ? '' : `Reverting in ${left} s.`; };
  paint();
  let since = 0;
  clearInterval(tick);
  tick = setInterval(async () => {
    if (left !== null && left > 0) left -= 1;
    paint();
    since += 1000;
    if (since < POLL_MS || polling) return;
    since = 0;
    polling = true;
    try {
      const h = await get('/api/hostlink');
      H = h;
      const l = trialLeft(h);
      if (l === null) { closeDialog(h); return; }
      left = l;
      say('#hostlink-dialog-out', null, h.link === '1' ? 'The stick answers and reports a host link.' : '');
    } catch (e) {
      say('#hostlink-dialog-out', 'bad', 'No answer from the stick: the link may be down in this mode. '
        + 'It goes back by itself when the countdown ends; this page reconnects then.');
    } finally { polling = false; }
  }, 1000);
}

function closeDialog(h) {
  clearInterval(tick);
  tick = 0;
  const d = $('#hostlink-dialog');
  if (typeof d.close === 'function' && d.open) d.close(); else d.hidden = true;
  const st = (h && h.state) || {};
  const what = {
    trial_confirmed: `Kept: auto-negotiation ${modeText(st.setting)} is stored.`,
    trial_expired: `Not kept in time: back to auto-negotiation ${modeText(st.running)}. Nothing was stored.`,
    trial_reverted: `Reverted: back to auto-negotiation ${modeText(st.running)}. Nothing was stored.`,
  }[st.event];
  say('#hostlink-out', st.event === 'trial_confirmed' ? null : 'warn', what || st.message || '');
  renderBanner();
  renderBlock();
}

async function finish(action) {
  say('#hostlink-dialog-out', null, '');
  try {
    const res = await post('action=' + action);
    if (!res.ok) { say('#hostlink-dialog-out', 'bad', res.error || res.output || action + ' failed'); return; }
  } catch (e) { say('#hostlink-dialog-out', 'bad', String(e.message || e)); return; }
  closeDialog(await refresh());
}

async function ack() {
  try {
    const res = await post('action=ack');
    if (!res.ok) { say('#hostlink-out', 'bad', res.error || res.output || 'not acknowledged'); return; }
  } catch (e) { return; }
  await refresh();
}

function wireHostlink() {
  $('#hostlink-try').onclick = () => tryMode($('#hostlink-try').dataset.mode || 'off');
  $('#hostlink-keep-on').onclick = () => tryMode('on');
  $('#hostlink-keep').onclick = () => finish('confirm');
  $('#hostlink-revert').onclick = () => finish('revert');
  $('#hostlink-ack').onclick = ack;
  /* Details: the bar links to System, Access; open the explanation there. */
  $('#safe-details').onclick = () => {
    $('#safemode-help').open = true;
    setTimeout(() => $('#safemode-help').scrollIntoView({ block: 'center' }), 0);
  };
}

export { bannerText, trialLeft, refresh as renderHostlink, wireHostlink };
