/*
 * What a value has to satisfy before it is worth sending.
 *
 * These mirror the daemon's checks rather than replacing them: anything
 * reachable over HTTP is validated there too, since a request need not come
 * from this page. What they buy is telling the user before the write instead of
 * after it.
 */

import { S, EDITS, dependsUnmet } from './state.js';

function rangeBad(row, raw) {
  const m = S.META[row.name];
  if (!m || !m.range || raw === '' || raw === undefined) return null;
  const [lo, hi] = m.range.split('-').map(Number);
  const n = Number(raw);
  if (!Number.isFinite(n) || n < lo || n > hi) return `outside ${lo}\u2013${hi}`;
  return null;
}

/*
 * OMCI_FIXED_ME, the grammar the daemon and omcid both hold to. Up to 16
 * entries separated by commas or spaces, in two forms:
 *
 *   CLASS:HEX                     any instance of the class, not in the MIB
 *                                 upload (the legacy form, "any" below)
 *   CLASS:INSTANCE:ATTR:HEX       one attribute of the entity at INSTANCE
 *
 * CLASS is decimal 1-65535, INSTANCE decimal or 0x hex 0-65535, ATTR decimal
 * 1-16, HEX 1 to 25 bytes with an optional 0x. A row is the entry before it
 * is spelled out: {cls, inst, attr, hex} as typed, inst and attr 'any' (or
 * empty) for the legacy form.
 */
const FME_MAX_ENTRIES = 16;
const isAny = (v) => v === '' || String(v).toLowerCase() === 'any';

/* What is wrong with each field of a row: {cls, inst, attr, hex} reasons,
   the fields that are fine absent. */
function fixedMeRowProblems(r) {
  const p = {};
  if (!/^\d{1,5}$/.test(r.cls) || Number(r.cls) < 1 || Number(r.cls) > 65535) {
    p.cls = 'class: a decimal number, 1\u201365535';
  }
  if (isAny(r.inst) !== isAny(r.attr)) {
    const both = 'instance and attribute are either both \u201cany\u201d or both set';
    if (isAny(r.inst)) p.inst = both; else p.attr = both;
  } else if (!isAny(r.inst)) {
    const hexInst = /^0[xX][0-9a-fA-F]{1,4}$/.test(r.inst);
    if (!hexInst && !(/^\d{1,5}$/.test(r.inst) && Number(r.inst) <= 65535)) {
      p.inst = 'instance: 0\u201365535, decimal or 0x hex';
    }
    if (!/^\d{1,2}$/.test(r.attr) || Number(r.attr) < 1 || Number(r.attr) > 16) {
      p.attr = 'attribute: a decimal number, 1\u201316';
    }
  }
  if (!/^(0[xX])?([0-9a-fA-F]{2}){1,25}$/.test(r.hex)) {
    p.hex = 'bytes: hex of 1 to 25 bytes (an even count of digits)';
  }
  return p;
}

/* The first thing wrong with a row, or null. */
const fixedMeRowProblem = (r) => Object.values(fixedMeRowProblems(r))[0] || null;

const instNum = (i) => (/^0[xX]/.test(i) ? parseInt(i.slice(2), 16) : Number(i));

/* What is wrong between rows that are each fine, or null: too many, a class
   in both forms, a class twice in the legacy form, a slot twice. */
function fixedMeSetProblem(rows) {
  if (rows.length > FME_MAX_ENTRIES) return `at most ${FME_MAX_ENTRIES} entries`;
  const seen = new Map();
  for (const r of rows) {
    const cls = Number(r.cls);
    const slot = isAny(r.inst) ? 'any' : instNum(r.inst) + ':' + Number(r.attr);
    const prev = seen.get(cls) || new Set();
    if (prev.has(slot)) {
      return slot === 'any' ? `class ${cls} is listed twice`
        : `class ${cls}, instance ${slot.split(':')[0]}, attribute ${slot.split(':')[1]} is listed twice`;
    }
    if ((slot === 'any' && prev.size) || (slot !== 'any' && prev.has('any'))) {
      return `class ${cls} is in both forms: all instances, and a single instance`;
    }
    prev.add(slot);
    seen.set(cls, prev);
  }
  return null;
}

/* The key's string as rows; each row also carries `bad`, the reason its entry
   does not parse (a wrong number of colons), null when it does. */
