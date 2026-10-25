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

async function get(path) {
  const r = await fetch(path, { cache: 'no-store' });
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

export { $, el, fail, get, bytes, currentTheme, setTheme, wireTheme, createHelpToggle, setFullHelp, wireHelp, THEME_KEY, HELP_KEY };
