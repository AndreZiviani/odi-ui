#!/usr/bin/env python3
"""
Assert web/ and the daemon's asset table agree, in both directions.

The table in src/http.c is the ONLY set of files confd will serve, and it is a
list of literals so that nothing derived from a request reaches the filesystem.
That safety property costs a second list, and two lists drift:

  a file in web/ with no row      dead weight on a jffs2 partition that is
                                  already half spent, and a module the page
                                  imports but the daemon answers 404 for
  a row with no file              a 404 nobody notices until the page is blank

Neither fails loudly on its own, and neither is visible without a device.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

src = open(os.path.join(HERE, "src", "http.c"), encoding="utf-8").read()
m = re.search(r"const struct web_asset web_assets\[\] = \{(.*?)\n\};", src, re.S)
if not m:
    print("could not find web_assets[] in src/http.c", file=sys.stderr)
    sys.exit(1)

rows = re.findall(r'\{\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\}', m.group(1))
table_files = {f for _, f, _ in rows}
table_urls = [u for u, _, _ in rows]

on_disk = {f for f in os.listdir(os.path.join(HERE, "web"))
           if f.endswith((".js", ".css", ".html"))}

problems = []
for f in sorted(on_disk - table_files):
    problems.append(f"web/{f} is not in web_assets[] — the daemon will 404 it")
for f in sorted(table_files - on_disk):
    problems.append(f"web_assets[] lists {f}, which does not exist in web/")
if len(table_urls) != len(set(table_urls)):
    problems.append("web_assets[] has a duplicate url")

# Every module the page imports must itself be served.
for f in sorted(on_disk):
    if not f.endswith(".js"):
        continue
    body = open(os.path.join(HERE, "web", f), encoding="utf-8").read()
    for dep in re.findall(r"from\s+'\./([A-Za-z0-9_.-]+)'", body):
        if dep not in table_files:
            problems.append(f"web/{f} imports {dep}, which web_assets[] does not serve")

if problems:
    for p in problems:
        print(f"  {p}")
    print(f"\n{len(problems)} problem(s)")
    sys.exit(1)

print(f"assets consistent: {len(table_files)} files, {len(table_urls)} urls")
