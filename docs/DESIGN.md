# Design and internals

The rationale, history and implementation detail behind `confd` — the parts
of the project that do not belong in a high-level README. See
[`API.md`](API.md) for the wire contract and [`BUILDING.md`](BUILDING.md) for
build, test and deploy commands.

## Why not just extend the vendor UI

You cannot. `boa`'s application is compiled into `boa`: 98 `.asp` pages driving
**88 distinct `<%` handlers**, plus the `/boaform/` POST endpoints, all linked
against `librtk`, `libmib` and `libomci_api`. External CGI always returns 404 —
`AddType application/x-httpd-cgi asp` dispatches to internal handlers only — so
there is no seam to hook into. The only way to extend that UI is to not use it.

## The idea

**Serve a static page and a JSON API, and let the browser render.** The device
does no templating.

The whole of the device's configuration is ~184 MIB keys plus two indexed
tables, described by a **schema file** rather than by C. The browser fetches the
schema and the values and builds the forms generically, so **adding a key is a
data change** — no new handler, no recompile, no reflash.

That is the one thing the vendor design got wrong, and it is why this is a few
hundred lines instead of 88 handlers.

## Tabs

Four sections, each with subtabs. The location hash names the pair
(`#config/vlan`, `#system/logs`), so a view can be linked, reloaded and
navigated back to; the names the page used before the regrouping
(`#firmware`, `#admin`, ...) still land on their new place. Both levels are
ARIA tablists: arrow keys move between tabs, Home and End jump to the ends.

