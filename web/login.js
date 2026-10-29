/*
 * The sign-in page.
 *
 * The credential goes to /api/login once, which answers with a session cookie
 * the browser keeps until it closes or the session ends (sign out, a confd
 * restart, half an hour unused, a day in all). fetch() and not a plain form
 * post: confd sends `Referrer-Policy: no-referrer`, under which a form post
 * carries `Origin: null` and is refused as cross-site.
 *
 * On success the page goes where the browser was headed. A redirect keeps the
 * location hash, so /#config/vlan comes back to Config > VLAN.
 */

const $ = (s) => document.querySelector(s);

function say(cls, text) {
  const m = $('#signin-msg');
  m.className = cls;
  m.textContent = text;
}

/* What the page says for an answer from /api/login. Pure, for make check. */
export function loginOutcome(status, body) {
  if (status === 200 && body && body.ok) return { ok: true };
  if (body && body.error) return { ok: false, text: body.error[0].toUpperCase() + body.error.slice(1) + '.' };
  return { ok: false, text: `The stick answered ${status}.` };
}

export async function signIn(user, password, f = fetch) {
  const r = await f('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user, password }).toString(),
    cache: 'no-store',
  });
  let body = null;
  try { body = await r.json(); } catch (e) { /* not JSON: the status says it */ }
  return loginOutcome(r.status, body);
}

async function onSubmit(ev) {
  ev.preventDefault();
  const user = $('#user').value.trim();
  const pass = $('#pass');
  if (!user || !pass.value) { say('bad', 'Enter the username and the password.'); return; }
  const go = $('#signin-go');
  go.disabled = true;
  say('', 'Signing in…');
  try {
    const out = await signIn(user, pass.value);
    if (out.ok) { location.replace('/' + location.hash); return; }
    say('bad', out.text);
    pass.value = '';
    pass.focus();
  } catch (e) {
    say('bad', 'No answer from the stick. Check that it is still reachable, then try again.');
  }
  go.disabled = false;
}

if (typeof document !== 'undefined' && $('#signin')) {
  if (new URLSearchParams(location.search).has('out')) say('good', 'You have been signed out.');
  $('#signin').addEventListener('submit', onSubmit);
}
