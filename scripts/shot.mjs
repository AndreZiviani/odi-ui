/*
 * Open the page in a real browser, screenshot every tab, and fail on any
 * console error or failed request.
 *
 * web-check.mjs proves the module graph loads and the functions run; it cannot
 * see that a grid rule put every label in the wrong row, or that a hardcoded
 * '+' rendered a negative bound as "+-4 dBm". Both of those shipped and were
 * found here, by looking.
 *
 * Needs scripts/preview.sh running, and puppeteer-core driving the browser you
 * already have:
 *
 *   npm i puppeteer-core && node scripts/shot.mjs
 *
 * Deliberately NOT part of `make check`: it wants a browser and a network
 * install, and the checks that gate a build must not.
 */
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = 'http://127.0.0.1:18080';

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 2 });
await page.authenticate({ username: 'admin', password: 'admin' });

const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('requestfailed', (r) => problems.push('failed: ' + r.url() + ' ' + r.failure()?.errorText));
page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`); });

await page.goto(BASE + '/', { waitUntil: 'networkidle0', timeout: 30000 });
await new Promise((r) => setTimeout(r, 1500));

/* Every view, by the hash that names it. */
const views = ['status', 'config/line', 'config/vlan', 'config/identity', 'config/network',
               'config/services', 'config/stock', 'omci/services', 'omci/mib',
               'system/firmware', 'system/access', 'system/backup', 'system/logs'];
for (const v of views) {
  await page.evaluate((h) => { location.hash = h; }, v);
  /* The OMCI views fork omcicli once per card, so they need longer than a
     view that only re-renders what is already loaded. */
  await new Promise((r) => setTimeout(r, /firmware|omci/.test(v) ? 1800 : 500));
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  if (sw > 1400) problems.push(`${v}: horizontal overflow, ${sw}px`);
  await page.screenshot({ path: `/tmp/ui-${v.replace('/', '-')}.png`, fullPage: true });
}

/* The tablist must answer the arrow keys, not only the mouse. */
await page.evaluate(() => { location.hash = 'status'; });
await page.focus('#tab-status');
await page.keyboard.press('ArrowRight');
await new Promise((r) => setTimeout(r, 300));
const afterArrow = await page.evaluate(() => location.hash);
if (afterArrow !== '#config') problems.push('ArrowRight on Status went to ' + afterArrow);

const counts = await page.evaluate(() => ({
  settings: document.querySelectorAll('#p-config .setting').length,
  stockRows: document.querySelectorAll('#sections .setting').length,
  meters: document.querySelectorAll('.meter').length,
  ladder: document.querySelectorAll('#ladder li').length,
  flowSides: document.querySelectorAll('#flow .side').length,
  saveBarVisible: !document.querySelector('#savebar').hidden,
  meCards: document.querySelectorAll('#services-cards .me-card').length,
  meUnread: document.querySelectorAll('#services-cards .me-card.unread').length,
  meTableOptions: document.querySelectorAll('#me-select option').length,
  meInstances: document.querySelectorAll('#me-out .me-inst').length,
  slots: document.querySelectorAll('#parts .slot').length,
  title: document.title,
}));

console.log(JSON.stringify(counts, null, 2));
console.log(problems.length ? '\nPROBLEMS:\n' + problems.join('\n') : '\nno console errors, no failed requests');
await browser.close();