- **Status** &mdash; the receive and transmit levels as instruments (see "The
  look"), the registration ladder, the transceiver, forwarding rates, and the
  MAC addresses the switch has learned. A pill in the header repeats the ONU
  state and the receive level on every view.
- **Config** &mdash; grouped by what someone changing the line thinks about,
  not by the schema section a key lives in:
  - *Line* &mdash; `GPON_SN`, the PLOAM password, the four LOID keys;
  - *VLAN* &mdash; the four `VLAN_*` keys;
  - *OLT identity* &mdash; the identity switch, and the five keys it gates;
  - *Network* &mdash; both management addresses and the UNI MAC;
  - *Services* &mdash; `SYSLOG_SERVER`, `NTP_SERVER`;
  - *Stock keys* (was *All settings*) &mdash; on odi-oss, the 163 keys only the
    stock firmware reads, read-only, for inspecting what a backup carries. On a
    stock-based image this subtab is *All keys*: all 184, editable, with the
    `OMCI_CUSTOM_*` bitmasks decoded.

  The grouping is a table in `web/config.js` (`GROUPS`); a key it does not name
  still appears, under the subtab its schema section maps to, or under *Other*.
  On a stock-based image the editable subtabs hold the 23 keys the line
  profiles in `odi-sandbox` carry.
- **OMCI** &mdash; *Services*, what the OLT actually provisioned, in sentences;
  and *MIB browser*, the same thing unedited, one managed entity at a time.
- **System** &mdash; *Firmware* (both partitions, what each one holds, image
  upload and write, the one-shot trial boot); *Access* (this page's
  credential, SSH keys); *Backup &amp; reset*; *Logs &amp; tools* (the kernel
  log, ping).

Which keys are editable is data: `schema/settings.tsv` when the image has it,
the `common` column in the schema when it does not.

### Settings rows

A row is the label, one line of help, and a *Details* disclosure on the left;
the control and its cost on the right (stacked, control first, on a phone). The
one line is the first sentence of the `meta.tsv` help, which says what the key
is. The rest of that help, the `settings.tsv` note (why it costs what it does),
the accepted values, who reads it and what it used to be are behind *Details*.
A sentence already said is not said again: the two files were written apart
and the page used to print several explanations twice. What is wrong *now* --
a key the firmware is ignoring, a key the identity switch is not reporting --
stays visible.

### The cost of a change, drawn the same way everywhere

The four apply classes are the core information of this UI, so they have one
visual language: a badge with one to four bars, rising with what the change
costs, in the class colour (green LIVE, blue SERVICE RESTART, yellow
INTERRUPTS INTERNET, red REBOOT). The same badge is beside each key, in the
sticky save bar (`3 changes`, then `2 interrupts internet`, `1 live`), on the
buttons that apply a change, and the same bar count heads the confirmation
dialogs. A subtab label carries the number of unsaved changes on it.

### The two banners

The default-credential notice is loud on Status and System &rsaquo; Access,
where it is about what you are looking at, and a small *Default password*
chip in the header on every other view.

A **trial boot** is a different thing and looks it: a full-width band in the
sticky header, on every view, for as long as U-Boot would boot another
partition next -- `sw_commit`, in either copy of the redundant environment,
naming a slot other than the running one. It says only that this image is
not committed and which partition the next reboot returns to -- what that
partition holds is on System > Firmware, not claimed in the band, since it is
not always the stock firmware -- and offers *Commit to this image*, which is the existing
`action=commit` (`nv setenv sw_commit <slot>`). It cannot be dismissed. The
commit writes only the winning environment copy; when only the fallback copy
disagrees the band says so, and says how to make it agree over SSH.

## Two images, two relationships to `boa`

The vendor firmware ships its own web server, `boa`. What `confd` does next to
it depends on which image it runs in:

- **On the stock/OEM firmware**, `confd` runs *alongside* `boa`, on its own
  port. It does not replace it, and does not try to.
- **On the odi-oss image**, `boa` is gone entirely, and `confd` replaces it,
  serving on port 80.

The sections below that say "on the odi-oss image" / "on a stock-based image"
follow from this split.

## On the odi-oss image

odi-oss replaces the stock userland, and reads 21 of the 184 keys; the other
163 are still in the store because the config partition is shared with the
stock firmware in the other slot. `schema/settings.tsv` is that image's own
answer to "what does this key do here": its apply class, the action that
applies it, the key it is written with, who reads it, and why it costs what it
does. Its presence is what switches the page into this mode; `docs/SETTINGS.md`
in odi-oss is the prose version and the source of truth.

| class | meaning | action | keys |
|---|---|---|---|
| **LIVE** | takes effect at once | `apply.sh network`, run straight after the save; `apply.sh omci` for the four VLAN keys, also run straight after the save (omcid rereads the store on SIGHUP and rebuilds the connections in place, the ONU stays in O5); `none` where the daemon reads the key each time it uses it | `LAN_IP_ADDR`, `LAN_SUBNET`, `LAN_ENABLE_IP2`, `LAN_IP_ADDR2`, `LAN_SUBNET2`; the four `VLAN_*`; `OLT_SW_DOWNLOAD` |
| **SERVICE RESTART** | a daemon restarts, the fibre service stays up | `apply.sh syslog` / `apply.sh ntp`, run straight after the save (apply.sh kills the daemon, busybox init respawns it, bounded by `APPLY_TIMEOUT_MS`) | `SYSLOG_SERVER`, `NTP_SERVER` |
| **INTERRUPTS INTERNET** | applied without a reboot, the fibre service drops meanwhile | `apply.sh omci`, offered as *Apply now* behind a confirmation (omcid deactivates the ONU, clears its MIB and ranges it again, in the same process) | `GPON_SN`, `GPON_PLOAM_PASSWD`, the four `LOID*`, `OMCI_SW_VER1/2`, `GPON_ONU_MODEL`, `OMCC_VER`, `OMCI_VENDOR_PRODUCT_CODE`, `ONU_HW_VERSION`, `OMCI_UNKNOWN_ME_OK` |
| **REBOOT** | read only at boot | *Reboot now*, behind a confirmation that names the slot it comes back on | `ELAN_MAC_ADDR` |

The action, not the class, is what the daemon reports in `needs`; a batch that
needs `omci` also carries `"interrupts"`: false when every key in it is class
live (the page applies it at once, nothing drops) and true otherwise (the page
offers *Apply now* behind the confirmation). `apply.sh omci` does the right
thing for either: it signals omcid, which compares the store with what it runs
and rebuilds in place or re-registers.

What the page does differently there:

- **Only keys that work are editable.** A key with no settings row is shown on
  the Stock keys subtab, read-only. `/api/config` still accepts every schema key,
  because a restore must write all of them back, and answers `"stock":true` for
  a key nothing here reads.
- **`/api/config` lists the actions a save needs**, `"needs":["network","omci",
  "reboot"]`, and whether `omci` drops the fibre service (`"interrupts"`). The
  daemon still applies nothing on its own; the page runs the live ones
  (network, and omci when nothing in the batch interrupts) and offers the rest.
- **`LOID` is written with `LOID_OLD`** (and the password with its `_OLD`),
  because the OLD value wins whenever the two differ, on omcid as on the stock
  firmware; the `pair` column says so and the `_OLD` rows are read-only.
- **The OLT identity switch.** omcid reports `OMCI_SW_VER1/2`, `GPON_ONU_MODEL`,
  `OMCC_VER` and `OMCI_VENDOR_PRODUCT_CODE` only while
  `/etc/config/omci-identity.on` exists; off, it answers what it always has.
  A stick commonly ships with the stock values already stored in all five, so
  reporting them by default would change what the OLT sees. `POST /api/switch
  name=omci-identity.on&on=1|0` toggles it (an allowlist of one name), and
  `/api/firmware` reports it under `switches`.
- **Firmware write runs in the background.** odi-oss `fwu_starter.sh` checks
  the slot is the inactive one and `fwu.sh` against its md5, starts the flasher
  detached, and returns; `/api/firmware` carries `write` (`state`, `slot`,
  `rc`, and the tail of the flasher log) and the page follows it.
- **Reset** merges `/etc/config_default.xml` into the service store: the LOID
  keys and five stock-only keys go back to their defaults, nothing else moves.
- **The MAC table is read on both firmwares.** odi-oss `diag` walks the
  switch L2 table itself and answers the same `l2-table get entry address
  valid` the stock diag does, under the stock header words; its rows also say
  whether they are a learned address or a multicast group (`Type`, `Ports`),
  and the page shows a group with its member ports.

## The MIB tabs

The config keys are what this stick **asked for**. The OMCI MIB is what the line
**built**, and when the two disagree the line is right. That distinction is the
whole reason these two tabs exist, and it is the one most "state is O5 but
nothing passes" threads turn on.

**Services** answers six questions in plain language, reading ME 7, 131, 84,
171, 262 and 268:

- the software version the OLT sees &mdash; the only version string the ISP
  gets, and the one `chk_swver_fix.sh` rewrites at boot
- which OLT is at the other end, decoded from `OltVendorId`
- which VLANs the line permits
- whether the OLT is translating a VLAN, and which of the two to tag
- what upstream containers and GEM ports exist

Each card is in one of four states and says only what it knows: *reading*;
*could not read* (the daemon failed, answered nothing, or answered `0 rows` for
an entity the ONU always creates itself &mdash; the software images, the OLT-G,
the T-CONTs); *none* (a good read of a table the OLT fills, holding nothing);
or the rows, in sentences. odi-oss omcid has answered `0 rows` for the
ONU-created entities, and the page used to relay that as "the OLT has not
created any", a definite and wrong statement about a line carrying traffic.

omcid prints the vendor format only for the classes something on the stick
parses (256, 131, 84, 171). Every other class comes out in its own shape,
from `cli_row` in odi-oss `src/omci/respond/show.c`: a `268 GemPortCtp 1`
header per row, `    PortID   0fff` attribute lines of raw bytes, and a
`N rows` count. The parser reads both, and turns the bytes into what the
vendor dump would have printed &mdash; a number as `0x..`, a string as its
text &mdash; so the cards need no second code path. The GEM port card used to
miss this shape entirely.

**MIB** runs `omcicli mib get` and shows exactly what it printed &mdash; which is
what a support thread means when it asks you to post `omcicli mib get 84`. The
picker offers all 81 table names, captured from a stick once and shipped as
data, and accepts a bare class id as well because that is the dialect threads
are written in.

**Captured, not queried, and the reason matters: `omcicli get tables` breaks the
MIB service.** It returns zero bytes and leaves every later `mib get` empty
until `omci_app` is restarted. This tab used to call it on load, so opening the
MIB browser disabled the diagnostics it exists to show. `/api/omci` now refuses
that verb outright — a route whose job is reading the MIB must not be able to
break it — and there is a smoke check for the refusal.

Isolated twice from a freshly restarted `omci_app`, with `get sn`,
`get devmode` and `get cflag` harmless in the same run, so it is that one
command rather than the `get` family or the call volume.

The names are also **not** the `/lib/omci/mib_*.so` filenames: 23 of the 81
differ (`AuthSecMethod` against `Authen_Sec_Method`) and some contain spaces.
An unrecognised name produces empty output rather than an error, so the
filename form failed silently and looked like an empty table.

### Two rules these pages are written to

**Read-only.** `omcicli mib set` exists and no route reaches it. The MIB is the
OLT's copy of the service and is rebuilt at every re-registration, so a change
made there survives one reboot and not the next &mdash; a worse answer than no
change at all. Settings that persist live on the Config tab.

**Never invent a meaning.** Where an attribute reads unambiguously &mdash; a
VLAN id is a VLAN id &mdash; it is spelled out. Where it does not, the value is
shown as it came. That is why there is no table of forwarding-operation codes:
the VIDs in the filter answer what people actually ask, and a confident wrong
gloss on a MIB attribute is worse than none. The decoded card also prints the
table name **the device returned**, not the one it asked for, so a wrong class
id shows up as a wrong name instead of a mislabelled card.

### The parser is tested against captures, not against itself

The dump format is not consistent between tables. ME 84 prints `EntityID` and
ME 171 prints `EntityId`, in the same firmware; a table's rows arrive as bare
lines with no key at all. So `scripts/fixtures/omci/` holds **real device
output** and `make check` runs the parser over it. A fixture written to match
the parser would test nothing.

Two of those fixtures came from a support thread on sticks running our own
`V1.0-220923` base. `scripts/capture-omci.sh <user@stick>` dumps every
registered table from live hardware and is how the rest get filled in &mdash;
including the open question of whether this firmware takes a table name as well
as a class id.

## The OMCI_CUSTOM_* bitmasks, decoded

`OMCI_CUSTOM_BDP`, `_RDP`, `_MCAST` and `_ME` are the four least documented
settings on this device. The stick ships with `OMCI_CUSTOM_RDP=4` and upstream
has an open issue from 2022 asking what that means, answered with "no
information on this" (Anime4000/RTL960x#41, and #107 for the VEIP bit beside
it).

