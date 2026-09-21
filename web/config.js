/*
 * The Config and All-settings tables: one row per key, rendered from the schema.
 *
 * Adding a key to the device adds a row here with no code change -- the schema
 * is data, and meta.tsv is what turns a name into a labelled, explained,
 * range-checked control.
 */

import { $, el } from './dom.js';
import { S, EDITS, provenance, applyOf, dependsUnmet, decodeMask } from './state.js';
import { hexAscii, validateInput } from './validate.js';

function renderValue(row, raw) {
  const td = el('td');
  const meta = S.META[row.name] || {};

  /* What to PUT IN THE FIELD: the pending edit if there is one, otherwise the
     device value. `raw` stays the comparison baseline throughout.

     Keeping edits in a Map outside the DOM is what lets a tab switch or a
     filter keystroke rebuild the table without losing them — but only if the
     rebuild reads the Map back. It did not: renderConfig repopulated every
     field from VALUES, so a typed change vanished from the screen while the
     bar still counted it and Save still wrote it. A value the user cannot see
     is a value they cannot check. */
  const shown = EDITS.has(row.name) ? EDITS.get(row.name) : raw;

  /* Never-writable keys get no control at all. The refusal is enforced in the
     daemon twice over, but not offering the field is the honest presentation. */
  if (row.writable === 'never') {
    td.append(el('span', null, raw === '' ? '(empty)' : raw));
    return td;
  }

  let input;
  if (meta.options) {
    input = el('select');
    for (const pair of meta.options.split('|')) {
      const eq = pair.indexOf('=');
      const o = el('option', null, pair.slice(eq + 1));
      o.value = pair.slice(0, eq);
      input.append(o);
    }
    /* A value the device holds that is not in the option list must still be
       selectable, or opening the page would silently propose changing it.
       A key with NO value is a different case and gets said differently:
       several read `GET fail` on both of our sticks, and rendering that as
       "undefined (current, not a listed value)" reads like a fault in the page
       rather than an empty key. */
    if (raw === undefined || raw === '') {
      const o = el('option', null, '(not set)');
      o.value = '';
      input.append(o);
    } else if (![...input.options].some((o) => o.value === raw)) {
      const o = el('option', null, raw + ' (current, not a listed value)');
      o.value = raw;
      input.append(o);
    }
    if (shown !== raw && ![...input.options].some((o) => o.value === shown)) {
      const o = el('option', null, shown);
      o.value = shown;
      input.append(o);
    }
    input.value = shown;
  } else {
    input = el('input');
    input.type = 'text';
    input.value = shown === undefined ? '' : shown;
    input.spellcheck = false;
    if (row.type === 'int') input.inputMode = 'numeric';
  }
  input.dataset.name = row.name;
  /* Anything else on this row that has to follow the field as it is typed
     registers here, rather than adding a second listener: one handler means no
     ordering to get wrong, and the DOM stub in scripts/web-check.mjs only has
     to model the one. */
  let follow = null;
  input.oninput = input.onchange = () => {
    const v = input.value;
    if (v === raw) EDITS.delete(row.name); else EDITS.set(row.name, v);
    input.classList.toggle('changed', v !== raw);
    validateInput(row, input);
    if (follow) follow(v);
    /* An event, not an import of save.js: config renders the fields and save
       owns the bar, and importing each other would make that a cycle. */
    document.dispatchEvent(new Event('edits-changed'));
  };
  input.classList.toggle('changed', shown !== raw);
  validateInput(row, input);
  td.append(input);

  /*
     The OMCI_CUSTOM_* masks decode to the plugins the image will load. Shown
     under the field and refreshed on every keystroke, because the whole point
     is to see what a value DOES before saving it -- upstream has had an open
     issue since 2022 asking what OMCI_CUSTOM_RDP=4 means, and the answer is one
     line of text this device could always have printed. */
  if (decodeMask(row.name, '0')) {
    const box = el('div', 'aside bits');
    const paint = (v) => {
      const d = decodeMask(row.name, v);
      box.textContent = '';
      /* An empty key is not a malformed one. Several keys on both of our
         sticks read back empty, and calling that "not a number" reads like a
         fault in the page rather than an unset value. */
      if (String(v ?? '').trim() === '') { box.append(el('div', null, 'not set')); return; }
      if (!d) { box.append(el('div', null, 'not a number')); return; }
      if (!d.n) { box.append(el('div', null, 'no features enabled')); return; }
      for (const b of d.known)
        box.append(el('div', null, '0x' + b.bit.toString(16) + '  ' + b.names.join(', ')));
      for (const b of d.unknown)
        box.append(el('div', 'unknownbit',
          '0x' + b.toString(16) + '  no plugin in this image \u2014 does nothing'));
    };
    paint(shown);
    follow = paint;
    td.append(box);
  }

  /* PLOAM and friends store the hex of an ASCII string; show the readable form
     beside the field it is stored in. */
  if (row.type === 'hexascii') {
    const txt = hexAscii(raw);
    td.append(el('div', 'aside', txt === null ? 'not printable ASCII' : 'ASCII: ' + txt));
  }
  return td;
}

