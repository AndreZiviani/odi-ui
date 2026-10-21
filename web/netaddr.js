/*
 * The management address as a trial (odi-oss mgmt-addr.sh).
 *
 * A wrong address takes every way in with it, so Save never stores the five
 * keys while the image has the script: it asks for a trial. The stick applies
 * the new address a second later, in RAM, keeps the old one up beside it, and
 * goes back by itself after 90 s unless "Keep" arrives. Keep has to arrive
 * over a NEW address, which is the proof that it works, so the dialog on a page
 * opened on the old address says where to go instead of offering a button that
 * would be refused. Only a kept trial reaches the config store, so a reboot
 * during it comes up on the old address.
 *
 * Moving there is automatic. The page opened on the old address probes the new
 * one (probeAddr) until it answers and then navigates to it, keeping the scheme
 * and port it was loaded with. There is no session to carry over: confd checks an
 * HTTP Basic credential on every request, which the browser keeps per address,
 * so the new address asks for the same password once (docs/DESIGN.md, "Moving
 * the management address"). The trial's countdown is on the page that opens.
 *
 * The dialog is modal and global (any tab, and any page load while a trial
 * runs), counts the window down from the stick own clock and polls it. The
 * script is the authority on whether a Keep is accepted; the page only avoids
 * offering one it knows will be refused.
 */

import { $, el, get } from './dom.js';
import { S } from './state.js';
import { renderAll } from './config.js';

const NET_KEYS = ['LAN_IP_ADDR', 'LAN_SUBNET', 'LAN_ENABLE_IP2', 'LAN_IP_ADDR2', 'LAN_SUBNET2'];
const POLL_MS = 3000;
const PROBE_MS = 2000;        /* between rounds of looking for the new address */
const PROBE_TIMEOUT_MS = 2500; /* one probe: a dead address must not hold the round */
const STUCK_MS = 8000;        /* after this long without an answer, say so */
const FOLLOWED = 'odi-netaddr-followed';
let NA = null;          /* the last /api/netaddr answer */
let tick = 0;           /* the countdown interval, while the dialog is up */
let polling = false;
let dialogOpen = false;
let following = 0;     /* the id of the running follow loop, 0 when none */

/* Whether an address change goes through the trial on this image. */
const netaddrActive = () => !!(NA && NA.supported);
const isNetKey = (k) => NET_KEYS.includes(k);

/*
 * The page address of `addr`, with the scheme and port this page was loaded
 * with: a stick behind a TLS front end stays on https, and a port in the URL
 * is kept. Pure.
 */
function originOf(addr, loc) {
  const l = loc || globalThis.location || {};
  return `${l.protocol || 'http:'}//${addr}${l.port ? ':' + l.port : ''}/`;
}

/*
 * Whether `url` answers, from this page, without a CORS grant: a no-cors fetch
 * resolves, with an opaque response, for ANY HTTP answer (confd answers a
 * cross-site fetch with 403 before it looks at the credential, and says
 * nothing else), and rejects when nothing answers: no route, a refused
 * connection, a timeout, or a certificate that does not fit the address. The
 * page learns "something speaks HTTP there" and nothing more. `credentials`
 * is omitted so no password goes with it.
 */