function fixedMeParse(raw) {
  if (!raw) return [];
  return raw.split(/[ ,]+/).filter((e) => e !== '').map((e) => {
    const f = e.split(':');
    if (f.length === 2) return { cls: f[0], inst: 'any', attr: 'any', hex: f[1], bad: null };
    if (f.length === 4) return { cls: f[0], inst: f[1], attr: f[2], hex: f[3], bad: null };
    return { cls: f[0], inst: '', attr: '', hex: f.slice(1).join(':'), bad: 'not CLASS:HEX or CLASS:INSTANCE:ATTR:HEX' };
  });
}

/* Rows back to the key's string. Typed text goes out as typed, so a row that
   is not complete yet makes a string the check refuses, not a silent one. */
function fixedMeSerialise(rows) {
  return rows.filter((r) => !(r.cls === '' && isAny(r.inst) && isAny(r.attr) && r.hex === ''))
    .map((r) => (isAny(r.inst) && isAny(r.attr) ? `${r.cls}:${r.hex}` : `${r.cls}:${r.inst}:${r.attr}:${r.hex}`))
    .join(',');
}

const FME_HELP = `up to ${FME_MAX_ENTRIES} entries, CLASS:HEX or CLASS:INSTANCE:ATTR:HEX, separated by commas or spaces`;

function fixedMeProblem(raw) {
  if (raw === '') return null;
  if (!/^[^ ,]+([ ,]+[^ ,]+)*$/.test(raw)) return 'a separator with no entry beside it; ' + FME_HELP;
  const rows = fixedMeParse(raw);
  for (const [n, r] of rows.entries()) {
    const why = r.bad || fixedMeRowProblem(r);
    if (why) return `entry ${n + 1}: ${why}`;
  }
  return fixedMeSetProblem(rows);
}

/*
 * Everything wrong with a value, in one place, so the field marking and the
 * Save gate cannot disagree about what is acceptable.
 *
 * These checks mirror the daemon's rather than replacing them — anything
 * reachable over HTTP is validated there too, since a request need not come
 * from this page. What they buy is telling the user before the write instead of
 * after it.
 */
