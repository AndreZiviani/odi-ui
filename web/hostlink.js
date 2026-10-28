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
 * The SerDes mode of the same port (odi-oss HOST_SERDES) is the second control
 * here, and works the same way through host-serdes.sh: Fiber 1G (the default),
 * 2.5G or HiSGMII, a trial the image reverts by itself, a dialog that counts
 * it down. While the mode is not Fiber 1G the image refuses an auto-negotiation
 * trial, and the control says so. The link comes from the script's `status`
 * (which says where it was read from: only the port link in Fiber 1G, the
 * SerDes sync in 2.5G, nothing in HiSGMII), asked for after the page is up so
 * the banner stays a no-fork read.
 *
 * The banner covers the states in which the image changed what runs by
 * itself, so none goes unseen:
 *   - the boot fallback: HOST_AUTONEG is off, this boot found no host link
 *     forced and the link came up only with auto-negotiation. It clears by
 *     itself at the next boot that brings the forced link up;
 *   - the SerDes boot fallback: HOST_SERDES is 2.5G, this boot saw no link in
 *     it and runs Fiber 1G to stay reachable; the setting is kept;
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
let SS = null;         /* the last host-serdes.sh status answer, key by key */
let ssBusy = false;
let kind = 'autoneg';  /* which trial the dialog is about: autoneg or serdes */

const modeText = (m) => (m === 'off' ? 'off (forced 1000BASE-X full duplex)' : 'on');

/* The SerDes modes, as the image names them in the key and as the page says them. */
const SERDES = {
  fiber1g: 'Fiber 1G (1000BASE-X, default, most compatible)',
  '2500basex': '2.5G (2500BASE-X)',
  hisgmii: 'HiSGMII',
};
const serdesText = (m) => SERDES[m] || (m ? String(m) : 'unknown');
const serdesShort = (m) => (m === 'fiber1g' ? 'Fiber 1G' : m === '2500basex' ? '2.5G' : m === 'hisgmii' ? 'HiSGMII' : m);
const sdState = (h) => (h && h.serdes && h.serdes.state) || {};
const sdOn = (h) => !!(h && h.serdes && h.serdes.supported);
/* Where the image read the host link from, in words. */
const SOURCE = {
  host_link: 'the port link',
  serdes_sync: 'the SerDes sync',
  none: 'no signal in this mode',
};

/* Which trial is running, if any: the SerDes one first (the image allows one
   at a time, so there is never both). { kind, st } or null. */
function trialOf(h) {
  if (sdState(h).phase === 'trial') return { kind: 'serdes', st: sdState(h) };
  const st = (h && h.state) || {};
  return st.phase === 'trial' ? { kind: 'autoneg', st } : null;
}

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
  /* cleared is a list: HOST_AUTONEG, HOST_SERDES, both with a comma, none or failed. */
  const cleared = (s) => {
    const l = String((s && s.cleared) || '').split(',');
    const an = l.includes('HOST_AUTONEG'), sd = l.includes('HOST_SERDES');
    if (an && sd) return ' It also cleared the host port settings (auto-negotiation and SerDes mode).';
    if (sd) return ' It also cleared the host port SerDes mode.';
    return an ? ' It also cleared the host port setting.' : '';
  };
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
  const ss = sdState(h);
  if (sdOn(h) && ss.fallback === '1' && ss.setting && ss.setting !== 'fiber1g' && ss.running === 'fiber1g') {
    out.fallback = `Host mode fallback. The host port is set to ${serdesShort(ss.setting)}, but this boot saw no `
      + 'link in it, so the stick runs Fiber 1G to stay reachable. The setting is kept.';
  } else if (h.supported && st.fallback === '1' && st.setting === 'off' && st.running === 'on') {
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
    const head = /^(Safe mode|Host link fallback|Host mode fallback)\./.test(text) ? text.slice(0, i + 1) : '';
    if (head) { p.append(el('strong', null, head), document.createTextNode(' ' + text.slice(i + 2))); } else p.append(document.createTextNode(text));
  };
  bar('#safebanner', '#safe-text', b.safe);
  bar('#fallbackbanner', '#fallback-text', b.fallback);
  $('#hostlink-ack').hidden = !b.ack;
}

/* Seconds left in the trial, from the stick's own clock: the deadline and the
   uptime come from the same /proc/uptime. */
function trialLeft(h) {
  const t = trialOf(h);
  const d = Number(t && t.st.trial_deadline), u = Number(h && h.uptime);
  if (!t || !Number.isFinite(d) || !Number.isFinite(u)) return null;
  return Math.max(0, d - u);
}

