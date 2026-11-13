/*
 * The editor for LAN_ROUTES: a table, one row per static route (Destination,
 * Gateway), in place of the string the key holds.
 *
 * The rows are the whole state. Typing changes a row and hands the string
 * of the key (validate.js, routesSerialise) to the caller, which owns what a
 * pending edit is; adding or removing a row rebuilds the table. Text goes out
 * as typed, so a row that is not finished yet gives a string the check
 * refuses and the Save gate holds, instead of one that quietly drops it.
 *
 * What is wrong is written under the table, one line per fault, not only in
 * a tooltip: the gateway depends on the management addresses being edited
 * on the same page, so the check runs again whenever an edit changes.
 */

import { el } from './dom.js';
import {
  routesParse, routesSerialise, routeRowProblems, routesSetProblem, routeGatewayProblem, ROUTES_MAX,
} from './validate.js';

const COLS = [
  ['dest', 'Destination', 'default', 'default, or a network with its prefix, e.g. 10.0.0.0/8 (host bits zero)'],
  ['gw', 'Gateway', '192.168.1.254', 'An address inside the management subnet: the stick must reach it directly'],
];

const blank = (r) => r.dest === '' && r.gw === '';

/* The editor on the page now, repainted when any edit changes: the gateway is
   judged against the management addresses, which are other fields. */
let current = null;
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('edits-changed', () => { if (current) current(); });
}

/* `value` is the key as it should be shown; `onChange(string)` is called with
   the serialised table after every edit. */
function renderRoutesEditor(value, onChange) {
  const box = el('div', 'fme routes');
  const rows = routesParse(value || '');
  const msg = el('div', 's-aside fme-msg routes-msg');
  const add = el('button', 'quiet', 'Add route');
  add.type = 'button';
  const body = el('tbody');

  /* Everything wrong right now, as lines: the fields of each row, then the rows
     against each other, then each gateway against the management subnets. */
  function faults() {
    const out = [];
    const live = rows.filter((r) => !blank(r));
    for (const r of live) {
      const n = rows.indexOf(r) + 1;
      for (const why of Object.values(routeRowProblems(r))) out.push(`Route ${n}, ${why}`);
    }
    const set = routesSetProblem(live);
    if (set) out.push(set[0].toUpperCase() + set.slice(1));
    for (const r of live) {
      const why = routeGatewayProblem(r.gw);
      if (why) out.push(`Route ${rows.indexOf(r) + 1}, ${why}`);
    }
    return out;
  }

  function paint() {
    const bad = faults();
    msg.textContent = '';
    if (!rows.some((r) => !blank(r))) {
      msg.append(el('p', 's-help', 'No static routes. Only needed to reach the stick from another subnet '
        + 'without NAT: the routes stay on the management side, nothing is routed to or from the fibre.'));
    }
    for (const line of bad) msg.append(el('p', 's-warn', line));
    add.disabled = rows.length >= ROUTES_MAX;
    for (const tr of body.children) if (tr.mark) tr.mark();
  }
  current = paint;

  function line(r) {
    const tr = el('tr');
    tr.inputs = [];
    tr.mark = () => {
      const p = blank(r) ? {} : routeRowProblems(r);
      const gw = !p.gw && !blank(r) ? routeGatewayProblem(r.gw) : null;
      for (const input of tr.inputs) {
        const why = input.dataset.col === 'gw' ? p.gw || gw : p.dest;
        input.classList.toggle('invalid', !!why);
        input.title = why || input.dataset.tip;
      }
    };
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
        paint();
        onChange(routesSerialise(rows));
      };
      tr.inputs.push(input);
      const td = el('td');
      td.append(input);
      tr.append(td);
    }
    const rm = el('button', 'danger-quiet', 'Remove');
    rm.type = 'button';
    rm.setAttribute('aria-label', 'Remove this route');
    rm.onclick = () => {
      rows.splice(rows.indexOf(r), 1);
      draw();
      onChange(routesSerialise(rows));
    };
    const td = el('td');
    td.append(rm);
    tr.append(td);
    return tr;
  }

  function draw() {
    body.textContent = '';
    for (const r of rows) body.append(line(r));
    paint();
  }

  add.onclick = () => {
    rows.push({ dest: '', gw: '' });
    draw();
    const last = body.children[body.children.length - 1];
    if (last && last.inputs) last.inputs[0].focus();
  };

  const table = el('table', 'fme-table routes-table');
  const head = el('tr');
  for (const [, label] of COLS) head.append(el('th', null, label));
  head.append(el('th'));
  const thead = el('thead');
  thead.append(head);
  table.append(thead, body);
  /* The table sits in a line of its own, so the row can put its tags beside it
     (config.js renderRow), level with the first row of inputs. */
  const tableLine = el('div', 'fme-tableline');
  tableLine.append(table);
  box.append(tableLine, msg, add);
  box.tableLine = tableLine;
  draw();
  return box;
}

export { renderRoutesEditor };
