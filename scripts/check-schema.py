#!/usr/bin/env python3
"""
Check the data files against each other, without a device.

The schema is generated and the metadata is hand-written, which is the right
split but means the hand-written half can drift silently. A `depends` naming a
key that does not exist makes the UI say "needs FOO=1" forever; a malformed
`options` pair renders a blank dropdown; a `meta` row for a key the device does
not have is simply never seen. None of those fail loudly on their own.

    scripts/check-schema.py

Exits non-zero on anything that would mislead someone reading the UI.
"""
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REFUSED = {"LAN_SDS_MODE", "LAN_SPEED_MODE", "FIBER_MODE"}
APPLY_CLASSES = {"restart:omci", "reboot", "immediate", "unknown"}
WRITABLE = {"yes", "never", "identity"}

# Exactly the set type_ok() in src/confd.c implements. It fails CLOSED on
# anything else -- so a typo here is a key that cannot be written at all, which
# is the safe direction but still a bug, and one nothing else would report.
# Keep the two in step: adding a type means adding it in both places.
TYPES = {"int", "ipv4", "mac", "hex32", "hexascii", "string"}

problems = []


def note(where, msg):
    problems.append(f"{where}: {msg}")


def load(name, cols):
    path = os.path.join(HERE, "schema", name)
    if not os.path.exists(path):
        note(name, "missing")
        return []
    rows = []
    for n, line in enumerate(open(path, encoding="utf-8"), 1):
        line = line.rstrip("\n")
        if not line or line.startswith("#") or line.startswith("name\t"):
            continue
        f = line.split("\t")
        if len(f) != cols:
            note(f"{name}:{n}", f"{len(f)} fields, expected {cols}")
            continue
        rows.append(f)
    return rows


keys = load("keys.tsv", 8)
meta = load("meta.tsv", 6)
cons = load("consumers.tsv", 3)

names = {r[0] for r in keys}
if not names:
    print("no schema to check", file=sys.stderr)
    sys.exit(1)

# --- keys.tsv ---------------------------------------------------------------
for name, store, addr, section, typ, apply_, writable, common in keys:
    if store not in ("cs", "hs"):
        note(name, f"store {store!r} is neither cs nor hs")
    if "[" in addr:
        # The display form resolves to a DIFFERENT entry and exits 0, so this
        # would write the wrong setting while reporting success.
        note(name, f"address {addr!r} is in display form, not dotted")
    if apply_ not in APPLY_CLASSES:
        note(name, f"apply {apply_!r} is not a known class")
    if typ not in TYPES:
        note(name, f"type {typ!r} is not a type the daemon implements")
    if writable not in WRITABLE:
        note(name, f"writable {writable!r} is not a known value")
    if common not in ("yes", "no"):
        note(name, f"common {common!r} is not yes or no")
    if name in REFUSED and writable != "never":
        note(name, "must be marked never-writable")

# --- meta.tsv --------------------------------------------------------------
by_name = {r[0]: r for r in keys}
for name, label, help_, options, depends, rng in meta:
    if name not in names:
        note(name, "has metadata but is not in the schema")
    if not label:
        note(name, "has no label")
    typ = by_name[name][4] if name in by_name else None
    seen = set()
    for pair in filter(None, options.split("|")):
        if "=" not in pair:
            note(name, f"option {pair!r} has no value=label separator")
            continue
        val = pair.split("=", 1)[0]
        # The daemon enforces the option list on write, so a value in it that
        # its own type would reject is a control the UI offers and the device
        # refuses.
        if typ == "int" and not val.isdigit():
            note(name, f"option value {val!r} is not valid for type int")
        if val in seen:
            note(name, f"option value {val!r} appears twice")
        seen.add(val)
    for cond in filter(None, depends.split("&")):
        if "=" not in cond:
            note(name, f"depends {cond!r} is not KEY=VALUE")
            continue
        dep = cond.split("=")[0]
        if dep not in names:
            # Silent in the UI: it would report "needs <typo>=1" forever.
            note(name, f"depends on {dep!r}, which is not a key")
    if rng and options:
        # Both are enforced on write and a value cannot satisfy an enumeration
        # and a range at once without one of them being redundant.
        note(name, "has both an option list and a range")
    if rng and typ not in (None, "int"):
        note(name, f"has a range but type is {typ!r}, not int")
    if rng:
        parts = rng.split("-")
        # A negative lower bound would need different parsing; nothing uses one.
        if len(parts) != 2 or not all(p.isdigit() for p in parts):
            note(name, f"range {rng!r} is not min-max")
        elif int(parts[0]) > int(parts[1]):
            note(name, f"range {rng!r} is inverted")

# --- consumers.tsv ---------------------------------------------------------
cons_names = {r[0] for r in cons}
for name, apply_, readers in cons:
    if name not in names:
        note(name, "has a consumer entry but is not in the schema")
    if apply_ not in APPLY_CLASSES:
        note(name, f"consumer apply {apply_!r} is not a known class")
if cons and names - cons_names:
    missing = sorted(names - cons_names)
    note("consumers.tsv", f"{len(missing)} keys unclassified, e.g. {missing[:3]}")

# --- report ----------------------------------------------------------------
if problems:
    for p in problems:
        print(f"  {p}")
    print(f"\n{len(problems)} problem(s)")
    sys.exit(1)

print(f"consistent: {len(keys)} keys, {len(meta)} with guidance, "
      f"{len(cons)} classified")
