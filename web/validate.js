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
/*
 * The management address and its netmask are judged together, as network.sh
 * judges them at every boot (and src/mib.c, lan_pair_refusal, on the daemon
 * side): an address that is the network or broadcast address of its mask is
 * refused. The other half is the pending edit, else the stored value, else
 * the /24 network.sh assumes for a missing mask. Null when fine, or when the
 * other half is itself unusable (it has its own message).
 */
const LAN_PAIRS = {
  LAN_IP_ADDR: ['LAN_SUBNET', true], LAN_SUBNET: ['LAN_IP_ADDR', false],
  LAN_IP_ADDR2: ['LAN_SUBNET2', true], LAN_SUBNET2: ['LAN_IP_ADDR2', false],
};
function quadOf(v) {
  const o = String(v).split('.');
  if (o.length !== 4 || !o.every((x) => /^(0|[1-9]\d{0,2})$/.test(x) && Number(x) <= 255)) return null;
  return o.map(Number);
}
/* Where a rule looks for the other half of a pair: the pending edits, then the
   stored values. Restore passes its own, so a backup is judged as a whole. */
const defaultCtx = { get: (k) => (EDITS.has(k) ? EDITS.get(k) : S.VALUES[k]) };

function hostMaskProblem(name, raw, ctx = defaultCtx) {
  const pair = LAN_PAIRS[name];
  if (!pair) return null;
  const [other, isAddr] = pair;
  let o = ctx.get(other);
  if (isAddr && !o) o = '255.255.255.0';
  if (!o) return null;
  const ip = quadOf(isAddr ? raw : o);
  const mk = quadOf(isAddr ? o : raw);
  if (!ip || !mk) return null;
  if (ip[0] < 1 || ip[0] > 223 || ip[0] === 127) return null;
  const inv = (~(((mk[0] << 24) | (mk[1] << 16) | (mk[2] << 8) | mk[3]) >>> 0)) >>> 0;
  if (mk[0] !== 255 || (inv & (inv + 1)) !== 0 || (inv & 3) !== 3) return null;
  const host = ip.map((x, i) => x & (255 - mk[i]));
  const zero = host.every((x) => x === 0);
  const ones = host.every((x, i) => x === 255 - mk[i]);
  if (!zero && !ones) return null;
  return isAddr
    ? 'the network or broadcast address of the netmask, which no host can use'
    : 'a netmask that makes the management address its network or broadcast address';
}

/*
 * Rules that name one key and a fact about another (src/routes.c, key_refusal,
 * is the daemon's copy):
 *  - OMCI_VEIP_SLOT_ID: omcid takes 2 to 254 and not 128, and logs "ignored"
 *    otherwise; the range in meta.tsv cannot leave a hole in it.
 *  - The second management address must differ from the first while it is on:
 *    network.sh then refuses to add it twice and says so only in a log.
 */
function keyRuleProblem(name, raw, ctx = defaultCtx) {
  if (name === 'OMCI_VEIP_SLOT_ID') {
    return /^\d+$/.test(raw) && Number(raw) === 128
      ? 'slot 128 is not usable: omcid ignores it (2 to 254, not 128)' : null;
  }
  if (!['LAN_IP_ADDR', 'LAN_IP_ADDR2', 'LAN_ENABLE_IP2'].includes(name)) return null;
  const val = (k, def) => {
    const v = k === name ? raw : ctx.get(k);
    return v === undefined || v === '' ? def : v;
  };
  if (val('LAN_ENABLE_IP2', '0') === '1' && val('LAN_IP_ADDR2', '') !== ''
      && val('LAN_IP_ADDR', '192.168.1.1') === val('LAN_IP_ADDR2', '')) {
    return 'the same as the other management address: the second address would silently not be added';
  }
  return null;
}

/* host or host:port for busybox ntpd -p and syslogd -R (src/mib.c, hostport). */
const HOSTPORT_HELP = 'must be a host or host:port: letters, digits, dots and hyphens, '
  + 'port 1\u201365535, no spaces or quotes';
function hostportProblem(raw) {
  const m = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(raw);
  if (!m || m[1].length > 253 || (m[2] !== undefined && (Number(m[2]) < 1 || Number(m[2]) > 65535))) {
    return HOSTPORT_HELP;
  }
  if (/^[0-9.]+$/.test(m[1])) {
    return quadOf(m[1]) ? null : 'a name of digits and dots must be a whole IPv4 address, like 192.0.2.1';
  }
  if (!m[1].split('.').every((l) => /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(l))) {
    return 'each part of a name is 1 to 63 letters, digits or hyphens, and does not start or end with a hyphen';
  }
  return null;
}

