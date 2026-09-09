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

export { S, EDITS, provenance, applyOf, dependsUnmet };