They were never opaque. Each bit loads one plugin, and the plugins name the bit
in their own filenames:

```
lib/features/internal/rdp_00000004.so    OMCI_CUSTOM_RDP bit 0x4
lib/modules/features/bdp_00000002.ko     OMCI_CUSTOM_BDP bit 0x2
```

while the feature itself is the function the module **defines**.
`scripts/gen-features.py` reads that out of the ELF symbol table into
`schema/features.tsv`, and the field on the config page decodes the value as you
type it:

```
OMCI_CUSTOM_RDP  4        0x4      ignore_conn_uniNode_check
OMCI_CUSTOM_BDP  258      0x2      ignore_ds_pbit
                          0x100    cf_sfu_report_veip, force_veipRule_to_sfu
```

Three things that only fall out of doing it this way:

- **A bit can carry more than one feature.** `me_00080000.so` defines both
  `treat_cir_of_traffic_descriptor` and `force_meterType_of_trafficDesc`.
- **A bit you set that this image has no plugin for does nothing**, and the page
  says so rather than dropping it silently.
- **The value is decimal.** `flash set` accepts nothing else, so `0x102` stores
  zero. The help text says this now; it used to say "hex bitmask", which was
  exactly backwards.

Reading symbols rather than strings is what makes it exact. An earlier pass took
the string sitting next to `feature_api_register` and reported `printf` as a
feature, because a string table is not a call sequence.

Regenerate when the base changes &mdash; the file describes the image it ships
in, and `build-overlay.sh` copies it beside `keys.tsv`:

```bash
scripts/gen-features.py /path/to/unpacked/rootfs > schema/features.tsv
```

## What a change costs

`schema/consumers.tsv` records who reads each key and therefore what it takes
for a change to take effect. It is **derived from the firmware**, not asserted:
`scripts/classify-apply.py` searches an extracted rootfs for every key and the
class follows from where it turns up.

| class | meaning | count |
|---|---|---|
| `restart:omci` | `runomci.sh` reads it, so restarting `omci_app` rebuilds the command line from it — about six seconds, no reboot | 20 |
| `reboot` | only a boot script reads it, and nothing re-runs those | 5 |
| `unknown` | referenced inside a binary, so *when* it is read is not known | 159 |

`unknown` stays unknown rather than being guessed. A reference inside a binary
says nothing about when that binary reads it, and the UI tells you to assume a
reboot — the safe reading. The reader list is shown either way, because "which
program cares about this key" is useful even when the timing is not.

Two false positives were caught before this shipped, both of which would have
told someone "no reboot needed" when there is:

- the table field `VID` matched inside `VLAN_MANU_TAG_VID`, so
  `SW_PORT_TBL[*].VID` was classified `restart:omci` on the strength of an
  unrelated key. The search is word-anchored now.