/* The three characters flash refuses, and anything that is not printable. */
const BAD_TEXT = /["<&]/;
function textProblem(raw, max) {
  if (!/^[\x20-\x7e]*$/.test(raw)) return 'printable ASCII only (no accents, tabs or line breaks)';
  if (BAD_TEXT.test(raw)) return 'a quote, < or & cannot be stored';
  if (raw.length > max) return `at most ${max} characters`;
  return null;
}

function valueProblem(row, raw, ctx = defaultCtx) {
  /* hostport keys (SYSLOG_SERVER, NTP_SERVER), ascii14 (ONU_HW_VERSION) and
     fixedme (OMCI_FIXED_ME) are odi-only and empty clears them. */
  if (['hostport', 'ascii14', 'fixedme'].includes(row.type) && raw === '') return null;
  if (raw === '' || raw === undefined) {
    return 'cannot be empty \u2014 flash set refuses to clear a key';
  }
  if (row.type === 'int') {
    if (!/^\d+$/.test(raw)) return 'must be a whole number';
    if (raw.length > 10 || Number(raw) > 4294967295) return 'at most 4294967295 (10 digits)';
  }
  if (row.type === 'ipv4' && !quadOf(raw)) {
    return 'must be four numbers 0\u2013255 separated by dots, without leading zeros';
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
    const pairBad = hostMaskProblem(row.name, raw, ctx);
    if (pairBad) return pairBad;
  }
  if (row.type === 'hostport') {
    const bad = hostportProblem(raw);
    if (bad) return bad;
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
  if (row.type === 'elanmac' && !/^[0-9a-fA-F]{12}$/.test(raw)) {
    return 'must be 12 hex digits, no separators';
  }
  if (row.type === 'elanmac' && (parseInt(raw[1], 16) & 1)) {
    return 'a multicast address (the second digit must be even); the stick cannot use it';
  }
  if (row.type === 'elanmac' && /^0+$/.test(raw)) return 'all zeros is not an address';
  if (row.type === 'gponsn' && !/^[\x21-\x7e]{4}[0-9a-fA-F]{8}$/.test(raw)) {
    return 'four characters of vendor id and eight hex digits, 12 in all';
  }
  if (row.type === 'gponsn' && /["<&]/.test(raw)) return 'a quote, < or & cannot be stored';
  if (row.type === 'hex20' && !/^[0-9a-fA-F]{20}$/.test(raw)) {
    return 'must be exactly 20 hex digits (10 bytes)';
  }
  const strN = /^str(\d+)$/.exec(row.type);
  if (strN) {
    const bad = textProblem(raw, Number(strN[1]));
    if (bad) return bad;
  }
  if (row.type === 'string') {
    const bad = textProblem(raw, 255);
    if (bad) return bad;
  }
  if (row.type === 'hex32' && !/^[0-9a-fA-F]{32}$/.test(raw)) {
    return 'must be 32 hex digits';
  }
  if (row.type === 'hexascii' && !/^([0-9a-fA-F]{2})+$/.test(raw)) {
    return 'must be hex, a whole number of bytes';
  }

  const m = S.META[row.name];
  const rule = keyRuleProblem(row.name, raw, ctx);
  if (rule) return rule;
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

/*
 * The inputs that are not config keys. Each mirrors the rule of the same name
 * in src/routes.c, src/omci.c or src/http.c, and scripts/fixtures/
 * validation-vectors.tsv holds the accepted and refused examples that both
 * layers are checked against, so the two cannot drift apart unnoticed.
 */

/* The sign-in for this page (set_credential in src/http.c). `again` is the
   repeat field; the daemon never sees it. */
function passwordProblem(user, pass, again) {
  if (user === '') return 'the username must be 1 to 64 characters';
  if (user.includes(':')) return 'the username cannot contain a colon';
  if (/[^\x21-\x7e]/.test(user)) return 'the username must be printable, with no spaces';
  if (user.length > 64) return 'the username must be 1 to 64 characters';
  if (/[^\x20-\x7e]/.test(pass)) return 'the password must be printable ASCII';
  if (pass.length < 4 || pass.length > 128) return 'the password must be 4 to 128 characters';
  if (again !== undefined && again !== pass) return 'the two passwords are not the same';
  return null;
}

/* One OpenSSH public key line (sshkey_refusal in src/routes.c). `existing` is
   the lines already on the stick, for the duplicate. */
const SSH_TYPES = ['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521', 'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com'];
const SSH_SHAPE = 'not an OpenSSH public key line: paste the whole contents of the .pub file, '
  + 'TYPE BLOB and an optional comment, one line (ssh-ed25519, ssh-rsa, ecdsa-sha2-nistp256/384/521 '
  + 'or an sk- type)';
function sshKeyProblem(line, existing = []) {
  if (line.length > 1000) return 'a key line is at most 1000 characters; a public key is far shorter, so this is not one';
  if (/[^\x20-\x7e]/.test(line)) {
    return 'a key is one line of printable text; remove the line breaks and anything that is not plain text';
  }
  const sp = line.indexOf(' ');
  const type = sp < 0 ? line : line.slice(0, sp);
  if (sp < 0 || !SSH_TYPES.includes(type)) return SSH_SHAPE;
  const blob = line.slice(sp + 1).split(' ')[0];
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(blob) || blob.length < 68 || blob.length % 4) return SSH_SHAPE;
  let bytes;
  try { bytes = atob(blob); } catch (e) { return SSH_SHAPE; }
  /* A run of length-prefixed strings, the type name first (RFC 4253, 6.6):
     it must add up exactly and name the type it was declared with. */
  let pos = 0;
  let fields = 0;
  while (pos < bytes.length) {
    if (pos + 4 > bytes.length) return SSH_SHAPE;
    const l = (bytes.charCodeAt(pos) * 16777216) + (bytes.charCodeAt(pos + 1) << 16)
      + (bytes.charCodeAt(pos + 2) << 8) + bytes.charCodeAt(pos + 3);
    pos += 4;
    if (!l || l > bytes.length - pos) return SSH_SHAPE;
    if (!fields) {
      if (l !== type.length) return SSH_SHAPE;
      if (bytes.slice(pos, pos + l) !== type) {
        return 'the key says one type outside and another inside; paste the line as ssh-keygen printed it';
      }
    }
    pos += l;
    fields += 1;
  }
  if (fields < 2) return SSH_SHAPE;
  if (existing.some((l) => { const f = String(l).split(' '); return f[0] === type && f[1] === blob; })) {
    return 'that key is already in the list';
  }
  return null;
}

/* The address a ping goes to (/api/ping): one a host can have, not a name. */
function pingProblem(host) {
  const q = quadOf(host);
  if (!q || q[0] < 1 || q[0] > 223 || q[0] === 127) {
    return 'an IPv4 address like 192.168.1.254, and only an address (no name, no leading zeros)';
  }
  return null;
}

/* The MIB browser (/api/omci): a class id or table name, and a 16-bit entity. */
function meProblem(me) {
  if (!/^[A-Za-z0-9_]{1,39}$/.test(me)) return 'a class id (1 to 65535) or a table name: letters, digits and _';
  if (/^\d+$/.test(me) && (Number(me) < 1 || Number(me) > 65535)) return 'a class id is 1 to 65535';
  return null;
}
function entityProblem(entity) {
  if (entity === '') return null;
  return /^(0[xX])?[0-9a-fA-F]{1,4}$/.test(entity) ? null : 'an entity id is hex, up to 4 digits (0 to ffff), or empty for all';
}

/* The firmware upload: the same ceiling as UPLOAD_MAX in src/confd.h (make
   check compares them), and the tar header the daemon looks for. */
const UPLOAD_MAX = 6 * 1024 * 1024;
function uploadSizeProblem(size) {
  if (!size) return 'that file is empty';
  if (size > UPLOAD_MAX) return `an image is a few MB; this is ${(size / 1048576).toFixed(1)} MiB, and the limit is 6 MiB`;
  return null;
}
function tarProblem(head) {
  const u = head instanceof Uint8Array ? head : new Uint8Array(head);
  const magic = String.fromCharCode(...u.slice(257, 262));
  return u.length >= 512 && u[0] && magic === 'ustar'
    ? null : 'that is not a tar archive; an image is the .tar that make image builds';
}

/* A backup is the `flash all` dump, tens of KB. */
const RESTORE_MAX = 1024 * 1024;
function restoreSizeProblem(size) {
  return size > RESTORE_MAX ? `a backup is a few tens of KB; this file is ${(size / 1048576).toFixed(1)} MiB` : null;
}

export {
  rangeBad, valueProblem, hostMaskProblem, keyRuleProblem, hostportProblem, hexAscii, validateInput, invalidEdits,
  passwordProblem, sshKeyProblem, pingProblem, meProblem, entityProblem, uploadSizeProblem, tarProblem,
  restoreSizeProblem, UPLOAD_MAX, RESTORE_MAX,
  fixedMeRowProblem, fixedMeRowProblems, fixedMeSetProblem, fixedMeParse, fixedMeSerialise, FME_MAX_ENTRIES,
};
