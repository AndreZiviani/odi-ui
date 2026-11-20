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


# confd serves each asset from filebuf (src/buffers.c), read whole, and
# read_file() stops one byte short of the buffer without an error: a file
# that fills it cannot be told from a cut one and is refused with a 500 on
# the device. So the most confd serves is two bytes less than the buffer
# (65,534 of 65,536), and every file in web/ has to stay within that.
bufsrc = open(os.path.join(HERE, "src", "buffers.c"), encoding="utf-8").read()
mb = re.search(r"^char filebuf\[(\d+)\];", bufsrc, re.M)
largest = (0, "")
if not mb:
    problems.append("could not read the size of filebuf from src/buffers.c")
else:
    cap = int(mb.group(1))
    for f in sorted(on_disk):
        size = os.path.getsize(os.path.join(HERE, "web", f))
        largest = max(largest, (size, f))
        if size + 1 >= cap:
            problems.append(f"web/{f} is {size} bytes, more than the {cap - 2} confd serves "
                            f"from filebuf[{cap}]: it would refuse it; split it or grow the buffer")

# The page and the daemon each hold the upload ceiling, and a page that allows
# more than the daemon takes sends the whole file to be told 413.
conf_h = open(os.path.join(HERE, "src", "confd.h"), encoding="utf-8").read()
mc = re.search(r"#define\s+UPLOAD_MAX\s+\((\d+)u\s*\*\s*(\d+)u\s*\*\s*(\d+)u\)", conf_h)
mj = re.search(r"const UPLOAD_MAX = (\d+) \* (\d+) \* (\d+);",
               open(os.path.join(HERE, "web", "validate.js"), encoding="utf-8").read())
if not mc or not mj:
    problems.append("could not read UPLOAD_MAX from src/confd.h or web/validate.js")
elif [int(x) for x in mc.groups()] != [int(x) for x in mj.groups()]:
    problems.append(f"UPLOAD_MAX differs: src/confd.h {mc.groups()}, web/validate.js {mj.groups()}")

if problems:
    for p in problems:
        print(f"  {p}")
    print(f"\n{len(problems)} problem(s)")
    sys.exit(1)

print(f"assets consistent: {len(table_files)} files, {len(table_urls)} urls"
      + (f", largest web/{largest[1]} {largest[0]} bytes, at most {cap - 2}" if mb else ""))