- `bin/startup` is an **ELF binary** despite the name, and treating it as a boot
  script classified `PON_LED_SPEC` as `reboot` on no evidence.

The corrected `restart:omci` set is exactly the 20 keys `runomci.sh` reads —
two independent derivations agreeing.

Regenerate against an extracted rootfs:

```sh
scripts/classify-apply.py /path/to/squashfs-root schema/keys.tsv > schema/consumers.tsv
```

## Firmware

Shows both partitions, their versions, which one is committed and which is running,
and offers the two actions that matter:

- **Try** arms `sw_tryactive`, which boots that partition **once** with the
  hardware watchdog armed. If the image does not come up, the stick returns by
  itself to whichever partition is committed — no console, no intervention.
- **Commit** writes `sw_commit`, and is a separate decision made *after* seeing
  the trial work. A trial that boots fine still reverts on the next reboot.

Writing `sw_commit` up front instead is what every runbook for this device used
to say, and it makes an unproven image permanent before it has booted once.

**What each slot holds is read off the slot**, not off U-Boot. `/api/firmware`
reports `slots`: the name and build time from the uImage header at the start of
each kernel partition (`k0`, `k1`, found by name in `/proc/mtd`, 64 bytes read
from the mtd device). The stock V1.0-220923 base names its kernel `Linux Kernel
Image`; odi-oss adds the kernel line, `Linux Kernel Image 6.18`. The header is
written by the flash itself, so it cannot drift from the image, where
`sw_version<p>` is only what the last updater chose to record: on a live stick
it named an odi-oss build for the slot that held the stock firmware.

Writing the other slot stays available whatever it holds. When it holds the
stock firmware (or anything that is not odi-oss) the slot says so beside the
action -- "Partition 1 holds the stock firmware. Writing replaces it, and you
lose it as a fallback." -- and the write asks a second time, naming what gets
overwritten: the kernel name, its build date and what U-Boot records.

Try is offered only for the slot the stick is not running, and only when that
slot is not already the committed one; the running, uncommitted slot offers
*Commit to partition N*, the same code path as the trial band's *Commit to this
image*. "What committing means", under the partitions, says which partition
U-Boot boots by default, that a trial is one-shot, and that a committed image
which later fails keeps booting itself. The page calls the
answering confd an override by the path it was started from (`exe`, argv[0]:
`/etc/config/confd/` for a `scripts/deploy.sh` install, `/bin/confd` for the
image copy), never by comparing build ids: a local image build stamps
`confd=local`, which matches no id.

The version shown for the **running** partition is the image it runs, from
`/etc/odi-build` (`image=`) or `/etc/version`; the U-Boot record
`sw_version<p>` is shown beside it when they differ. odi-oss `fwu.sh` does not
write that record unless asked, so on a trial it still names whatever the slot
held before -- which is what the tab used to show as the running version.

`sw_active` is U-Boot's own record of what it last booted and is never written
here. Partitions other than 0 and 1 are refused — `sw_tryactive=2` is the
bootloader's "no trial pending" state, so accepting it would mean doing nothing
while reporting success.

**Uploading an image is still a shell job**, and the page now spells out the
commands with this stick's own address and the partition it is *not* running,
so they can be pasted rather than adapted. Streaming a 3 MB multipart body
through a freestanding daemon with fixed buffers is large and risky, and it is
not the part that is easy to get wrong — the boot selection is.

## Default or changed

Each setting is labelled against two references, and neither is guessed.

**`/etc/config_default.xml`** and its HS twin are what the *image* ships, and
they are authoritative — but they cover only ten keys. A value matching one is
tagged `image default`; a value differing from one is tagged `changed` and the
shipped value is shown beside it.

There is deliberately no attempt to invent defaults for the other 174. The full
set lives inside the MIB and **there is no read-only way to read it out**:
`xmlconfig -def_mib -os` looks exactly like the command for the job and prints
the *current* configuration instead. Trusting it would have labelled every key
on the device a default — worse than having no label at all.

So the second reference is a **baseline captured from a stick you consider
correct**, which answers the question that actually gets asked: what have we
changed since. It lives on the device, not in this repo, because two sticks on
different lines legitimately differ in serial, VLAN and address and one shared
file would show the second as drifted in dozens of places.

```sh
SSH_OPTS='-S /tmp/odi_ctl' scripts/capture-baseline.sh admin@<stick>
```

Re-capture after deliberately changing something you mean to keep, or the UI
will keep flagging it. The script refuses to install a baseline of fewer than
50 rows, since a truncated one silently marks everything as changed.

Worth knowing what this turns up in practice: one stick can differ from the
image on a couple of keys (`OMCI_CUSTOM_BDP` and `OMCI_CUSTOM_ME` are common
ones) while another matches every one of the ten — because the image's
defaults were rebuilt from one working configuration, not derived
independently.

## Guided fields

`schema/meta.tsv` carries hand-written help for the keys worth explaining:
a readable label, what the key actually does, the values it accepts, a valid
range, and — the useful part — which *other* keys have to be set before it does
anything.

That last one exists because the firmware silently ignores settings. `runomci.sh`
only passes `VLAN_MANU_TAG_VID` to `omci_app` when `VLAN_CFG_TYPE=1` **and**
`VLAN_MANU_MODE=1`; otherwise it sends `-iot_vid 65535` and your VLAN ID goes
nowhere. Worse, if the VID or the priority is empty it drops the whole `-iot_`
block. The UI says so in place:

    Ignored by the firmware right now — needs VLAN_CFG_TYPE=1 and VLAN_MANU_MODE=1.

Values render as their meaning (`0 — SFU / bridge`, not `0`), and anything
outside its documented range is flagged.

