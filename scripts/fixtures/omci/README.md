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
