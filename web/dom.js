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
  if (!r.ok) throw new Error(path + ' -> HTTP ' + r.status);
  return r.json();
}

const bytes = (n) => {
  n = Number(n || 0);
  const u = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return (i ? n.toFixed(n < 10 ? 2 : 1) : String(n)) + ' ' + u[i];
};

/*
 * Lore popovers.
 *
 * The reference text lives once, as a `.lore-item` inside the
 * `<details class="lore">` block at the foot of its tab; a `.why` button clones
 * that entry into a popover anchored to the term. One string, two
 * presentations -- and collapsing a paragraph out of the page never puts it out
 * of reach, because the details block is still there for keyboard, for print,
 * and for anything without a pointer.
 *
 * Hover is not enough on its own. Half the time this page is opened on a phone
 * standing next to the rack, where hover does not exist, so a click pins the
 * popover open and a second click, Escape, or a click elsewhere closes it.
 *
 * No fade: the popover is toggled with the `hidden` attribute, which cannot be
 * transitioned, and a class dance to animate 90 ms is not worth the bytes on a
 * partition this image is already most of the way through.
 */
function wireLore() {
  let open = null;
  let n = 0;

  const shut = () => {
    if (!open) return;
    open.pop.hidden = true;
    open.btn.setAttribute('aria-expanded', 'false');
    open = null;
  };

  for (const btn of document.querySelectorAll('.why')) {
    const src = document.getElementById(btn.dataset.why);
    const wrap = btn.parentElement;
    /* A trigger naming an entry that is not there must not take the page down
       with it -- it is a footnote, and a missing footnote is a missing
       footnote. */
    if (!src || !wrap) continue;

    const pop = el('span', 'pop');
    pop.id = 'pop-' + (++n);
    pop.hidden = true;
    const copy = src.cloneNode(true);
    copy.removeAttribute('id');   /* one id, and the foot block keeps it */
    pop.append(copy);
    wrap.append(pop);
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-describedby', pop.id);

    const show = (pin) => {
      const wasPinned = !!(open && open.pop === pop && open.pinned);
      if (open && open.pop !== pop) shut();
      pop.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      open = { pop, btn, pinned: pin || wasPinned };
    };
    const leave = () => { if (!open || !open.pinned) shut(); };

    /* The popover is inside the wrap, so moving the pointer into it does not
       count as leaving the term. */
    wrap.onmouseenter = () => show(false);
    wrap.onmouseleave = leave;
    btn.onfocus = () => show(false);
    btn.onblur = leave;
    btn.onclick = (e) => {
      e.preventDefault();
      if (open && open.pop === pop && open.pinned) shut(); else show(true);
    };
  }

  document.addEventListener('click', (e) => {
    if (!open) return;
    if (open.btn.contains(e.target) || open.pop.contains(e.target)) return;
    shut();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') shut(); });
}

export { $, el, fail, get, bytes, wireLore };