Every claim in that file is sourced from the device — `/etc/runomci.sh` for how
a key reaches `omci_app`, and measurement for the rest. It is a **separate file
from `schema/keys.tsv` on purpose**: that one is regenerated from a stick and
would overwrite anything written by hand.

## Uploading an image

The Firmware tab used to hand out an `scp` command, on the grounds that a 3 MB
image could not be held in the memory this device has. That was true of holding
it; it was never true of moving it. The body is streamed straight to
`/tmp/img.tar` in 64 KB pieces and is never in memory whole.

**Raw bytes, not multipart.** `fetch(url, {body: file})` sends the file as the
body with no boundary to find, so there is no parser here to get wrong.

`read_request` gained two out-parameters for this — how much body arrived and
how much was declared — and it now returns **as soon as the body is known not
to fit**, rather than filling its buffer first. That is what makes the size
guard a real pre-body check: a request declaring 20 MB is refused on its
`Content-Length`, before a file is opened. Without that early return the read
loop went on waiting for a body that was never coming, blocked for the full
socket timeout, and the guard was never reached at all.

Every other route treats `body_have < body_want` as `413` — the same answer
`read_request` used to give itself, now given one layer up and sooner.

The upload is placed **after** authentication and the cross-site check, so
nothing unauthenticated can make this device write megabytes into the ramfs
every other process shares. A short write means that filesystem filled up, and
the partial file is removed rather than left there making it worse.

Writing is a **separate** action, and only offered for the partition the stick
is not running — the daemon refuses the running one by reading `sw_active`,
because `fwu.sh` would too but finding that out after the erase has begun is not
where anyone should learn it. On a stock-based image it blocks for about
eighty seconds and this server is serial, so nothing else is answered
meanwhile. On odi-oss the starter returns at once and the flash runs detached,
so the page polls `/api/firmware` for the state instead, and hides the write
button while one is running.

Integrity is not reimplemented here. `fwu_starter.sh` checks `fwu.sh` against
the md5 inside the tar, and `fwu.sh` checks the kernel and rootfs md5s before it
erases anything. The md5 this route reports is about the **transfer**, to
compare with the one beside the image you built.

## Tools

**The kernel log.** The switch and OMCI complaints live in the kernel ring
buffer until they scroll away &mdash; `create ani vlan for mbcast fail` and
`RT_ERR_RG_VLAN_USED_BY_SYSTEM`, the symptoms of an `OMCI_OLT_MODE` nobody
should be using, arrive there. The odi-oss boot scripts write to it too, and
the image forwards syslog to `SYSLOG_SERVER` when one is set, which is the way
to keep daemon logs.

Read with `klogctl(SYSLOG_ACTION_READ_ALL)`, not `cat /proc/kmsg`. Reading that
file **consumes** the buffer and then blocks waiting for more, so a page refresh
would eat the history and hang a server that handles one request at a time.
The priority prefix is never shown: the kernel writes a bare level (`<4>`), a
userland line written to `/dev/kmsg` carries its facility too (`<12>` is
user.warning), so the level is the low three bits and is rendered as a word in
its own column. A continuation line with no prefix of its own inherits the
level above it &mdash; which is how the `RT_ERR_` lines arrive. The once-a-minute
`rcS: alive` and `odi_wdt: alive` heartbeats are most of the buffer on a
healthy stick; they are hidden by default, counted, and one tick away.

**Ping** is IPv4 literals only, and that is not fussiness. This server is
serial, so a hostname means a DNS lookup on a device that in bridge mode has no
route to a resolver: it would hang rather than fail, taking the whole UI with
it. In bridge mode it reaches the management LAN and not much else, so what it
actually answers is whether the management path works in both directions.

## Learned addresses

Both firmwares answer it. The stock diag prints three stanzas per entry;
odi-oss diag (`l2-table get all` in its own spelling) prints one header and a
line per row, with two more columns, `Type` (`uc` learned, `mc` a multicast
group) and `Ports` (a group member mask). The page reads either by zipping
each row against the header above it, and lists a group with its members
instead of a source port.

The Forwarding counters say whether frames cross. This says *who* is crossing,
and on which side each address was learned — port 2 faces the fibre, port 0 the
SFP host — so an address that only ever appears on the host side never reached
the line.

Its own route rather than another line in the status scrape, and the reason is
size: `status` is 16 KB and the counter dump alone is 5.9 KB, so a few hundred
learned addresses would push the optics and the ONU state out of the response —
breaking the page that is always on screen to improve one that is not.

Parsed by zipping each MAC-shaped line against the header above it rather than
by column position. `diag` has four different header layouts for this table
depending on which lookup variant is asked for, and a positional parse would
mis-label the columns for any of them without saying so.

## Status / roadmap

| phase | scope | |
|---|---|---|
| 1 | schema, values, status | **done** |
| 2 | writes, verified, with apply | **done** |
| 3 | `apply` classes derived from the firmware | **done** |
| 4 | `SW_PORT_TBL` row add/remove | **not doing** — see below |
| 5 | firmware: partitions, trial boot, keep, reboot | **done** |
| 6 | image upload from the browser | |

### Why there is no row add/remove

Phase 4 was going to let the Advanced tab add and delete `SW_PORT_TBL` rows.
It is not a UI feature waiting to be written: **the device has no safe
mechanism for it.**

What the firmware actually offers, read out of the shipped binaries:

- `/etc/scripts/flash` accepts exactly four commands — `all`, `default`,
  `get`, `set`. There is no add and no delete.
- `xmlconfig`'s own usage lists `-g`, `-s`, `-h`, `-if`, `-def`, `-nodef`,
  `-of` and `-def_mib`. Also no add and no delete. (A `-index` string exists
  in the binary but appears in no usage text.)
- Rows *are* created — `xmlconfig` calls `mib_chain_add`, and fails with
  `[ERR] mib_chain_add failed for dir(%s, %d)` — but only while **importing a
  whole configuration file** with `-if`. That is a total rewrite of the
  configuration, not a surgical row insert, and it is what `flash default`
  uses.
