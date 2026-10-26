/*
 * The phone lines the OLT provisioned, read from `omcicli voip`.
 *
 * The stick has no phone socket, places no call and registers nothing: this
 * page shows what the OLT told it a line should be, so the SIP client of the
 * router behind the stick can be set up with the same values. The line status
 * is the stick's own ("config done"), never "registered".
 *
 * The first read is the masked view: number, name and login are shortened and
 * the password is only said to be set. "Show secrets" asks for the admin
 * password again and calls POST /api/voip/secrets; what comes back is kept in
 * memory for this page only, drawn in place of the masked values, and thrown
 * away by "Hide" or by leaving the tab.
 */

import { $, el, get } from './dom.js';
import { S } from './state.js';

/* One `omcicli voip` output -> [{ head, rows: [[label, value]], status }].
   Permissive: a line it does not know is kept as text, not dropped. */
function parseVoip(text) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\r$/, ''));
  const ports = [];
  let cur = null;
  let none = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === 'no voice provisioned') { none = true; continue; }
    let m = /^port (0x[0-9a-f]+) \(voice CTP (0x[0-9a-f]+)\)$/.exec(line);
    if (m) { cur = { head: 'Phone port ' + m[1], rows: [] }; ports.push(cur); continue; }
    if (line === 'no port') { cur = { head: 'SIP user not on a phone port', rows: [] }; ports.push(cur); continue; }
    if (!cur) continue;
    const add = (k, v) => cur.rows.push([k, v]);

    if ((m = /^sip user (0x[0-9a-f]+): aor (.*), display name (.*)$/.exec(line))) {
      add('SIP user', m[2]); add('Display name', m[3]);
    } else if (/^sip user -$/.test(line)) {
      add('SIP user', 'none provisioned');
    } else if ((m = /^sip user login (0x[0-9a-f]+): username (.*?), (password .*), realm (.*)$/.exec(line))) {
      add('Login name', m[2]);
      add('Password', m[3].replace(/^password /, ''));
      add('Realm', m[4]);
    } else if ((m = /^(proxy|outbound proxy|registrar) (.*)$/.exec(line))) {
      add(m[1][0].toUpperCase() + m[1].slice(1), m[2]);
    } else if ((m = /^port (\d+\/\w+|\d+\/\?)$/.exec(line))) {
      add('SIP port', m[1]);
    } else if ((m = /^dns (.*)$/.exec(line))) {
      add('DNS', m[1]);
    } else if ((m = /^expiry (\d+) s$/.exec(line))) {
      add('Registration expiry', m[1] + ' s');
    } else if ((m = /^media profile 0x[0-9a-f]+: codecs (.*), dtmf (.*)$/.exec(line))) {
      add('Codecs', m[1]); add('DTMF', m[2]);
    } else if ((m = /^rtp ports (\d+-\d+) dscp (\d+)$/.exec(line))) {
      add('RTP ports', m[1] + ', DSCP ' + m[2]);
    } else if ((m = /^voice vlan (.*)$/.exec(line))) {
      add('Voice VLAN', m[1].replace(/^: /, ''));
    } else if ((m = /^line status (.*)$/.exec(line))) {
      cur.status = m[1];
    } else if (!/^(sip agent|host part|voice service profile)\b/.test(line)) {
      add('Other', line);
    }
  }
  return { ports, none };
}

let secretText = null;   /* the --secrets output, while it is shown */
let lastMasked = '';

function drawLines(host, text) {
  const { ports, none } = parseVoip(text);

  host.textContent = '';
  if (none || !ports.length) {
    host.append(el('p', 'me-state', 'No voice provisioned'),
      el('p', 'hint', 'Phone ports are on, but the OLT has not provisioned a SIP line on them. '
        + 'Many OLTs offer no voice at all; nothing is wrong with the stick.'));
    return;
  }
  for (const p of ports) {
    const card = el('section', 'me-card');
    card.append(el('h3', '', p.head));
    card.append(el('p', 'me-state', p.status ? 'Line status: ' + p.status : 'Line status: not reported'));
    const kv = el('dl', 'kv');
    for (const [k, v] of p.rows) kv.append(el('dt', '', k), el('dd', '', v));
    card.append(kv);
    host.append(card);
  }
}

function setSecretUi(open) {
  $('#phone-ask').hidden = !open;
  if (open) $('#phone-pass').focus();
}