function renderBlock() {
  const box = $('#hostlink');
  if (!H || !(H.supported || sdOn(H))) { box.hidden = true; return; }
  box.hidden = false;
  const st = H.state || {};
  const ss = sdState(H);
  const sd = sdOn(H);
  /* In 2.5G and HiSGMII the port is forced and the image refuses an auto-negotiation trial. */
  const forced = sd && !!ss.running && ss.running !== 'fiber1g' && ss.running !== 'unknown';
  const now = $('#hostlink-now');
  now.textContent = '';
  const row = (k, v, cls) => {
    const r = el('div', 'setting');
    const ctl = el('div', 's-control');
    ctl.append(el('span', 's-ro' + (cls ? ' ' + cls : ''), v));
    r.append(el('div', 's-label', k), ctl);
    now.append(r);
  };
  /* The link as the image reports it: from the script's status when it came,
     else the port link the GET carries (which only means something in Fiber 1G). */
  const l = SS && SS.link ? SS.link : H.link === '1' ? '1' : H.link === '0' ? '0' : 'unknown';
  const link = l === '1' ? 'up' : l === '0' ? 'down' : 'unknown';
  const src = SS && SS.link_source && SOURCE[SS.link_source] ? ` (from ${SOURCE[SS.link_source]})` : '';
  if (H.supported) {
    row('Auto-negotiation now', forced ? 'not applicable in ' + serdesShort(ss.running) : modeText(st.running || 'on'));
    row('Stored setting', modeText(st.setting || 'on'));
  }
  if (sd) {
    row('SerDes mode now', serdesText(ss.running || 'fiber1g'));
    row('Stored SerDes mode', serdesText(ss.setting || 'fiber1g'));
  }
  row('Host link', link + src, link === 'up' ? 'good' : link === 'down' ? 'bad' : '');
  if (st.phase === 'watch') row('Boot check', 'Still deciding the mode; try again in a minute.', 'warn');
  if (ss.phase === 'watch') row('SerDes boot check', 'Still deciding the mode; try again in a minute.', 'warn');
  if (st.message) row('Last event', st.message);
  if (ss.message) row('Last SerDes event', ss.message);
  const busy = st.phase === 'trial' || st.phase === 'watch' || ss.phase === 'trial' || ss.phase === 'watch'
    || ss.phase === 'reapply';
  const other = (st.running || 'on') === 'off' ? 'on' : 'off';
  const btn = $('#hostlink-try');
  btn.textContent = other === 'off' ? 'Try auto-negotiation off' : 'Try auto-negotiation on';
  btn.dataset.mode = other;
  btn.disabled = busy || forced;
  $('#hostlink-an').hidden = !H.supported;
  $('#hostlink-an-na').hidden = !forced;
  /* The fallback runs on while the setting says off: offer to keep on. */
  const keepOn = $('#hostlink-keep-on');
  keepOn.hidden = !(st.setting === 'off' && st.running === 'on' && !busy && !forced);
  $('#hostlink-sd').hidden = !sd;
  const pick = $('#hostlink-sd-mode');
  if (sd && !pick.options.length) {
    for (const m of Object.keys(SERDES)) {
      const o = el('option', null, SERDES[m]);
      o.value = m;
      pick.append(o);
    }
  }
  if (sd && !pick.dataset.set) { pick.value = SERDES[ss.setting] ? ss.setting : 'fiber1g'; pick.dataset.set = '1'; }
  pick.disabled = busy;
  $('#hostlink-sd-try').disabled = busy;
  if (trialOf(H) && !tick) openDialog();
}

/* The status verb of host-serdes.sh: the link and where it was read from. It
   forks (diag in 2.5G), so it runs after the page is up and the answer repaints. */
async function loadSerdesStatus() {
  if (!sdOn(H) || ssBusy) return;
  ssBusy = true;
  try {
    const r = await post('action=serdes-status');
    SS = r && r.ok && r.status ? r.status : null;
  } catch (e) { SS = null; } finally { ssBusy = false; }
  renderBlock();
}

async function refresh() {
  try { H = await get('/api/hostlink'); } catch (e) { H = null; }
  renderBanner();
  renderBlock();
  loadSerdesStatus();
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

async function trySerdes() {
  const mode = $('#hostlink-sd-mode').value;
  if (!SERDES[mode]) return;
  if (!confirm(`Try ${serdesShort(mode)} on the host port?\n\nIf the router port does not run this mode, the link `
    + 'drops and this page stops answering. Nothing is stored until you keep it: the stick goes back by itself '
    + 'after two minutes (120 s).')) return;
  say('#hostlink-sd-out', null, '');
  try {
    const res = await post('action=serdes-try&mode=' + encodeURIComponent(mode));
    if (!res.ok) { say('#hostlink-sd-out', 'bad', res.error || res.output || 'not started'); return; }
  } catch (e) { say('#hostlink-sd-out', 'bad', String(e.message || e)); return; }
  await refresh();
  openDialog();
}

/* The keep-or-revert dialog. A <dialog> where the browser has one, shown
   modal so nothing else is clicked meanwhile. */
function openDialog() {
  const d = $('#hostlink-dialog');
  const t = trialOf(H);
  if (t) kind = t.kind;
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
  const sd = kind === 'serdes';
  const s2 = sd ? sdState(h) : st;
  const name = (m) => (sd ? serdesShort(m) : `auto-negotiation ${modeText(m)}`);
  const what = {
    trial_confirmed: `Kept: ${name(s2.setting)} is stored.`,
    trial_expired: `Not kept in time: back to ${name(s2.running)}. Nothing was stored.`,
    trial_reverted: `Reverted: back to ${name(s2.running)}. Nothing was stored.`,
    trial_failed: `Not applied: back to ${name(s2.running)}. Nothing was stored.`,
  }[s2.event];
  say(sd ? '#hostlink-sd-out' : '#hostlink-out', s2.event === 'trial_confirmed' ? null : 'warn', what || s2.message || '');
  renderBanner();
  renderBlock();
}

async function finish(action) {
  say('#hostlink-dialog-out', null, '');
  try {
    const res = await post('action=' + (kind === 'serdes' ? 'serdes-' : '') + action);
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
  $('#hostlink-sd-try').onclick = trySerdes;
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