/*
 * `sections` off renders the rows bare, with no per-section heading. The Admin
 * tab shows one schema section under a heading of its own -- "Device login"
 * says more to an operator than the schema's internal name for it, and two
 * headings stacked would just be the same word twice.
 */
function renderConfig(hostSel, rows, filter, sections = true) {
  const host = $(hostSel);
  host.textContent = '';
  const f = (filter || '').toLowerCase();
  const bySection = {};

  for (const row of rows) {
    if (f && !(row.name.toLowerCase().includes(f) || row.section.includes(f))) continue;
    (bySection[row.section] ||= []).push(row);
  }

  for (const name of Object.keys(bySection).sort()) {
    if (sections) host.append(el('h2', null, name));
    const t = el('table');
    const head = el('tr');
    for (const h of ['Setting', 'Value', 'What it does']) head.append(el('th', null, h));
    t.append(head);
    for (const row of bySection[name]) {
      const meta = S.META[row.name] || {};
      const tr = el('tr');
      const k = el('td');
      k.append(el('div', 'label', meta.label || row.name));
      k.append(el('div', 'key', row.name));
      if (row.writable === 'never') k.append(el('span', 'tag never', 'never'));
      if (row.writable === 'identity') k.append(el('span', 'tag identity', 'identity'));
      const ap = applyOf(row);
      if (ap === 'restart:omci') k.append(el('span', 'tag omci', 'no reboot'));
      if (ap === 'reboot') k.append(el('span', 'tag identity', 'needs reboot'));
      if (meta.range) k.append(el('span', 'tag', meta.range));
      const prov = provenance(row, S.VALUES[row.name]);
      if (prov) {
        const t = el('span', 'tag ' + prov.cls, prov.label);
        if (prov.was !== undefined) {
          t.title = `${prov.from}: ${prov.was === '' ? '(empty)' : prov.was}`;
        }
        k.append(t);
      }
      tr.append(k);

      tr.append(renderValue(row, S.VALUES[row.name]));

      const info = el('td', 'info');
      if (meta.help) info.append(el('div', 'help', meta.help));
      const unmet = dependsUnmet(row);
      if (unmet) {
        info.append(el('div', 'unmet',
          'Ignored by the firmware right now \u2014 needs ' + unmet.join(' and ') + '.'));
      }
      if (meta.options) {
        info.append(el('div', 'opts', 'Accepts: ' +
          meta.options.split('|').map((p) => p.slice(0, p.indexOf('='))).join(', ')));
      }
      /* Who reads the key. Useful even where the timing is unknown, and it is
         what the apply class was derived from. */
      const rd = (S.CONS[row.name] || {}).readers;
      if (rd) info.append(el('div', 'opts', 'Read by: ' + rd.split(',').join(', ')));
      if (prov && prov.was !== undefined) {
        info.append(el('div', 'opts',
          `${prov.from} was ${prov.was === '' ? '(empty)' : prov.was}`));
      }
      tr.append(info);
      t.append(tr);
    }
    host.append(t);
  }
}

function renderAll() {
  /* The account keys are the device's own SSH and telnet login, not a line
     setting, so they live on Admin beside the credential for this UI -- the
     two are confused often enough that showing them apart is the point. */
  const accounts = (r) => r.section === 'accounts';
  renderConfig('#common', S.SCHEMA.filter((r) => r.common === 'yes' && !accounts(r)), '');
  renderConfig('#accounts', S.SCHEMA.filter((r) => r.common === 'yes' && accounts(r)), '', false);
  renderConfig('#sections', S.SCHEMA, $('#filter').value);
}

export { renderValue, renderConfig, renderAll };
