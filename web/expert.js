/*
 * The editor for OMCI_FIXED_ME: a table, one row per entry, in place of the
 * string the key holds.
 *
 * The rows are the whole state. Typing changes a row and hands the key's
 * string (validate.js, fixedMeSerialise) to the caller, which owns what a
 * pending edit is; adding or removing a row rebuilds the table. Text goes out
 * as typed, so a row that is not finished yet gives a string the check refuses
 * and the Save gate holds, instead of one that quietly drops it.
 */

import { el } from './dom.js';
import {
  fixedMeParse, fixedMeSerialise, fixedMeRowProblems, fixedMeSetProblem, FME_MAX_ENTRIES,
} from './validate.js';

const COLS = [
  ['cls', 'Class', '188', 'Managed entity class, 1–65535'],
  ['inst', 'Instance', 'any', 'Instance, 0–65535 or 0x hex. Empty or “any”: every instance, not in the MIB upload (then attribute is “any” too)'],
  ['attr', 'Attribute', 'any', 'Attribute number, 1–16'],
  ['hex', 'Bytes (hex)', '0011aa', 'The attribute value, 1 to 25 bytes, optional 0x'],
];

const blank = (r) => r.cls === '' && r.hex === '' && (r.inst === '' || r.inst === 'any')
  && (r.attr === '' || r.attr === 'any');

/* `value` is the key as it should be shown; `onChange(string)` is called with
   the serialised table after every edit. */
function renderFixedMeEditor(value, onChange) {
  const box = el('div', 'fme');
  const rows = fixedMeParse(value || '');
  const msg = el('p', 's-aside fme-msg');
  const add = el('button', 'quiet', 'Add entry');
  add.type = 'button';
  const body = el('tbody');

  function paint() {
    const live = rows.filter((r) => !blank(r));
    let note = '';
    if (!live.length) note = 'No entries: the stick answers unknown classes as it always did.';
    else note = fixedMeSetProblem(live) || '';
    msg.textContent = note;
    msg.classList.toggle('s-warn', !!note && !!live.length);
    add.disabled = rows.length >= FME_MAX_ENTRIES;
  }

  function mark(tr, r) {
    const bad = blank(r) ? {} : fixedMeRowProblems(r);
    for (const input of tr.inputs) {
      const why = r.bad && input.dataset.col === 'cls' ? r.bad : bad[input.dataset.col];
      input.classList.toggle('invalid', !!why);
      input.title = why || input.dataset.tip;
    }
  }

  function line(r) {
    const tr = el('tr');
    tr.inputs = [];
    for (const [col, label, ph, tip] of COLS) {
      const input = el('input', 'mono');
      input.type = 'text';
      input.value = r[col];
      input.placeholder = ph;
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.dataset.col = col;
      input.dataset.tip = tip;
      input.setAttribute('aria-label', label);
      input.title = tip;
      input.oninput = input.onchange = () => {
        r[col] = input.value.trim();
        r.bad = null;
        mark(tr, r);
        paint();
        onChange(fixedMeSerialise(rows));
      };
      tr.inputs.push(input);
      const td = el('td');
      td.append(input);
      tr.append(td);
    }
    const rm = el('button', 'danger-quiet', 'Remove');
    rm.type = 'button';
    rm.setAttribute('aria-label', 'Remove this entry');
    rm.onclick = () => {
      rows.splice(rows.indexOf(r), 1);
      draw();
      onChange(fixedMeSerialise(rows));
    };
    const td = el('td');
    td.append(rm);
    tr.append(td);
    mark(tr, r);
    return tr;
  }

  function draw() {
    body.textContent = '';
    for (const r of rows) body.append(line(r));
    paint();
  }

  add.onclick = () => {
    rows.push({ cls: '', inst: '', attr: '', hex: '', bad: null });
    draw();
    const last = body.children[body.children.length - 1];
    if (last && last.inputs) last.inputs[0].focus();
  };

  const table = el('table', 'fme-table');
  const head = el('tr');
  for (const [, label] of COLS) head.append(el('th', null, label));
  head.append(el('th'));
  const thead = el('thead');
  thead.append(head);
  table.append(thead, body);
  /* The table sits in a line of its own, so the row can put its tags beside it (config.js renderRow),
  level with the first row of inputs. */
  const tableLine = el('div', 'fme-tableline');
  tableLine.append(table);
  box.append(tableLine, msg, add);
  box.tableLine = tableLine;
  draw();
  return box;
}

export { renderFixedMeEditor };
