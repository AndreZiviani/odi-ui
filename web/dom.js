/*
 * The four things every other module needs: find an element, make one, show an
 * error, fetch JSON.
 *
 * `get` throws on a non-2xx rather than returning a body, so a caller cannot
 * accidentally render an error page as data.
 */

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

function fail(e) {
  const box = $('#err');
  box.textContent = String(e && e.message ? e.message : e);
  box.hidden = false;
}

/* The server says what may be kept: the image files come with a tag and are
   revalidated (a 304 when unchanged), and what the device holds is no-store.
   Forcing no-store here threw the tags away. */
async function get(path) {
  const r = await fetch(path);
  if (!r.ok) {
    /* A refusal says why in {"error": ...}: show that, not only the status. */
    let why = '';
    try { why = (await r.json()).error || ''; } catch (e) { /* not JSON */ }
    throw new Error(path + ' -> HTTP ' + r.status + (why ? ': ' + why : ''));
  }
  return r.json();
}

/*
 * Light or dark. The page follows prefers-color-scheme until the user picks
 * one; the pick is data-theme on <html> (which style.css lets override the
 * media query) and is kept in localStorage under THEME_KEY. index.html reads it
 * back in the head, before first paint. Storage can be absent or throw, and
 * then the choice lasts for the page only.
 */
const THEME_KEY = 'odi-theme';
const currentTheme = () => {
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches
    ? 'light' : 'dark';
};
function paintThemeToggle() {
  const to = currentTheme() === 'dark' ? 'light' : 'dark';
  const b = $('#themetoggle');
  b.setAttribute('aria-label', 'Switch to ' + to + ' mode');
  b.setAttribute('title', 'Switch to ' + to + ' mode');
  /* setAttribute, not .hidden: an SVG element has no hidden property. */
  for (const [id, on] of [['#ico-sun', to === 'light'], ['#ico-moon', to === 'dark']]) {
    if (on) $(id).removeAttribute('hidden'); else $(id).setAttribute('hidden', '');
  }
}
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* not persisted */ }
  paintThemeToggle();
}
function wireTheme() {
  $('#themetoggle').addEventListener('click', () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
  /* Until a pick is made the icon has to follow the browser too. */
  if (typeof matchMedia === 'function') {
    const mq = matchMedia('(prefers-color-scheme: light)');
    if (mq.addEventListener) mq.addEventListener('change', paintThemeToggle);
  }
  paintThemeToggle();
}

const bytes = (n) => {
  n = Number(n || 0);
  const u = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  /* At most two decimals at any scale. A rate is a byte count over a
     fractional interval, so below 1 kB it used to print the float whole
     (123.456789 B/s). */
  return (i ? n.toFixed(n < 10 ? 2 : 1) : String(Math.round(n * 100) / 100)) + ' ' + u[i];
};

/*
 * The ? beside a field name. It shows or hides `helpBox`, which starts
 * closed. Full help (data-help="full" on <html>) shows every box at once
 * without changing what each ? has open on its own.
 */
function createHelpToggle(helpBox, fieldLabel) {
  const button = el('button', 'help-toggle', '?');
  button.type = 'button';
  button.title = 'Help';
  button.setAttribute('aria-label', 'Help: ' + fieldLabel);
  button.setAttribute('aria-expanded', 'false');
  if (helpBox.id) button.setAttribute('aria-controls', helpBox.id);
  button.addEventListener('click', () => {
    const isOpen = !helpBox.classList.contains('open');
    helpBox.classList.toggle('open', isOpen);
    button.setAttribute('aria-expanded', String(isOpen));
  });
  return button;
}

/*
 * Full help: every field's help open at once, from the header button, which
 * only the Config tab shows (app.js route()). It is data-help="full" on
 * <html> (style.css opens every .s-helpbox under it) and is kept in
 * localStorage under HELP_KEY, read back in the head like the theme.
 */
const HELP_KEY = 'odi-fullhelp';
const isFullHelpOn = () => document.documentElement.dataset.help === 'full';
function setFullHelp(enabled) {
  if (enabled) document.documentElement.dataset.help = 'full';
  else delete document.documentElement.dataset.help;
  try { localStorage.setItem(HELP_KEY, enabled ? '1' : '0'); } catch (error) { /* not persisted */ }
  $('#helptoggle').setAttribute('aria-pressed', String(enabled));
}
function wireHelp() {
  $('#helptoggle').addEventListener('click', () => setFullHelp(!isFullHelpOn()));
  $('#helptoggle').setAttribute('aria-pressed', String(isFullHelpOn()));
}

/*
 * What this tab saw, for the charts on the Status tab: one entry per poll,
 * for the last hour, under a key of its own. It lives in sessionStorage, so
 * it survives a reload and is gone with the tab; the stick keeps no history,
 * and a longer one is the metrics exporter's job. A poll with nothing to
 * record adds nothing and shows as a gap. Storage that is blocked only costs
 * the reload.
 *
 * An entry is [time, value, ...]; histRecord(key, null) only drops what is
 * older than the hour. histSlots() lays the entries out for a chart: one
 * slot per poll interval, newest last, the last entry of an interval
 * standing for it, null where there was none.
 */
const HIST_SLOT_MS = 15000;     /* the poll interval: one bar */
const HIST_SLOTS = 240;         /* an hour of them */
/* More than one entry can fall into a slot (the page polls once more 3 s
   after it opens), so the cap is a few per slot, and a stored text beyond
   what that many entries take is not read at all. */
const HIST_MAX = HIST_SLOTS * 4;
const HIST_MAX_TEXT = HIST_MAX * 96;
const HISTS = {};
function histLoad(key) {
  if (HISTS[key]) return HISTS[key];
  HISTS[key] = [];
  try {
    /* What this page wrote is a few kilobytes. Anything much larger is not
       ours, and is not parsed: it would be parsed on every page load. */
    const text = globalThis.sessionStorage.getItem(key) || '[]';
    const raw = text.length > HIST_MAX_TEXT ? [] : JSON.parse(text);
    if (Array.isArray(raw)) {
      HISTS[key] = raw.filter((p) => Array.isArray(p) && p.length > 1 && p.length <= 8
        && p.every((v) => Number.isFinite(v))).slice(-HIST_MAX);
    }
  } catch (e) { /* no storage, or not ours: start empty */ }
  return HISTS[key];
}
function histRecord(key, vals) {
  const now = Date.now();
  const h = histLoad(key).filter((p) => p[0] > now - HIST_SLOT_MS * HIST_SLOTS && p[0] <= now);
  if (vals && vals.every((v) => Number.isFinite(v))) h.push([now, ...vals]);
  HISTS[key] = h.slice(-HIST_MAX);
  try { globalThis.sessionStorage.setItem(key, JSON.stringify(HISTS[key])); } catch (e) { /* not kept */ }
  return HISTS[key];
}
function histSlots(hist) {
  const now = Date.now();
  const slots = new Array(HIST_SLOTS).fill(null);
  for (const p of hist) {
    const k = HIST_SLOTS - 1 - Math.floor((now - p[0]) / HIST_SLOT_MS);
    if (k >= 0 && k < HIST_SLOTS) slots[k] = p;
  }
  return slots;
}
const hhmm = (t) => {
  const d = new Date(t);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};
const histStart = () => hhmm(Date.now() - HIST_SLOT_MS * HIST_SLOTS);

export { $, el, fail, get, bytes, histRecord, histSlots, histStart, hhmm, currentTheme, setTheme, wireTheme, createHelpToggle, setFullHelp, wireHelp, THEME_KEY, HELP_KEY };