function valueProblem(row, raw) {
  /* hostport keys (SYSLOG_SERVER, NTP_SERVER), ascii14 (ONU_HW_VERSION) and
     fixedme (OMCI_FIXED_ME) are odi-only and empty clears them. */
  if (['hostport', 'ascii14', 'fixedme'].includes(row.type) && raw === '') return null;
  if (raw === '' || raw === undefined) {
    return 'cannot be empty \u2014 flash set refuses to clear a key';
  }
  if (row.type === 'int' && !/^\d+$/.test(raw)) return 'must be a whole number';
  if (row.type === 'ipv4') {
    const oct = raw.split('.');
    if (oct.length !== 4 || !oct.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)) {
      return 'must be four numbers 0\u2013255 separated by dots';
    }
  }
  if (row.type === 'ipv4host' || row.type === 'netmask') {
    /* Four numbers, no leading zeros (busybox ifconfig reads 010 as octal). */
    const oct = raw.split('.');
    if (oct.length !== 4 || !oct.every((o) => /^(0|[1-9]\d{0,2})$/.test(o) && Number(o) <= 255)) {
      return 'must be four numbers 0–255 separated by dots, without leading zeros';
    }
    const n = oct.map(Number);
    if (row.type === 'ipv4host' && (n[0] < 1 || n[0] > 223 || n[0] === 127)) {
      return 'not an address the stick can use (it must start with 1–223, not 127)';
    }
    if (row.type === 'netmask') {
      const m = ((n[0] << 24) | (n[1] << 16) | (n[2] << 8) | n[3]) >>> 0;
      const inv = (~m) >>> 0;
      if ((inv & (inv + 1)) !== 0 || n[0] !== 255 || (m & 3) !== 0) {
        return 'not a netmask the stick can use: ones then zeros, from /8 to /30 (255.255.255.0)';
      }
    }
  }
  if (row.type === 'hostport') {
    const m = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(raw);
    if (!m || /^[.-]|[.-]$/.test(m[1]) || m[1].length > 253
        || (m[2] !== undefined && (Number(m[2]) < 1 || Number(m[2]) > 65535))) {
      return 'must be a host or host:port: letters, digits, dots and hyphens, '
        + 'port 1\u201365535, no spaces or quotes';
    }
  }
  if (row.type === 'ascii14' && !/^[\x20-\x7e]{1,14}$/.test(raw)) {
    return 'at most 14 printable ASCII characters';
  }
  if (row.type === 'ascii14' && /["<&]/.test(raw)) {
    return 'a quote, < or & cannot be stored';
  }
  if (row.type === 'fixedme') return fixedMeProblem(raw);
  if (row.type === 'mac' && !/^[0-9a-fA-F]{12}$/.test(raw)) {
    return 'must be 12 hex digits, no separators';
  }
  if (row.type === 'mac' && (parseInt(raw[1], 16) & 1)) {
    return 'a multicast address (the second digit must be even); the stick cannot use it';
  }
  if (row.type === 'mac' && /^0+$/.test(raw)) return 'all zeros is not an address';
  if (row.type === 'gponsn' && !/^[\x21-\x7e]{4}[0-9a-fA-F]{8}$/.test(raw)) {
    return 'four characters of vendor id and eight hex digits, 12 in all';
  }
  if (row.type === 'gponsn' && /["<&]/.test(raw)) return 'a quote, < or & cannot be stored';
  if (row.type === 'hex20' && !/^[0-9a-fA-F]{20}$/.test(raw)) {
    return 'must be exactly 20 hex digits (10 bytes)';
  }
  const strN = /^str(\d+)$/.exec(row.type);
  if (strN) {
    if (!/^[\x20-\x7e]*$/.test(raw)) return 'printable ASCII only';
    if (/["<&]/.test(raw)) return 'a quote, < or & cannot be stored';
    if (raw.length > Number(strN[1])) return `at most ${strN[1]} characters`;
  }
  if (row.type === 'hex32' && !/^[0-9a-fA-F]{32}$/.test(raw)) {
    return 'must be 32 hex digits';
  }
  if (row.type === 'hexascii' && !/^([0-9a-fA-F]{2})+$/.test(raw)) {
    return 'must be hex, a whole number of bytes';
  }

  const m = S.META[row.name];
  if (m && m.options) {
    const allowed = m.options.split('|').map((p) => p.slice(0, p.indexOf('=')));
    if (!allowed.includes(raw)) return 'not one of: ' + allowed.join(', ');
  }
  return rangeBad(row, raw);
}

/*
 * Some keys hold the hex of an ASCII string — GPON_PLOAM_PASSWD keeps
 * "1234567890" as 31323334353637383930. Show the readable form, keeping the hex
 * alongside since that is what the device stores and what you would type back.
 *
 * Driven by the schema type, never sniffed: INT1 holds 2147483647, which is
 * valid hex decoding to '!GH6G', so a heuristic would mangle plain integers.
 * A PLOAM password is 10 arbitrary octets by standard and is not required to be
 * printable, so a value that is not stays hex.
 */
function hexAscii(hex) {
  if (!hex) return null;
  if (hex.length % 2 || /[^0-9a-fA-F]/.test(hex)) return null;
  let out = '';
  for (let i = 0; i < hex.length; i += 2) {
    const c = parseInt(hex.slice(i, i + 2), 16);
    if (c < 0x20 || c > 0x7e) return null;
    out += String.fromCharCode(c);
  }
  return out;
}

function validateInput(row, input) {
  /* Only mark what the user is actually proposing. A value the device already
     holds that falls outside its option list is shown as it is, not scolded. */
  const bad = EDITS.has(row.name) ? valueProblem(row, input.value) : null;
  input.classList.toggle('invalid', !!bad);
  input.title = bad || '';
  return !bad;
}

/* Every queued edit that the daemon would refuse, as [name, why] pairs. */
function invalidEdits() {
  const out = [];
  for (const [name, v] of EDITS) {
    const row = S.SCHEMA.find((r) => r.name === name);
    /* The page does not offer a key the firmware ignores; an edit to one can
       only be left over, and is refused rather than saved for nothing. */
    const unmet = row && dependsUnmet(row);
    const why = unmet ? 'ignored by the firmware unless ' + unmet.join(' and ')
      : row && valueProblem(row, v);
    if (why) out.push([name, why]);
  }
  return out;
}

export {
  rangeBad, valueProblem, hexAscii, validateInput, invalidEdits,
  fixedMeRowProblem, fixedMeRowProblems, fixedMeSetProblem, fixedMeParse, fixedMeSerialise, FME_MAX_ENTRIES,
};