- `libmib.so.0` does export `__mib_chain_add` and `__mib_chain_delete`, and
  `/bin/mib` imports them, but `/bin/mib` has no usage text and no
  command-line surface for them. Reaching them means linking `libmib` and
  `librtk` into this daemon — the opposite of the rule the exporter already
  settled on for the same reason: fork the vendor CLI, do not link the vendor
  libraries, because the behaviour that matters lives in the tool rather than
  in the library call.

So the only available path is "export the whole config, edit the XML, import
it back", which trades a per-key write with a read-back for a whole-file
replacement with none. Against that, `xmlconfig` carries
`[ERR] Warning, unknown dir.idx.entry`, so a `-s` to an index that does not
exist is at best a warning — and a malformed table address is already known to
exit 0 having written **a different entry** (see "Keeping the schema honest" in
`BUILDING.md`).

Editing the fields of an existing row works today and is what the actual lead
needed anyway: the upstream report matching this symptom is fixed by
setting `PVID` on the row that is already there, not by adding one.

If this is ever genuinely needed, the honest order is: establish on a stick you
can afford to lose whether `-s TBL.<new index>.<field>` creates, warns, or
silently writes elsewhere; then decide. Nothing here should be built on a guess
about that.

### Backup, and the reset that does not end sticks

Every thread about resetting this device says `flash_eraseall /dev/mtd3`. That
erases the whole config partition: both MIB stores, the identity in the `hs`
store, this daemon's credential file, and any override binary living beside it.
Anime4000/RTL960x#84 has people doing it, including one who ran it across mtd3,
mtd4 and mtd5 and lost the device outright.

**The vendor ships a supported reset that is per-store**, and the split is
exactly the one that matters:

| store | keys | holds |
|---|---|---|
| `cs` | 118 | service config — VLAN, management IP, `DEVICE_TYPE`, the `OMCI_*` settings |
| `hs` | 62 | the hardware identity — `GPON_SN`, `MAC_KEY`, `ELAN_MAC_ADDR`, `PON_VENDOR_ID` |

So `flash default cs` gives back a clean service configuration and leaves the
values that cannot be regenerated alone. It rewrites `/var/config/lastgood.xml`
rather than erasing the partition, so files there — `confd.auth`, an overridden
`confd` or `metricsd` — survive it too. It does clear `GPON_PLOAM_PASSWD`, which
is in `cs` and which some lines authenticate on; the page says so.

**`hs` is not reachable from here.** The route hardcodes the store, and a
`store=` parameter cannot steer it — there is a check for that. The reset people
want is the service one; the one that ends sticks is the other.

### The backup is a precondition, not a suggestion

The page fetches the backup as a blob, hands it to the browser, and **only then**
makes the destructive call — the reset does not run if the fetch fails or comes
back empty. A link the operator is told to click first is not a precondition, it
is a hope, and resets done without one are the whole reason there are dead
sticks in those threads.

It is served as a download rather than shown, because a page you have to
remember to copy out of is not a backup, and it carries the identity keys in
clear — which is the point of it, and why it needs the same credential as
everything else.

### Restoring a backup

**No daemon route, deliberately.** The browser reads the file, parses it, and
replays it through `/api/config` — the same path the Config tab writes through,
which validates every value against the schema, refuses the SerDes keys, demands
`_confirm=identity` for the nine the line authenticates on, and reads every
write back.

A dedicated restore endpoint taking a whole XML file would be a way around all
of it, and the one key it would let through unchecked is `LAN_SDS_MODE` — the
key that takes ssh, telnet and this page with it at once.

It also makes a restore reviewable: the file is diffed against what the device
holds and nothing is written until the differences are on screen. Keys that
already match are not rewritten, because a restore reporting 184 writes tells
you nothing about what actually changed. Identity keys are listed separately and
left alone unless you tick the box — a backup restored onto a *different* stick
would otherwise overwrite the serial number and MAC key that line authenticates
on.

### Writing

A write carrying an `Origin` that does not match `Host` is refused with `403`;
see "Cross-site writes are refused" below.

Every write is **read back and compared**, because `flash set` reports success
for things it did not do. A batch is per-key: a refused or invalid key does not
stop the others, and each gets its own verdict.

Nothing is applied implicitly. The response says which apply class the changes
need and the caller decides, because a config write on this device does nothing
until the reader re-reads it: `omci_app` or omcid restarts, `network.sh`
re-applies the addresses, or the stick reboots. On odi-oss it also lists the
actions (`needs`) and whether any key is stock-only (`stock`).

Refused regardless of what the schema says: `LAN_SDS_MODE`, `LAN_SPEED_MODE`,
`FIBER_MODE`. Identity keys need `_confirm=identity` in the same body. Values
are validated server-side against their type, not only in the browser, since a
request need not come from the page.

Clearing a key is rejected with a message saying why, except the `hostport` keys (`SYSLOG_SERVER`, `NTP_SERVER`), which odi-oss `flash` keeps in its own file and removes on an empty value. For the rest: `flash set` guards its set
branch with `[ "$3" != "" ]`, so an empty value falls through to its usage text
and exits 1 while looking like it worked.

## Authentication

HTTP Basic, credentials in `/etc/config/confd.auth` as `user:password`:

```sh
ssh admin@<stick> 'printf "user:password" > /etc/config/confd.auth; chmod 600 /etc/config/confd.auth'
```

**With no credential file, confd answers to a built-in `admin` / `admin`** —
the same credential `SUSER_NAME`/`SUSER_PASSWORD` ship with, and the ssh and
telnet login on the stock firmware. (odi-oss has no telnet, and logs in as root
with SSH keys or a per-build password; the fallback is unchanged there.)

