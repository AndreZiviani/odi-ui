# Captured `omcicli mib get` output

Fixtures for the ME parser in `web/omci.js`, exercised by
`scripts/web-check.mjs`. Every file here is **real device output**, not written
by hand: the parser's whole job is to cope with a format that is inconsistent
between tables, and a fixture invented to match the parser proves nothing.

Provenance matters, so each file says where it came from:

| file | source |
|---|---|
| `84-VlanTagFilterData.txt` | posted by a user running `V1.0-220923` — this repo's own base — in Anime4000/RTL960x#282 |
| `171-ExtVlanTagOperCfgData.txt` | same thread, same stick |

Add to these with `scripts/capture-omci.sh <user@stick>`, which dumps every
registered table from a live stick. A capture from this device's own hardware
is worth more than a capture from a thread: it is the same firmware *and* the
same build, and it is the only way to confirm the tables this repo has not
seen.

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

## `topology-isp1/` and `topology-isp2/`

`omcicli mib get <class>` for the twelve classes the Topology tab reads, one
file per class. Like `../l2-table-odi-oss.txt`, these are **not captures from
a stick**: they are the real odi-oss omcid (main at fb649c4) run under qemu,
fed the recorded OLT sessions of its own tests
(`test/fixtures/omci-session-isp1.txt` and `-isp2.txt`, with their
`omci-store-*.xml`), and then asked as confd asks. So the bytes are what
omcid prints for those two lines, in both of its shapes (its own hex rows and
the stock `Key: Value` dump for 84 and 171). ISP1 is the line whose bridge
ports carry TP type 3 but point at GEM IW TPs; ISP2 the one whose TP type 3
points at the mapper, behind a VEIP alone. Replace them with real captures
when a stick provides them.

## Captures from this device's own sticks (2026-09-11)

| file | stick | why it is here |
|---|---|---|
| `7-SWImage.txt` | ISP1 | the attribute names are `Active`/`Committed`/`Valid` — **not** `IsActive`/`IsCommitted`, which the Services card had assumed |
| `131-OltG.txt` | ISP1 | `OltVendorId: 0x48575443` — an OLT vendor code |
| `11-EthUni-isp1.txt` | ISP1 | the physical UNI, entity `0x0101` |
| `329-VEIP-isp1.txt` / `-isp2.txt` | both | same entity `0x0601`, opposite Admin/Oper state on two lines that both forward — which is why neither is decoded |
| `47-MacBriPortCfgData-isp1.txt` / `-isp2.txt` | both | **the difference between the two lines**: ISP1's bridge carries the UNI *and* the VEIP, ISP2's carries the VEIP only |
| `266-GemIwTp-isp1.txt` | ISP1 | its entity ids are exactly the `TPType 3` pointers in ME 47, which is what validates the TP-type mapping |
| `_tables-names.txt` | ISP1 | the 81 table names `omcicli get tables` reports, extracted from its `TableId [n] Name: X!` lines. **23 differ from the plugin filenames** (`AuthSecMethod` vs `Authen_Sec_Method`) and some contain spaces. Six entities the stock plugins name after a make are listed under neutral names, and queried by class id (243, 350, 370, 373, 65282, 65294) |

`84-VlanTagFilterData.txt` and `171-ExtVlanTagOperCfgData.txt` remain the
thread captures: two attempts to replace them with fresh captures coincided
with the MIB service wedging (see NOTES.md), and a fixture is worth having only
when you know what it is.
