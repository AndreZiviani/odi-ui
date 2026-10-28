/*
 * A notice when a newer odi-oss release exists, with its notes.
 *
 * The check runs in THIS BROWSER, never on the stick: nothing on the stick
 * reaches out, and nothing outside may reach in. The page asks api.github.com
 * for the release list, so GitHub sees the address of the browser that opens
 * the page and nothing else (no credential, no Referer). It is on by default
 * and one switch turns it off for every browser: the file
 * /etc/config/update-check.off on the stick (/api/switch, reported under
 * `switches` by /api/firmware). The page never downloads or flashes anything;
 * the notice points at the Firmware tab.
 *
 * What is asked, and how seldom:
 *   - at most once a day per browser: the answer and its time are kept in
 *     localStorage, and a failed attempt (offline, rate limited, bad answer)
 *     counts as the day's attempt, silently. Storage can be absent or throw;
 *     then the check runs once per page load and nothing is remembered.
 *   - only when the stick runs a release tag (vMAJOR.MINOR.PATCH, optionally
 *     -prerelease): a local build named anything else has nothing to compare.
 *   - drafts are ignored. A pre-release is offered only to a stick that
 *     already runs one; a stable one sees stable releases only.
 *
 * The release notes are text from the internet. They are parsed into a small
 * model (headings, bullet lists, paragraphs, `code`, **bold**, https links)
 * and built with createElement and textContent: nothing from them is ever
 * handed to innerHTML, so markup in a body is shown as text, not run. Pure
 * functions below, so make check can drive them.
 */

import { $, el, createHelpToggle } from './dom.js';
import { S } from './state.js';

const API_URL = 'https://api.github.com/repos/AndreZiviani/odi-oss/releases';
const ALL_URL = 'https://github.com/AndreZiviani/odi-oss/releases';
const PAGE_URL = 'https://github.com/AndreZiviani/odi-oss/releases/tag/';
const CACHE_KEY = 'odi-update-check';
const DISMISS_KEY = 'odi-update-dismissed';
const SWITCH = 'update-check.off';
const DAY_MS = 24 * 3600 * 1000;
const FETCH_MS = 10000;
const KEEP_RELEASES = 30;    /* what the list endpoint returns by default */
const KEEP_BODY = 6000;      /* characters of notes kept per release */
const SHOW_RELEASES = 10;    /* releases listed in the dialog */
const SHOW_BLOCKS = 60;      /* paragraphs, headings and bullets per release */

/* --- versions ------------------------------------------------------------- */

/* vMAJOR.MINOR.PATCH with an optional -prerelease; anything else is not a
   release tag, and null. */
function parseVersion(tag) {
  const m = /^v(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(String(tag || ''));
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

/* Semver precedence: the three numbers, then a version with a prerelease sorts
   BELOW the same numbers without one, then the dot-separated identifiers one
   by one (digits as numbers, and below letters; a shorter list below a longer
   one that starts the same). */
function compareVersions(a, b) {
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === y) continue;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return +x < +y ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return a.pre.length === b.pre.length ? 0 : a.pre.length < b.pre.length ? -1 : 1;
}

/* An https URL on a real host, without a login in it, or null. */
function httpsUrl(s) {
  try {
    const u = new URL(String(s));
    if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null;
    return u.href;
  } catch (e) { return null; }
}

/*
 * What is kept of one release from the API (or from the cache, which is read
 * back through here too): { tag, pre, date, url, body }, or null for a draft
 * or a tag that is not a release tag. The page link is the release's own when
 * it is an https URL on github.com, else built from the tag.
 */
function cleanRelease(r) {
  if (!r || typeof r !== 'object' || r.draft === true) return null;
  const v = parseVersion(r.tag_name !== undefined ? r.tag_name : r.tag);
  if (!v) return null;
  const tag = String(r.tag_name !== undefined ? r.tag_name : r.tag);
  const at = String(r.published_at !== undefined ? r.published_at : r.date || '');
  const own = httpsUrl(r.html_url !== undefined ? r.html_url : r.url);
  return {
    tag,
    pre: r.prerelease === true || v.pre.length > 0,
    date: /^\d{4}-\d{2}-\d{2}/.test(at) ? at.slice(0, 10) : '',
    url: own && /^https:\/\/github\.com\//.test(own) ? own : PAGE_URL + tag,
    body: typeof r.body === 'string' ? r.body.slice(0, KEEP_BODY) : '',
  };
}

function cleanList(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, KEEP_RELEASES).map(cleanRelease).filter(Boolean);
}