This used to be a refusal, which is the safer posture in the abstract and the
wrong one here. `/etc/config` is precisely the partition a factory reset
erases, so "no credential file" is the state of every freshly reset stick and
of every stick flashed with an image that never had one written. Refusing left
a config UI nobody could open, on a device whose remaining management paths are
telnet and a 2007 dropbear that no current ssh client will talk to.

The fallback is to a **weaker** credential, never to none. Every request is
still checked, the comparison is still constant-time, a wrong password is still
`401`, and a failure still costs a second. An empty file counts as absent for
the same reason: truncating the file is how anyone clears a password, and
treating the result as "accept nothing" would lock you out of the device you
were changing the password on.

### Changing it, from the page

System > Access has the field, and it **creates `/etc/config/confd.auth` if it
is not there** — which is the whole point, because the state it fixes is the
state of every factory-reset stick. Telling an operator to go and find an ssh
client that still speaks to a 2007 dropbear is how the default stays in place
forever.

What authorises it is the credential already in force: `serve()` has checked it
before the route runs and a cross-origin POST is already refused, so there is no
second password prompt. That is the same standard as every other write here,
including the ones that change what the OLT authenticates against.

A credential that cannot be expressed in the file format is **refused, not
rewritten** — no colon in the username, no newline in either half, 4 to 128
characters. A mangled credential is one nobody can log in with, on a device
where finding that out means a site visit. The file is written `0600`, with an
explicit `chmod`: `open()`'s mode applies only when the file is created, so
rewriting one that already exists world-readable would leave it that way.

Afterwards the browser is still holding the **old** credential and will replay
it into a `401`, so the page says to sign out and back in rather than letting a
successful change look like a broken page.

### Saying so is what makes it defensible

`/api/firmware` reports `defaultauth`, and the page says so until the
credential is no longer the default one: a banner with a button that lands on
the field, on Status and on System &rsaquo; Access, and a *Default password*
chip in the header on every other view.

Note *default one*, not *no file*: a file containing `admin:admin` leaves you on
the password everybody knows while making the warning disappear, which is the
worst of both. The check compares the credential in force against the built-in
one, so writing the default into the file changes nothing about what the page
tells you.

### Every request is checked, which the stock UI cannot say

The credential is verified on **every** request, in constant time, before the
request is parsed at all. That is worth stating plainly because the vendor's
`boa` does not do it. From Anime4000/RTL960x#84, a factory reset driven by two
`curl` calls:

```
curl -X POST .../boaform/admin/formLogin --data-raw '...username=admin&password=admin...'
curl -X POST .../boaform/formSaveConfig  --data-raw 'reset=Reset&submit-url=%2Fsaveconf.asp'
```

> How you can see - no tokens/etc are required to make a second request (WTF?
> Security???) It's likely web server just whitelists your IP and accepts all
> further admin request without authentication.

Whatever `boa` is actually keying on, the erase went through without the second
request carrying anything. The same shape here answers `401`.

Two related properties fall out of the same design. The login is **not a
session**, so nothing is left authenticated behind you and a second tool
polling the device does not evict your shell &mdash; unlike the stock UI, which
allows one login at a time, and unlike ssh on this stick, which allows one
connection and made the upstream Prometheus collectors fight the operator for
it. And a failed attempt **sleeps one second before answering**: the server is
single-threaded and serial, so that is a hard global rate limit rather than a
per-connection one. Measured without it, this device answers 319 guesses a
second.

### There is no session

HTTP Basic is stateless, so this is worth being explicit about:

- **No session, no cookie, no token, and no expiry.** The browser caches the
  credential and replays it on every request; each one is authenticated
  independently.
- **Sign out is best-effort.** There is no session to end, so the button answers
  `401` and lets the browser drop what it cached for the realm. Most browsers
  do; none promise to. Closing the tab is the only certain way, which is what
  the signed-out page says.
- Failed attempts are **delayed one second**. Without that, the only limit on
  guessing was how fast the device could answer — measured at **319
  attempts/sec**, enough to walk a human-chosen password. The daemon is
  single-threaded and serial, so the delay is a hard global rate limit rather
  than a per-connection one: an attacker cannot open more sockets to go faster.
  Measured after: **1/sec**, with correct logins unaffected.

### Cross-site writes are refused

Basic has no token, and the browser replays the credential on any request to
this host — including one a page on another site caused. Without a check, any
page the operator visits could POST `action=reboot` to `/api/firmware`, or
rewrite `GPON_SN` with `_confirm=identity`. A urlencoded form POST is a
CORS-simple request, so nothing preflights it, and the attacker being unable to
*read* the reply does not help: every one of those routes is a write.

So a write carrying an `Origin` header that does not match `Host` is refused
with `403`. A write carrying no `Origin` is allowed — that is `curl` and this
repo's own scripts, and an attacker who can set arbitrary headers is not doing
CSRF in the first place. Every current browser sends `Origin` on a cross-origin
POST, form submissions included.

The credential travels in cleartext. There is no usable TLS stack in this image
and a handshake on a ~300 BogoMIPS core is not worth the cost — the same
exposure `boa` already has, and telnet is open on `:23` regardless. Use a
credential you do not reuse, and treat the upstream router as the real
perimeter.

## SSH keys

System > Access, "SSH keys": the public keys that log in as `root` over ssh without
a password, one OpenSSH line each. The list is the file as it is, so a key
added by hand shows up too, and Remove names the line number the server
reported rather than re-sending the key.

The file is `/etc/config/dropbear.d/authorized_keys`, beside the dropbear
host key on the jffs2 partition, so keys survive a reflash. It only does
anything on an image whose dropbear is started with `-D /etc/config/dropbear.d`
-- odi-oss does; the vendor image does not read it. Mode 600, written whole.
Copying files to and from such an image is `scp -O` (dropbear speaks the
legacy scp protocol only); see odi-oss `docs/ACCESS.md`.

