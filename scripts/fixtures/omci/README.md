# Captured `omcicli mib get` output

Fixtures for the ME parser in `web/omci.js`, exercised by
`scripts/web-check.mjs`. Every file here is **real device output**, not written
by hand: the parser's whole job is to cope with a format that is inconsistent
between tables, and a fixture invented to match the parser proves nothing.

Provenance matters, so each file says where it came from:

| file | source |
|---|---|
| `84-VlanTagFilterData.txt` | posted by a user running `V1.0-220923` — the same base our sticks run — in Anime4000/RTL960x#282 |
| `171-ExtVlanTagOperCfgData.txt` | same thread, same stick |

Add to these with `scripts/capture-omci.sh <user@stick>`, which dumps every
registered table from a live stick. A capture from our own hardware is worth
more than a capture from a thread: it is the same firmware *and* the same
build, and it is the only way to confirm the tables this repo has not seen.

Two things the fixtures already pin down, both of which a hand-written file
would have got wrong:

- ME 84 prints `EntityID`; ME 171 prints `EntityId`. Same firmware, same dump
  format, different capitalisation.
- A table's rows arrive as bare lines (`INDEX 0`) with no key, under a bare
  heading line with no key either.

## `../l2-table.txt`

`diag l2-table get entry address valid`, posted in Anime4000/RTL960x#231 by a
user diagnosing a VLAN problem on the same firmware. It pins down three things
a hand-written file would miss: each entry is **three** stanzas (a `LUT
address:` line, the unicast header and row, then a second header and row for
the per-entry flags); the row is separated from its header only by whitespace
whose width varies with the column values; and the capture **ends mid-entry**,
on a header with no row under it, which the parser has to survive.

It is exactly as posted, including that truncation. An earlier version of this
file had a third entry appended to give the parser a port-0 example — invented,
and using one of our own sticks' MAC addresses. That is the failure this
directory exists to prevent, so the synthetic case now lives inline in
`scripts/web-check.mjs`, labelled, where nobody can mistake it for a capture.
