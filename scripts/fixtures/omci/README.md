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

## `../l2-table-odi-oss.txt`

The same command answered by the odi-oss `diag` instead: its own L2 table
listing, one header and one line per valid row, `Type` and `Ports` added for
multicast groups. It is **not a capture from a stick**: it is the real odi-oss
binary run under qemu against the fixed hardware answers of its golden test
(odi-oss `src/diag/test/l2.golden`, the `l2-table get entry address valid`
section, copied as is). The rows are that test's, and it says which: two
learned hosts, one on each side (the PON-side row restates the first entry
of the capture above), and a multicast group whose only member is the host
side. Replace it with a real listing once one has been read off a stick.

## Captures from our own sticks (2026-09-11)

| file | stick | why it is here |
|---|---|---|
| `7-SWImage.txt` | Claro | the attribute names are `Active`/`Committed`/`Valid` — **not** `IsActive`/`IsCommitted`, which the Services card had assumed |
| `131-OltG.txt` | Claro | `OltVendorId: 0x48575443` — "HWTC", Huawei |
| `11-EthUni-claro.txt` | Claro | the physical UNI, entity `0x0101` |
| `329-VEIP-claro.txt` / `-vero.txt` | both | same entity `0x0601`, opposite Admin/Oper state on two lines that both forward — which is why neither is decoded |
| `47-MacBriPortCfgData-claro.txt` / `-vero.txt` | both | **the difference between the two lines**: Claro's bridge carries the UNI *and* the VEIP, Vero's carries the VEIP only |
| `266-GemIwTp-claro.txt` | Claro | its entity ids are exactly the `TPType 3` pointers in ME 47, which is what validates the TP-type mapping |
| `_tables-names.txt` | Claro | the 81 table names `omcicli get tables` reports, extracted from its `TableId [n] Name: X!` lines. **23 differ from the plugin filenames** (`AuthSecMethod` vs `Authen_Sec_Method`) and some contain spaces |

`84-VlanTagFilterData.txt` and `171-ExtVlanTagOperCfgData.txt` remain the
thread captures: both of our attempts to replace them with our own coincided
with the MIB service wedging (see NOTES.md), and a fixture is worth having only
when you know what it is.