/* The releases newer than what runs, newest first. Empty when `running` is
   not a release tag. A pre-release is a candidate only for a stick that runs
   one. */
function newerReleases(list, running) {
  const cur = parseVersion(running);
  if (!cur) return [];
  return cleanList(list)
    .filter((r) => (cur.pre.length || !r.pre) && compareVersions(parseVersion(r.tag), cur) > 0)
    .sort((a, b) => compareVersions(parseVersion(b.tag), parseVersion(a.tag)));
}

/* --- notes: a small, safe subset of markdown ------------------------------ */

/*
 * Inline: `code`, **bold**, [text](https://...) and a bare https URL. Text
 * only, returned as [{ k: 'text'|'code'|'b'|'a', s, href? }]. A link whose
 * target is not an https URL is its text, nothing more.
 */
function parseInline(s) {
  const out = [];
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^()\s]+)\)|(https:\/\/[^\s<>()[\]]+)/g;
  let at = 0, m;
  const text = (t) => { if (t) out.push({ k: 'text', s: t }); };
  while ((m = re.exec(s))) {
    text(s.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1] !== undefined) out.push({ k: 'code', s: m[1] });
    else if (m[2] !== undefined) out.push({ k: 'b', s: m[2] });
    else if (m[3] !== undefined) {
      const href = httpsUrl(m[4]);
      if (href) out.push({ k: 'a', s: m[3], href }); else text(m[3]);
    } else {
      /* A bare URL does not own the full stop that ends the sentence. */
      const url = m[5].replace(/[.,;:!?]+$/, '');
      const href = httpsUrl(url);
      at -= m[5].length - url.length;
      if (href) out.push({ k: 'a', s: url, href }); else text(url);
    }
  }
  text(s.slice(at));
  return out;
}

/*
 * Blocks: { t: 'h', in }, { t: 'ul', items: [in, ...] }, { t: 'p', in }, where
 * `in` is parseInline output. Anything else (HTML, tables, quotes, images,
 * fences) is not interpreted: it falls into a paragraph as the text it is.
 * Capped, with `more` set when it was cut.
 */
