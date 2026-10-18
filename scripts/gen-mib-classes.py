#!/usr/bin/env python3
"""
Regenerate the class list of the MIB browser inside web/mebrowser.js.

The browser lists every managed entity class with its class id, the table name
omcicli takes, and the entity's official name. odi-oss already recovers all
three from the stock firmware's OMCI plugins (src/omci/tools/mib-tables.py),
so the list is read from its generated model rather than typed here:

    scripts/gen-mib-classes.py <odi-oss>/src/omci/generated/omci_mib.json

The rows are written between the BEGIN/END GENERATED markers of
web/mebrowser.js, in place, and the header there records which odi-oss commit
they came from (read with `git -C` when the model sits in a checkout). They
live in the page's own module on purpose: a file of its own would need a route
in src/http.c and a place in the asset lists of every deploy path, and a
browser that got the page without it would lose the whole tab.

With --check nothing is written; the exit status says whether the file is
already what this model would produce.
"""
import json
import os
import re
import subprocess
import sys

TARGET = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "mebrowser.js")
BEGIN = "/* BEGIN GENERATED: scripts/gen-mib-classes.py */"
END = "/* END GENERATED */"


def js(text):
    return "'" + text.replace("\\", "\\\\").replace("'", "\\'") + "'"


def source_of(path):
    """odi-oss path and commit, for the header. The commit is only the model's
    checkout HEAD: say so when the file has local changes."""
    full = os.path.abspath(path)
    root = os.path.dirname(full)
    try:
        top = subprocess.check_output(["git", "-C", root, "rev-parse", "--show-toplevel"],
                                      text=True, stderr=subprocess.DEVNULL).strip()
        rev = subprocess.check_output(["git", "-C", top, "rev-parse", "--short", "HEAD"], text=True).strip()
        rel = os.path.relpath(full, top)
        dirty = subprocess.run(["git", "-C", top, "diff", "--quiet", "HEAD", "--", rel]).returncode != 0
        return "odi-oss %s at %s%s" % (rel, rev, " (with local changes)" if dirty else "")
    except (subprocess.CalledProcessError, OSError):
        return "odi-oss src/omci/generated/omci_mib.json"


def block(model_path):
    with open(model_path) as fh:
        model = json.load(fh)
    rows = []
    for entry in model:
        t = entry["table"]
        desc = t.get("desc")
        if not desc:
            sys.exit("class %s (%s) has no desc: regenerate odi-oss omci_mib.json" % (t["classId"], t["name"]))
        rows.append((t["classId"], t["name"], desc))
    rows.sort(key=lambda r: r[0])
    out = [BEGIN,
           "/* From " + source_of(model_path) + ". [class id, table name, official name] */",
           "const CLASSES = ["]
    out += ["  [%d, %s, %s]," % (c, js(n), js(d)) for c, n, d in rows]
    out += ["];", END]
    return "\n".join(out)


def main():
    args = [a for a in sys.argv[1:] if a != "--check"]
    if len(args) != 1:
        sys.exit("usage: gen-mib-classes.py [--check] <omci_mib.json>")
    with open(TARGET) as fh:
        page = fh.read()
    a, b = page.find(BEGIN), page.find(END)
    if a < 0 or b < a:
        sys.exit("markers not found in web/mebrowser.js")
    new = page[:a] + block(args[0]) + page[b + len(END):]
    if "--check" in sys.argv:
        # The header names a commit, which a re-run on another checkout changes: compare rows only.
        strip = lambda s: re.sub(r"/\* From [^\n]*\*/", "", s)
        sys.exit(0 if strip(new) == strip(page) else 1)
    with open(TARGET, "w") as fh:
        fh.write(new)


main()