async function probeAddr(url, fetchFn, timeoutMs) {
  const f = fetchFn || globalThis.fetch;
  const ms = timeoutMs || PROBE_TIMEOUT_MS;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), ms) : 0;
  try {
    await f(url + '?probe=' + Date.now(), {
      mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: ctl ? ctl.signal : undefined,
    });
    return true;
  } catch (e) {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* The first of `urls`, in order, that answers, all probed at once; or null. */
async function firstAnswering(urls, probeFn) {
  const probe = probeFn || probeAddr;
  const got = await Promise.all(urls.map((u) => probe(u)));
  const i = got.indexOf(true);
  return i < 0 ? null : urls[i];
}

/*
 * Where this page should send the browser during a trial: the pages of the
 * addresses the trial added, in the order the script lists them (primary
 * first), or nothing when this page is already on one of them or nothing
 * is new (a netmask-only change). Pure.
 */
function redirectTargets(h, loc) {
  const fresh = freshAddrs(h);
  const via = (h && h.via) || '';
  if (!fresh.length || fresh.includes(via)) return [];
  return fresh.map((a) => originOf(a, loc));
}

/* One redirect per trial per tab: coming back with Back must not bounce again. */
const followedKey = (h) => `${((h && h.state) || {}).trial_deadline || ''}`;
function wasFollowed(h) {
  try { return globalThis.sessionStorage.getItem(FOLLOWED) === followedKey(h); } catch (e) { return false; }
}
function markFollowed(h) {
  try { globalThis.sessionStorage.setItem(FOLLOWED, followedKey(h)); } catch (e) { /* the loop guard is enough */ }
}

/*
 * Look for `targets` until one answers, then hand it to `go`. `status(kind, x)`
 * reports 'looking', 'stuck' (no answer for STUCK_MS) and 'found'; `alive()` is
 * asked before every round and ends the loop when false. Time and the network
 * are parameters so a test drives it without waiting.
 */
async function followLoop(targets, { status, alive, go, probe, sleep }) {
  const nap = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let waited = 0;
  status('looking', targets);
  while (alive()) {
    const hit = await firstAnswering(targets, probe);
    if (!alive()) return null;
    if (hit) { status('found', hit); go(hit); return hit; }
    waited += PROBE_MS;
    if (waited >= STUCK_MS) status('stuck', targets);
    await nap(PROBE_MS);
  }
  return null;
}

/* Seconds left in the trial, from the stick own clock: the deadline and the
   uptime come from the same /proc/uptime. */
function trialLeft(h) {
  const st = (h && h.state) || {};
  const d = Number(st.trial_deadline), u = Number(h && h.uptime);
  if (st.phase !== 'trial' || !Number.isFinite(d) || !Number.isFinite(u)) return null;
  return Math.max(0, d - u);
}

/*
 * The addresses the trial added, which the script accepts a Keep on: the new
 * primary and second address that the stick did not already answer on (the
 * address it ran before, or its second address). Empty when only the netmask
 * moved or the second address went away. Pure, as the script rule is.
 */
function freshAddrs(h) {
  const st = (h && h.state) || {};
  const out = [];
  const oldSecond = st.old_LAN_ENABLE_IP2 === '1' ? st.old_LAN_IP_ADDR2 : '';
  const cand = [st.new_LAN_IP_ADDR || '192.168.1.1',
    st.new_LAN_ENABLE_IP2 === '1' ? st.new_LAN_IP_ADDR2 : ''];
  for (const a of cand) {
    if (a && a !== st.prev_ip && a !== oldSecond && !out.includes(a)) out.push(a);
  }
  return out;
}

/*
 * What the dialog says and offers for an answer: { text, link, canKeep }.
 * `via` is the address this page was served on, from the socket.
 */
function dialogView(h, loc) {
  const fresh = freshAddrs(h);
  const via = (h && h.via) || '';
  if (!fresh.length) {
    return {
      text: 'Only the netmask changes, so there is no new address to open and this page stays. Keep '
        + 'it from a computer that is on the new netmask: the stick checks where the request came '
        + 'from, and refuses a Keep from any other. If it is not kept, the stick goes back by itself.',
      link: null, canKeep: true,
    };
  }
  if (fresh.includes(via)) {
    return {
      text: `This page is on the new address (${via}), so it works. Keep stores it; Revert, or no `
        + 'answer, goes back to the address before.',
      link: null, canKeep: true,
    };
  }
  return {
    text: `This page is on ${via || 'the old address'}, which the stick already had, and it stays up `
      + 'meanwhile. It opens the new address by itself as soon as that answers; press Keep there. '
      + 'If it never answers, do nothing: the stick goes back by itself. Revert works from here.',
    link: originOf(fresh[0], loc), canKeep: false,
  };
}

/* What the page does to move the browser; a test replaces it. */
const deps = { navigate: (u) => globalThis.location.assign(u), probe: null, sleep: null };

function stopFollow() { following = 0; }

function followText(kind, x) {
  const list = (Array.isArray(x) ? x : [x]).map((u) => u.replace(/^[a-z]+:\/\//, '').replace(/\/$/, '')).join(' or ');
  if (kind === 'looking') return `Looking for the new address (${list}). This page opens it as soon as it answers.`;
  if (kind === 'stuck') {
    return `${list} does not answer from this computer yet, and this page keeps trying until the countdown ends. `
      + 'If this computer has no route to it, or it is the wrong address, press Revert, or do nothing: the '
      + 'stick goes back by itself and this address keeps working.';
  }
  return `${list} answers. Opening it now: the browser asks for the password again there, because it keeps `
    + 'the password per address. The countdown and Keep are on that page. If you cancel the prompt, go '
    + 'Back to this page.';
}

/*
 * Send the browser to the new address as soon as it answers. Started with the
 * dialog, once per trial per tab (wasFollowed): a page reached by Back from
 * the new address must not bounce again.
 */
function startFollow() {
  const note = $('#netaddr-follow');
  const targets = redirectTargets(NA);
  note.textContent = '';
  if (!targets.length || following) return;
  if (wasFollowed(NA)) {
    note.textContent = 'This page already opened the new address once for this trial and does not '
      + 'do it again. Use the link to open it.';
    return;
  }
  const id = Date.now() || 1;
  const want = followedKey(NA);
  following = id;
  followLoop(targets, {
    alive: () => following === id && dialogOpen && !!NA && NA.state && NA.state.phase === 'trial'
      && followedKey(NA) === want,
    status: (kind, x) => { note.textContent = followText(kind, x); },
    go: (url) => { markFollowed(NA); deps.navigate(url); },
    probe: deps.probe,
    sleep: deps.sleep,
  }).finally(() => { if (following === id) following = 0; });
}

async function refresh() {
  try { NA = await get('/api/netaddr'); } catch (e) { NA = null; }
  if (NA && NA.supported && NA.state && NA.state.phase === 'trial' && !tick) openDialog();
  return NA;
}

async function post(body) {
  const r = await fetch('/api/netaddr', {
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

/*
 * Ask for a trial of these [key, value] pairs. `out` is where the save report
 * goes. True when the trial started: from then on the dialog owns the rest.
 */
async function startTrial(pairs, out) {
  const body = new URLSearchParams([['action', 'try'], ...pairs]);
  let res;
  try {
    res = await post(body.toString());
  } catch (e) {
    out.append(el('div', 'bad', String(e.message || e)));
    return false;
  }
  if (res.output) out.append(el('pre', null, String(res.output).trim()));
  if (!res.ok) {
    out.append(el('div', 'bad', 'Not tried: ' + (res.error || 'see above') + '. Nothing changed.'));
    return false;
  }
  await refresh();
  if (!tick) openDialog();
  return true;
}

/* The keep-or-revert dialog. A <dialog> where the browser has one, shown
   modal so nothing else is clicked meanwhile. */
function openDialog() {
  const d = $('#netaddr-dialog');
  dialogOpen = true;
  if (typeof d.showModal === 'function' && !d.open) d.showModal(); else d.hidden = false;
  say('#netaddr-dialog-out', null, '');
  let left = trialLeft(NA);
  const count = $('#netaddr-count');
  const paint = () => {
    count.textContent = left === null ? '' : `Reverting in ${left} s.`;
    const v = dialogView(NA);
    const text = $('#netaddr-text');
    text.textContent = v.text;
    const link = $('#netaddr-link');
    link.hidden = !v.link;
    if (v.link) { link.href = v.link; link.textContent = v.link; }
    $('#netaddr-keep').disabled = !v.canKeep;
  };
  paint();
  startFollow();
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
      const h = await get('/api/netaddr');
      NA = h;
      const l = trialLeft(h);
      if (l === null) { await closeDialog(h); return; }
      left = l;
      paint();
      say('#netaddr-dialog-out', null, '');
    } catch (e) {
      say('#netaddr-dialog-out', 'bad', 'No answer from this address. If you kept the change on the new '
        + 'address this one is gone: continue there. If you were on the new one and it may be wrong, the '
        + 'stick goes back by itself when the countdown ends, and the old address works again.');
      /* From the old address the way on is the new one; from the new one the
         way back is the address before the trial. */
      const st = (NA && NA.state) || {};
      const next = dialogView(NA).link
        || (st.prev_ip && st.prev_ip !== NA.via ? originOf(st.prev_ip) : '');
      if (next) {
        const a = el('a', 'fwbtn', `Continue on ${next}`);
        a.href = next;
        $('#netaddr-dialog-out').append(a);
      }
    } finally { polling = false; }
  }, 1000);
}

async function closeDialog(h) {
  clearInterval(tick);
  tick = 0;
  dialogOpen = false;
  following = 0;
  $('#netaddr-follow').textContent = '';
  const d = $('#netaddr-dialog');
  if (typeof d.close === 'function' && d.open) d.close(); else d.hidden = true;
  const st = (h && h.state) || {};
  const to = st.new_LAN_IP_ADDR || '';
  const what = {
    trial_confirmed: `Kept: the management address is stored. The stick answers at ${originOf(to)} now.`,
    trial_expired: 'Not kept in time: back to the address before. Nothing was stored.',
    trial_reverted: 'Reverted: back to the address before. Nothing was stored.',
    trial_failed: 'The new address could not be applied: back to the address before. Nothing was stored.',
  }[st.event];
  const box = $('#netaddr-result');
  const link = $('#netaddr-result-link');
  link.textContent = '';
  $('#netaddr-result-text').textContent = what || st.message || '';
  box.className = 'callout banner' + (st.event === 'trial_confirmed' ? '' : ' warn');
  box.hidden = false;
  if (st.event === 'trial_confirmed') {
    try { S.VALUES = await get('/api/values'); renderAll(); } catch (e) { /* the page reloads on the next visit */ }
    if (to && h.via && h.via !== to) {
      const a = el('a', 'fwbtn', `Continue on ${originOf(to)}`);
      a.href = originOf(to);
      link.append(a);
    }
  }
}

/*
 * After a direct save (a safe-mode boot, or an image without the trial): the
 * stick moves at once, so look for the new address and open it. `say` gets the
 * progress text. Gives up after `seconds`.
 */
function followAddresses(addrs, say, seconds) {
  const targets = addrs.map((a) => originOf(a));
  const end = Date.now() + (seconds || 60) * 1000;
  return followLoop(targets, {
    alive: () => Date.now() < end,
    status: (kind, x) => say(followText(kind, x)),
    go: (url) => deps.navigate(url),
    probe: deps.probe,
    sleep: deps.sleep,
  });
}

async function finish(action) {
  say('#netaddr-dialog-out', null, '');
  let res;
  try {
    res = await post('action=' + action);
  } catch (e) { say('#netaddr-dialog-out', 'bad', String(e.message || e)); return; }
  if (!res.ok) { say('#netaddr-dialog-out', 'bad', res.error || res.output || action + ' failed'); return; }
  await closeDialog(await refresh() || NA);
}

function wireNetaddr() {
  $('#netaddr-keep').onclick = () => finish('confirm');
  $('#netaddr-revert').onclick = () => finish('revert');
  $('#netaddr-result-ok').onclick = () => { $('#netaddr-result').hidden = true; };
}

export {
  NET_KEYS, isNetKey, netaddrActive, trialLeft, freshAddrs, dialogView,
  originOf, probeAddr, firstAnswering, redirectTargets, followLoop, followText, wasFollowed, markFollowed,
  deps, stopFollow, followAddresses,
  refresh as renderNetaddr, startTrial, wireNetaddr,
};