async function showSecrets() {
  const input = $('#phone-pass');
  const out = $('#phone-msg');

  out.textContent = '';
  let r, j = {};
  try {
    r = await fetch('/api/voip/secrets', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=' + encodeURIComponent(input.value),
    });
    try { j = await r.json(); } catch (e) { /* not JSON */ }
  } catch (e) {
    out.textContent = 'Could not reach the stick.';
    return;
  }
  input.value = '';
  if (!r.ok) {
    out.textContent = j.error || ('Refused (HTTP ' + r.status + ').');
    return;
  }
  if (!j.ok) {
    out.textContent = j.error || 'omcicli did not answer.';
    return;
  }
  secretText = j.raw;
  setSecretUi(false);
  $('#phone-secrets').textContent = 'Hide secrets';
  drawLines($('#phone-lines'), secretText);
  /* This tab is the only holder; do not keep it past a change of page. */
  $('#phone-lines').dataset.secrets = '1';
}

function hideSecrets() {
  const shown = secretText !== null;

  secretText = null;
  $('#phone-secrets').textContent = 'Show secrets';
  setSecretUi(false);
  $('#phone-msg').textContent = '';
  $('#phone-pass').value = '';
  if (shown) {
    delete $('#phone-lines').dataset.secrets;
    drawLines($('#phone-lines'), lastMasked);
  }
}

/* What the router last said about its SIP client, per port, and how old that
   is. Only a state word and an age: the stick never holds a number or a
   password for this. The OLT is told it only while the key is on and it is
   fresh (the daemon's ttl); the card says which of those it is. */
function drawReport(host, d) {
  const on = String(S.VALUES.OMCI_VOIP_LINE_REPORT || '0') === '1';
  const ports = (d && d.ok && d.ports) || [];
  const ttl = (d && d.ttl) || 300;
  const card = el('section', 'me-card');

  host.textContent = '';
  card.append(el('h3', '', 'Router report'));
  if (!ports.length) {
    card.append(el('p', 'me-state', 'No report from the router'));
  } else {
    for (const p of ports) {
      const stale = p.age > ttl;
      card.append(el('p', 'me-state', 'Port ' + p.port + ': ' + String(p.state).replace(/_/g, ' ')
        + ', ' + p.age + ' s ago' + (stale ? ' (too old, ignored)' : '')));
    }
  }
  card.append(el('p', 'hint', on
    ? 'The OLT reads the router\'s state as the line status while a report is under ' + ttl + ' s old; otherwise "config done".'
    : 'The OLT is told "config done". To let the router\'s state through, set the router-reported line status key to 1 in Config, ONU identity, Expert settings, and have the router post its state (docs/API.md, POST /api/voip/status).'));
  host.append(card);
}

const portsOn = () => ['1', '2'].includes(String(S.VALUES.OMCI_POTS_PORTS || '0'));

async function renderPhone() {
  const off = $('#phone-off');
  const lines = $('#phone-lines');
  const tools = $('#phone-tools');

  hideSecrets();
  lastMasked = '';
  $('#phone-report').textContent = '';
  if (!portsOn()) {
    off.hidden = false;
    tools.hidden = true;
    lines.textContent = '';
    return;
  }
  off.hidden = true;
  tools.hidden = false;
  lines.textContent = '';
  lines.append(el('p', 'me-state', 'Reading…'));
  let d;
  try {
    d = await get('/api/voip');
  } catch (e) {
    lines.textContent = '';
    lines.append(el('p', 'me-state', 'Could not read'), el('p', 'hint', String(e.message || e)));
    return;
  }
  if (!d.ok) {
    lines.textContent = '';
    lines.append(el('p', 'me-state', 'Could not read'),
      el('p', 'hint', (d.error || 'omcicli failed') + '. This image may predate the phone view.'));
    return;
  }
  lastMasked = d.raw;
  drawLines(lines, lastMasked);
  let r = null;
  try { r = await get('/api/voip/status'); } catch (e) { /* an older confd has no such route */ }
  drawReport($('#phone-report'), r);
}

function wirePhone() {
  $('#phone-reload').onclick = () => renderPhone();
  $('#phone-secrets').onclick = () => (secretText !== null ? hideSecrets() : setSecretUi($('#phone-ask').hidden));
  $('#phone-show').onclick = showSecrets;
  $('#phone-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') showSecrets(); });
}

export { parseVoip, renderPhone, wirePhone, hideSecrets };
