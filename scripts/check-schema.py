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
import re
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REFUSED = {"LAN_SDS_MODE", "LAN_SPEED_MODE", "FIBER_MODE"}
APPLY_CLASSES = {"restart:omci", "reboot", "immediate", "unknown"}
WRITABLE = {"yes", "never", "identity"}

# Exactly the set type_ok() in src/confd.c implements. It fails CLOSED on
# anything else -- so a typo here is a key that cannot be written at all, which
# is the safe direction but still a bug, and one nothing else would report.
# Keep the two in step: adding a type means adding it in both places.
TYPES = {"int", "ipv4", "mac", "hex32", "hexascii", "hostport", "ascii14", "string"}

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
sett = load("settings.tsv", 6)

# settings.tsv, the image's own view. The classes are the four the page
# labels; the actions are the three apply.sh and the reboot button perform.
SETT_CLASSES = {"live", "restart", "internet", "reboot"}
SETT_ACTIONS = {"network", "omci", "syslog", "ntp", "reboot", "none"}

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
meta_names = [r[0] for r in meta]
for dup in sorted({n for n in meta_names if meta_names.count(n) > 1}):
    # The browser keeps the last row, so the first is dead text nobody sees.
    note(dup, "has more than one metadata row")
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

# --- settings.tsv ----------------------------------------------------------
sett_names = [r[0] for r in sett]
for name, apply_, action, pair, reader, note_ in sett:
    if name not in names:
        note(name, "is in settings.tsv but not in the schema")
    elif by_name[name][6] == "never":
        note(name, "is in settings.tsv but never writable")
    if apply_ not in SETT_CLASSES:
        note(name, f"settings apply {apply_!r} is not one of {sorted(SETT_CLASSES)}")
    if action not in SETT_ACTIONS:
        note(name, f"settings action {action!r} is not one of {sorted(SETT_ACTIONS)}")
    # The class is what the page promises; the action is what it does. A key
    # labelled live that needs a reboot, or the reverse, is a UI that lies.
    # live/omci is a key omcid rebuilds in place on SIGHUP; live/none one it
    # reads each time it is used, with nothing to run.
    if (apply_, action) not in {("live", "network"), ("live", "omci"),
                                ("live", "none"), ("internet", "omci"),
                                ("reboot", "reboot"), ("restart", "syslog"),
                                ("restart", "ntp")}:
        note(name, f"class {apply_!r} does not match action {action!r}")
    if pair and pair not in sett_names:
        note(name, f"pair {pair!r} is not itself in settings.tsv")
    if pair == name:
        note(name, "is paired with itself")
    if not reader or not note_:
        note(name, "needs a reader and a note")
if len(sett_names) != len(set(sett_names)):
    note("settings.tsv", "a key appears twice")

# --- the daemon's buffers ----------------------------------------------------
# confd reads each table whole into a fixed buffer (src/buffers.c) and
# read_file() stops, without an error, one byte short of it. A table that
# outgrows its buffer loses its last rows on the device only: their options,
# ranges and help vanish, and the checks above, which read the file, still
# pass. Each file must fit every buffer it is read into (src/routes.c).
READS_INTO = {
    "keys.tsv": ["schema"],
    "meta.tsv": ["meta", "schema"],
    "consumers.tsv": ["cons", "schema"],
    "settings.tsv": ["sett"],
    "features.tsv": ["schema"],
}
bufsrc = os.path.join(HERE, "src", "buffers.c")
sizes = {m.group(1): int(m.group(2))
         for m in re.finditer(r"^char (\w+)\[(\d+)\];", open(bufsrc).read(), re.M)}
for fname, bufs in READS_INTO.items():
    path = os.path.join(HERE, "schema", fname)
    if not os.path.exists(path):
        continue
    size = os.path.getsize(path)
    for b in bufs:
        if b not in sizes:
            note(fname, f"buffer {b!r} is not in src/buffers.c")
        elif size >= sizes[b]:
            note(fname, f"{size} bytes does not fit {b}[{sizes[b]}]: confd would drop its tail")

# --- report ----------------------------------------------------------------
if problems:
    for p in problems:
        print(f"  {p}")
    print(f"\n{len(problems)} problem(s)")
    sys.exit(1)

print(f"consistent: {len(keys)} keys, {len(meta)} with guidance, "
      f"{len(cons)} classified, {len(sett)} used by this image")
