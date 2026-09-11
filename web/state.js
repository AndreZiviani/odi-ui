/*
 * The data the page renders from, and the three questions asked of it: where a
 * value came from, what applying it costs, and whether the firmware is
 * currently ignoring it.
 *
 * One module because every other one reads it and the bootstrap fills it once.
 * Held behind an object rather than exported as bare `let`s: the bootstrap
 * REPLACES these (SCHEMA is reassigned, not appended to), and a destructured
 * import would capture the old empty array.
 */

const S = {
  SCHEMA: [], VALUES: {}, META: {}, CONS: {}, DEFAULTS: {}, BASELINE: {},
  /* mask name -> [{ bit, feature, module }], from /api/features. */
  FEATURES: {},
};

/* Pending edits, keyed by name. Kept out of the DOM so switching tabs or
   re-filtering cannot silently drop a change the user has typed -- and read
   back by renderValue, so a re-render shows the edit rather than the stored
   value. */
const EDITS = new Map();

/*
 * Where a value came from.
 *
 * The image ships only ten defaults in /etc/config_default*.xml; the rest are
 * built into the MIB with no read-only way to read them out. So a key is judged
 * against the image default where one exists, and otherwise against a baseline
 * captured from a stick considered correct. Anything with neither reference is
 * left unlabelled rather than guessed at.
 */
function provenance(row, raw) {
  const name = row.name;
  if (name in S.DEFAULTS) {
    return raw === S.DEFAULTS[name]
      ? { cls: 'default', label: 'image default' }
      : { cls: 'changed', label: 'changed', was: S.DEFAULTS[name], from: 'image default' };
  }
  if (name in S.BASELINE) {
    return raw === S.BASELINE[name]
      ? null
      : { cls: 'changed', label: 'changed', was: S.BASELINE[name], from: 'baseline' };
  }
  return null;
}

/* The apply class, preferring the derived one over the schema's. */
function applyOf(row) {
  return (S.CONS[row.name] || {}).apply || row.apply || 'unknown';
}

/*
 * Whether a key's `depends` condition holds. The firmware ignores some keys
 * unless others are set a particular way — VLAN_MANU_TAG_VID only reaches
 * omci_app when VLAN_CFG_TYPE=1 and VLAN_MANU_MODE=1, and otherwise a sentinel
 * is sent in its place. Saying so is more useful than showing a value that
 * looks live and is not.
 */
function dependsUnmet(row) {
  const m = S.META[row.name];
  if (!m || !m.depends) return null;
  const unmet = m.depends.split('&').filter((c) => {
    const [k, v] = c.split('=');
    return S.VALUES[k] !== v;
  });
  return unmet.length ? unmet : null;
}


/*
 * Decode an OMCI_CUSTOM_* value against the plugins the image actually ships.
 *
 * These four masks are the least documented settings on the device -- the stick
 * arrives with OMCI_CUSTOM_RDP=4 and upstream has an open issue from 2022
 * asking what that means. It is not a mystery: each bit loads one plugin from
 * lib/features, the plugin's filename IS the bit, and the function it defines
 * is the feature. schema/features.tsv is generated from the image's own ELF
 * symbol tables, so this decode is read off the firmware rather than asserted.
 *
 * The value is DECIMAL. `flash set` accepts nothing else, which is worth
 * knowing before you type 0x102 and watch it store 0.
 *
 * Bits with no plugin are reported rather than dropped: a bit set here that
 * this image cannot load does nothing, and that is the useful thing to see.
 */
function decodeMask(name, value) {
  const rows = S.FEATURES[name];
  if (!rows || !rows.length) return null;

  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const n = /^0[xX]/.test(raw) ? Number(raw) : Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;

  const known = [];
  const unknown = [];
  let covered = 0;

  for (let b = 0; b < 31; b++) {
    const bit = 1 << b;
    if (!(n & bit)) continue;
    const hit = rows.filter((r) => Number(r.bit) === bit);
    if (hit.length) {
      known.push({ bit, names: hit.map((r) => r.feature) });
      covered |= bit;
    } else {
      unknown.push(bit);
    }
  }
  return { n, known, unknown, covered };
}

export { S, EDITS, provenance, applyOf, dependsUnmet, decodeMask };