## Safety

`LAN_SDS_MODE`, `LAN_SPEED_MODE` and `FIBER_MODE` are marked `never` in the
schema **and** hardcoded in the generator. A wrong SerDes mode takes out telnet,
SSH, the web UI and the exporter simultaneously — every one of them arrives over
that link — leaving a serial console behind soldered UART pads. One layer of
protection is not enough for that.

Identity keys (`GPON_SN`, `MAC_KEY`, PLOAM, …) are marked `identity`: lose them
and the OLT stops authenticating the ONU.

## Applying changes without a reboot

**On odi-oss**, `/etc/scripts/apply.sh` does it, and `/api/apply` runs it:
`network` re-applies both management addresses live, and `omci` sends SIGHUP to the running omcid, which rereads the store: a VLAN change
is rebuilt in place (the ONU stays in O5, so those keys are LIVE), while an
identity change deactivates the ONU, clears omcid's MIB and re-activates it so
the OLT provisions every service again with the settings as they are now --
which is why that class is INTERRUPTS INTERNET. odi-oss `docs/SETTINGS.md` has the details and the
measurements. The rest of this section is the stock firmware.

On the stock firmware, config is read **once at boot** — `/etc/runomci.sh` builds the whole `omci_app`
command line from MIB keys and never re-reads them — so a write does not take
effect on its own. But a reboot is usually avoidable:

    kill $(pidof omci_app)
    PATH=$PATH:/etc/scripts /etc/runomci.sh

Measured on a live line: `omci_app` returns in ~6 s with a byte-identical
command line rebuilt from current config, the ONU comes back to O5, and an
established PPPoE session survives. Forwarding even continues *while* it is
dead, because the datapath is programmed in switch hardware.

The `PATH` is not optional: without `/etc/scripts` on it, `omci_app` reads a
zero MAC and exits with `GPON mac_check fail !!!!!!`, taking the ONU off the
line. That is why the schema carries an `apply` column — 20 keys are
`restart:omci`, and the rest are `unknown` until someone traces their consumer.

## Layout

```
src/main.c          listener and accept loop   (freestanding C, no libc)
src/routes.c        dispatch, and the config write path
src/http.c          request parsing, auth, the static-asset table
src/mib.c           the schema, validation, flash reads and writes
src/status.c        the diag scrape, the MAC table, the kernel log
src/omci.c          the OMCI MIB read path
src/firmware.c      partitions, the trial slot, the build manifest
src/buffers.c       every static buffer, in one place
src/util.h          base64, JSON escaping, small string helpers
src/syscall.h       copied from odi-sfp-exporter; fix it in both places
web/                the UI: fifteen ES modules, one page, one stylesheet
schema/keys.tsv     the keyspace, generated from a device
schema/meta.tsv     curated help: labels, options, ranges, dependencies
scripts/fixtures/   captured device output the checks run against
scripts/            build verification, schema drift, deploy
```

Nothing is fetched from a CDN. The stick has no route to the internet, so
anything loaded from one renders an unstyled page exactly when you need it
most. Body type is the system stack, zero bytes on flash, with tabular numerals
everywhere a figure appears. The one exception is the readout face, embedded in
`style.css` rather than fetched: B612 Bold, the typeface Airbus drew for
cockpit displays, subset to the glyphs a readout needs (digits, the minus sign,
`. , + %`, `dBm`, `°C`, `V`) &mdash; 2.4 KB of woff2, SIL Open Font License.
Monospace is for raw values only (MIB dumps, keys, hex), never for labels.

## The look

A field instrument for one fibre line: see that the line is healthy at a
glance, and know what a change costs before making it. The receive level is
the one loud thing on the page; everything else is quiet on purpose.

Colour is taken from the objects the stick is plugged into, on a cool slate
ground (`#151C24` dark, `#EDF1F4` light, following `prefers-color-scheme` until
the header toggle picks one: `data-theme` on `<html>`, kept in localStorage as
`odi-theme`, set from the head before first paint),
and each colour means one thing everywhere:

| colour | from | means |
|---|---|---|
| `#E8B923` yellow | singlemode jacket | signal and light; INTERRUPTS INTERNET |
| `#1F9D6B` green | APC connector | healthy; LIVE |
| `#3B7DD8` blue | UPC connector | interactive; SERVICE RESTART |
| `#D64545` red | alarm | REBOOT; anything destructive |

Text uses a lighter (dark theme) or darker (light theme) tint of each, chosen
for WCAG AA against both the page and the badge ground; the blue of a primary
button is deepened to `#2E6BC6` so white text on it passes too.

Three deliberate choices worth keeping:

- **Optical power is drawn on a scale, not printed as a number.** The window on
  the scale is the class B+ range the optics is specified for (the ONU figures
  in ITU-T G.984.2 Amendment 1: launch +0.5 to +5 dBm, receive -27 to -8 dBm), and two
  dimension lines under it give the margin to each edge (sensitivity and
  overload for receive), the way a power meter shows it. A reading in the
  window but in its outer 16% at either end (about 3 dB of the 19 dB receive
  window, 0.7 dB of the 4.5 dB launch window) is flagged; one outside it says by how
  much. So &minus;23.01 dBm is judged rather than merely reported.
- **O1 to O5 is rendered as a ladder.** It is the one thing on the page that is
  genuinely a sequence &mdash; an ONU climbs it on every registration &mdash; so
  it is the one place numbering earns its keep.
- **Forwarding shows throughput, not totals.** `omci_app` clears port 0's
  counters every performance-monitoring interval while port 2 runs free, so the
  running totals diverge wildly &mdash; 14 GB against 58 MB on a stick forwarding
  perfectly &mdash; and side by side that reads as a fault. Rates between refreshes
  mirror to within 0.1%, which is the actual test.
