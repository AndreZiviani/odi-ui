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
let NA = null;          /* the last /api/netaddr answer */
let tick = 0;           /* the countdown interval, while the dialog is up */
let polling = false;

/* Whether an address change goes through the trial on this image. */
const netaddrActive = () => !!(NA && NA.supported);
const isNetKey = (k) => NET_KEYS.includes(k);

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
function dialogView(h) {
  const fresh = freshAddrs(h);
  const via = (h && h.via) || '';
  if (!fresh.length) {
    return {
      text: 'Only the netmask changes. Keep it from a computer on the new netmask: the stick checks '
        + 'where the request came from. If it cannot be kept, the stick goes back by itself.',
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
      + 'meanwhile. To keep the change open the new address and press Keep there. If it does not '
      + 'answer, do nothing: the stick goes back by itself. Revert works from here.',
    link: `http://${fresh[0]}/`, canKeep: false,
  };
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
      const next = dialogView(NA).link;
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
  const d = $('#netaddr-dialog');
  if (typeof d.close === 'function' && d.open) d.close(); else d.hidden = true;
  const st = (h && h.state) || {};
  const to = st.new_LAN_IP_ADDR || '';
  const what = {
    trial_confirmed: `Kept: the management address is stored. The stick answers at http://${to}/ now.`,
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
      const a = el('a', 'fwbtn', `Continue on http://${to}/`);
      a.href = `http://${to}/`;
      link.append(a);
    }
  }
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
  refresh as renderNetaddr, startTrial, wireNetaddr,
};