function parseNotes(body) {
  const blocks = [];
  let para = [], list = null, more = false, n = 0;   /* n: blocks and bullets so far */
  const flush = () => {
    if (para.length) { blocks.push({ t: 'p', in: parseInline(para.join(' ')) }); n++; }
    para = [];
    list = null;
  };
  for (const raw of String(body || '').replace(/\r/g, '').split('\n')) {
    if (n >= SHOW_BLOCKS) { more = true; para = []; break; }
    const line = raw.trim();
    let m;
    if (!line || /^(```|~~~)/.test(line)) { flush(); continue; }
    if ((m = /^#{1,6}\s+(.*?)\s*#*$/.exec(line))) {
      flush();
      blocks.push({ t: 'h', in: parseInline(m[1]) });
      n++;
    } else if ((m = /^(?:[-*+]|\d{1,3}\.)\s+(.*)$/.exec(line))) {
      if (para.length) flush();
      if (!list) { list = { t: 'ul', items: [] }; blocks.push(list); }
      list.items.push(parseInline(m[1]));
      n++;
    } else {
      list = null;
      para.push(line);
    }
  }
  flush();
  return { blocks, more };
}

function inlineNodes(parts) {
  return parts.map((p) => {
    if (p.k === 'code') return el('code', null, p.s);
    if (p.k === 'b') return el('strong', null, p.s);
    if (p.k === 'a') {
      const a = el('a', null, p.s);
      a.setAttribute('href', p.href);
      a.setAttribute('rel', 'noopener noreferrer');
      a.setAttribute('target', '_blank');
      return a;
    }
    return document.createTextNode(p.s);
  });
}

/* The notes as a <div>, built node by node. */
function notesNode(body) {
  const { blocks, more } = parseNotes(body);
  const box = el('div', 'update-notes');
  for (const b of blocks) {
    if (b.t === 'ul') {
      const ul = el('ul');
      for (const it of b.items) { const li = el('li'); li.append(...inlineNodes(it)); ul.append(li); }
      box.append(ul);
    } else {
      /* A heading is a bold line, not an h-level: the dialog owns those. */
      const p = el('p', b.t === 'h' ? 'update-h' : null);
      p.append(...inlineNodes(b.in));
      box.append(p);
    }
  }
  if (more) box.append(el('p', 'hint', 'The notes continue on the release page.'));
  return box;
}

/* --- the daily check ------------------------------------------------------ */

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* not kept */ } },
};

function readCache() {
  try {
    const c = JSON.parse(store.get(CACHE_KEY));
    if (c && typeof c.t === 'number') return { t: c.t, rel: cleanList(c.rel), full: c.full === true };
  } catch (e) { /* none, or not ours */ }
  return null;
}

async function fetchList(fetchFn) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_MS);
  try {
    const r = await fetchFn(API_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl.signal,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error('not a list');
    return { rel: cleanList(j), full: j.length >= KEEP_RELEASES };
  } finally { clearTimeout(timer); }
}

/*
 * The release list and whether the page that held it was full (so older
 * releases may exist beyond it): the cache while it is under a day old, else a
 * fetch. A failed fetch keeps the old list and stamps the attempt, so nothing
 * is retried before tomorrow. Never throws.
 */
async function loadReleases(now, fetchFn) {
  const c = readCache();
  if (c && now - c.t >= 0 && now - c.t < DAY_MS) return { rel: c.rel, full: c.full };
  let got = c ? { rel: c.rel, full: c.full } : { rel: [], full: false };
  try { got = await fetchList(fetchFn); } catch (e) { /* silent until tomorrow */ }
  store.set(CACHE_KEY, JSON.stringify({ t: now, rel: got.rel, full: got.full }));
  return got;
}

/* Whether releases older than the list may exist that are still newer than
   what runs: the list is a full page and the running version is below even its
   oldest release. */
function olderCut(list, full, running) {
  const cur = parseVersion(running);
  if (!full || !cur || !list.length) return false;
  const oldest = list.map((r) => parseVersion(r.tag)).sort(compareVersions)[0];
  return compareVersions(cur, oldest) < 0;
}

/* The last line of the dialog, or '' when nothing is left out: how many newer
   releases the dialog does not list, or that the fetched page may have cut
   older ones off. */
function olderLine(offerLen, cut) {
  const n = offerLen - SHOW_RELEASES;
  if (cut) return 'Older releases not shown';
  return n > 0 ? `${n} older release${n === 1 ? '' : 's'} not shown` : '';
}

const checkOn = (fw) => !((fw && fw.switches) || {})[SWITCH];

/* What the page should offer now, { offer, cut }: offer is [] when the check
   is off, the running version is not a release tag, or nothing newer exists. */
async function lookup(fw, now, fetchFn) {
  if (!checkOn(fw) || !parseVersion(fw && fw.running)) return { offer: [], cut: false };
  const { rel, full } = await loadReleases(now, fetchFn);
  return { offer: newerReleases(rel, fw.running), cut: olderCut(rel, full, fw.running) };
}

const offered = async (fw, now, fetchFn) => (await lookup(fw, now, fetchFn)).offer;

/* --- the bar, the dialog and the switch ----------------------------------- */

let OFFER = [];
let CUT = false;   /* the fetched page may have cut older releases off */
let started = false;
let dismissedNow = null;   /* the tag dismissed, when storage will not keep it */

const dismissed = () => store.get(DISMISS_KEY) || dismissedNow;

/* Whether the bar shows: something is offered and its newest is not the
   version already dismissed. A newer release than that shows again. */
const barShown = (offer, gone) => offer.length > 0 && offer[0].tag !== gone;

function renderBar() {
  const bar = $('#updatebanner');
  bar.hidden = !barShown(OFFER, dismissed());
  if (bar.hidden) return;
  const p = $('#update-text');
  p.textContent = '';
  p.append(el('strong', null, `odi-oss ${OFFER[0].tag} is available.`),
    document.createTextNode(` This stick runs ${S.FW.running}.`));
}

/* The last line of the dialog as a link to the full list, or null. */
function olderNode(offerLen, cut) {
  const text = olderLine(offerLen, cut);
  if (!text) return null;
  const p = el('p', 'hint');
  const a = el('a', null, text);
  a.setAttribute('href', ALL_URL);
  a.setAttribute('rel', 'noopener noreferrer');
  a.setAttribute('target', '_blank');
  p.append(a);
  return p;
}

function renderDialog() {
  const box = $('#update-list');
  box.textContent = '';
  for (const r of OFFER.slice(0, SHOW_RELEASES)) {
    const sec = el('section', 'update-rel');
    const head = el('h3');
    head.append(el('span', null, r.tag));
    if (r.pre) head.append(el('span', 'tag warn', 'Pre-release'));
    if (r.date) head.append(el('span', 'update-date', r.date));
    const a = el('a', null, 'GitHub release page');
    a.setAttribute('href', r.url);
    a.setAttribute('rel', 'noopener noreferrer');
    a.setAttribute('target', '_blank');
    head.append(a);
    sec.append(head, notesNode(r.body));
    box.append(sec);
  }
  const more = olderNode(OFFER.length, CUT);
  if (more) box.append(more);
}

function openNotes() {
  renderDialog();
  const d = $('#update-dialog');
  if (typeof d.showModal === 'function') d.showModal(); else d.hidden = false;
}

function closeNotes() {
  const d = $('#update-dialog');
  if (typeof d.close === 'function' && d.open) d.close(); else d.hidden = true;
}

function dismiss() {
  if (!OFFER.length) return;
  dismissedNow = OFFER[0].tag;
  store.set(DISMISS_KEY, dismissedNow);
  renderBar();
}

/* Look once per page load, and say nothing when it fails. */
async function checkForUpdate(fetchFn) {
  if (started) return;
  started = true;
  try {
    ({ offer: OFFER, cut: CUT } = await lookup(S.FW, Date.now(), fetchFn || ((u, o) => fetch(u, o))));
  } catch (e) { OFFER = []; CUT = false; }
  renderBar();
}

function wireUpdates() {
  $('#update-notes-open').onclick = openNotes;
  $('#update-dismiss').onclick = dismiss;
  $('#update-close').onclick = closeNotes;
  $('#update-fw-link').onclick = closeNotes;
}

/* System > Firmware: the switch. Its state is a file on the stick, so it is the
   same in every browser. */
function renderUpdateSwitch() {
  const host = $('#update-switch');
  host.textContent = '';
  const on = checkOn(S.FW);
  const titleText = on ? 'Looking for new releases is on' : 'Looking for new releases is off';
  const text = el('div', 'switch-text');
  const helpBox = el('div', 's-helpbox');
  helpBox.id = 'help-update-check';
  helpBox.append(el('p', 's-help', 'When on, this page asks api.github.com for the list of odi-oss releases, '
    + 'at most once a day, and shows a bar when one is newer than the image this stick runs. GitHub sees the '
    + 'address of the browser that opens this page. The stick itself contacts nothing, and nothing is '
    + 'downloaded or flashed by it.'));
  helpBox.append(el('p', 's-help', 'The setting is kept on the stick, so it applies to every browser. '
    + 'It does nothing on an image whose version is not a release name, such as a local build.'));
  const title = el('div', 's-title');
  title.append(el('strong', 's-name', titleText), createHelpToggle(helpBox, titleText));
  text.append(title, helpBox);
  const b = el('button', null, on ? 'Turn off' : 'Turn on');
  b.type = 'button';
  b.onclick = async () => {
    b.disabled = true;
    const out = $('#update-out');
    out.textContent = '';
    try {
      const r = await fetch('/api/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ name: SWITCH, on: on ? '1' : '0' }).toString(),
      });
      const res = await r.json();
      if (!res.ok) { out.append(el('div', 'bad', res.error || 'refused')); return; }
      S.FW.switches = { ...(S.FW.switches || {}), [SWITCH]: res.on };
      if (res.on) { OFFER = []; CUT = false; renderBar(); } else { started = false; checkForUpdate(); }
      renderUpdateSwitch();
    } catch (e) {
      out.append(el('div', 'bad', String(e.message || e)));
    } finally { b.disabled = false; }
  };
  const acts = el('div', 'switch-acts');
  acts.append(b);
  host.append(text, acts);
}

export {
  parseVersion, compareVersions, cleanRelease, newerReleases, parseInline, parseNotes, notesNode,
  loadReleases, lookup, offered, olderCut, olderLine, olderNode, barShown, checkForUpdate, wireUpdates, renderUpdateSwitch,
  API_URL, ALL_URL, CACHE_KEY, DISMISS_KEY, DAY_MS,
};
