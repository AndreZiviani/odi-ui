# odi-ui

A web configuration UI for the **ODI DFP-34X-2C2** GPON SFP ONU stick
(Realtek RTL9601D, RLX5281, big-endian MIPS).

It runs *alongside* the vendor's `boa`, on its own port. It does not replace it
and, for now, does not try to.

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

- **Status** &mdash; optics, ONU state, alarms, switch-port counters.
- **Config** &mdash; the 23 keys the line profiles in `odi-sandbox` actually
  carry. That set is an empirical answer to "what gets changed" rather than a
  guess, since it is exactly what provisioning a stick for an ISP line has
  needed.
- **Advanced** &mdash; all 184 keys, filterable.

The split is a `common` column in the schema, so which keys are everyday ones is
a data decision rather than something baked into the page.

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

Shows both partitions, their versions, which one is kept and which is running,
and offers the two actions that matter:

- **Try** arms `sw_tryactive`, which boots that partition **once** with the
  hardware watchdog armed. If the image does not come up, the stick returns by
  itself to whichever partition is kept — no console, no intervention.
- **Keep** writes `sw_commit`, and is a separate decision made *after* seeing
  the trial work. A trial that boots fine still reverts on the next reboot.

Writing `sw_commit` up front instead is what every runbook for this device used
to say, and it makes an unproven image permanent before it has booted once.

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

Worth knowing what this turned up on our two sticks straight away: Claro
differs from the image on exactly `OMCI_CUSTOM_BDP` and `OMCI_CUSTOM_ME`, while
Vero matches all ten — because the image's defaults *are* Vero's values, the
base having been rebuilt from its working configuration.

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

## Status

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
exit 0 having written **a different entry** (see "Keeping the schema honest").

Editing the fields of an existing row works today and is what the actual lead
needed anyway: the upstream report matching the Vero symptom is fixed by
setting `PVID` on the row that is already there, not by adding one.

If this is ever genuinely needed, the honest order is: establish on a stick you
can afford to lose whether `-s TBL.<new index>.<field>` creates, warns, or
silently writes elsewhere; then decide. Nothing here should be built on a guess
about that.

### Writing

    POST /api/config   key=value&key2=value2   -> per-key result, apply class,
                                                  and whether that class is a
                                                  traced fact or an assumption
    POST /api/apply                            -> restart omci_app, no reboot

A write carrying an `Origin` that does not match `Host` is refused with `403`;
see "Cross-site writes are refused" below.

Every write is **read back and compared**, because `flash set` reports success
for things it did not do. A batch is per-key: a refused or invalid key does not
stop the others, and each gets its own verdict.

Nothing is applied implicitly. The response says which apply class the changes
need and the caller decides, because a config write on this device does nothing
until `omci_app` restarts or the stick reboots.

Refused regardless of what the schema says: `LAN_SDS_MODE`, `LAN_SPEED_MODE`,
`FIBER_MODE`. Identity keys need `_confirm=identity` in the same body. Values
are validated server-side against their type, not only in the browser, since a
request need not come from the page.

Clearing a key is rejected with a message saying why: `flash set` guards its set
branch with `[ "$3" != "" ]`, so an empty value falls through to its usage text
and exits 1 while looking like it worked.

## In the firmware image

`~/git/odi-sandbox` builds `confd` and its assets into the image and starts it
from `rc35`, so a flashed stick serves this without anything being started by
hand. Until such an image is flashed, the deploy below is what puts it there —
and it does not survive a reboot.

## Build and deploy

```sh
make confd                                  # -> build/confd, ~20 KB
make test                                   # ELF shape + ISA audit, data files, HTTP
SSH_OPTS='-S /tmp/odi_ctl' scripts/deploy.sh admin@<stick> 8080
```

Docker builds and runs everything; `make check` also needs the host's `python3`
and `node`, since it reads data files and loads the web modules and wants no
cross-compiler. It runs on macOS.

`/api/firmware` also returns a `build` object read from `/etc/odi-build`, the
manifest the image build writes: which image, which base, and which `confd` and
exporter are inside it. The Firmware tab shows it, and flags the case that used
to be invisible — the daemon answering being a *different* build from the one
the image ships, which means an override in `/etc/config` is in use.

The binary reports the build it was made from, as `confd` in `/api/firmware` and
in the Firmware tab's footer. An override at `/etc/config/confd/confd` beats the
image's copy and survives reflashing, so which one is answering should be a
question you can ask rather than one you have to go and look.

Everything lands in
`/etc/config/confd/` — `mtd3`, jffs2, the one partition `fwu.sh` never writes —
so it survives reboots and reflashes.

**It is not a small payload.** The binary plus the six web and schema files is
about 96 KB against the partition's roughly 196 KB free, and because the binary
is staged as `confd.new` before being renamed over the live one, the peak is
nearer 116 KB. jffs2 is log-structured too, so overwriting a file does not free
its old blocks until garbage collection — even re-deploying identical content
can transiently need the whole payload again. `deploy.sh` therefore computes
what it needs from the actual files (currently **148 KB** including headroom)
and refuses below that.

That check used to be a hardcoded `-ge 80`, which was *less* than the payload:
it passed and then filled the partition. It also passed when `df` returned
nothing at all. Filling this partition puts device configuration at risk, which
is a far worse outcome than having no UI, so it now fails closed —
`FORCE=1` overrides an unreadable `df` if you have checked by hand.

The override is for iterating. Living in it means half of `mtd3` spent on a
copy of what the image already carries; flash an image built from
`odi-sandbox` instead.

## Authentication

HTTP Basic, credentials in `/etc/config/confd.auth` as `user:password`:

```sh
ssh admin@<stick> 'printf "admin:admin" > /etc/config/confd.auth; chmod 600 /etc/config/confd.auth'
```

**With no credential file, confd refuses every request.** It never runs
unauthenticated: an open config UI on the LAN is a worse outcome than no UI, and
"it stopped working" is a much better failure than "it let anyone in".

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

## Safety

`LAN_SDS_MODE`, `LAN_SPEED_MODE` and `FIBER_MODE` are marked `never` in the
schema **and** hardcoded in the generator. A wrong SerDes mode takes out telnet,
SSH, the web UI and the exporter simultaneously — every one of them arrives over
that link — leaving a serial console behind soldered UART pads. One layer of
protection is not enough for that.

Identity keys (`GPON_SN`, `MAC_KEY`, PLOAM, …) are marked `identity`: lose them
and the OLT stops authenticating the ONU.

## Keeping the data files honest

```sh
make check      # the files against each other, no device needed
```

Three checks, none of which needs a device:

| | |
|---|---|
| `check-schema.py` | `keys.tsv`, `meta.tsv` and `consumers.tsv` against each other |
| `check-assets.py` | `web/` against the daemon's `web_assets[]` table, both directions |
| `web-check.mjs` | loads the whole module graph against fixture data and renders |

The last two exist because splitting the UI into modules moved a class of
mistake from obvious to silent. A missing export, an import that resolves to
`undefined`, an import cycle leaving a binding uninitialised, or a module the
daemon will not serve — every one produces a blank page and a console error
nobody sees, because the only way to run this page is to flash a stick and open
a browser. `web-check.mjs` caught two of those the moment it was written.

The schema is generated and the metadata is hand-written, which is the right
split but lets the hand-written half drift silently. A `depends` naming a key
that does not exist makes the UI say "needs FOO=1" forever; a malformed
`options` pair renders a blank dropdown; a `meta` row for a key the device does
not have is simply never seen. None of those announce themselves.

It also refuses an `address` left in display form and a refused key not marked
`never`, which are the two ways a data edit could cause a wrong write; a `type`
the daemon does not implement, since `type_ok` fails closed and the key would
simply stop being writable; and an option value its own key's type would reject,
which would offer a control the device refuses.

Each of those was verified by injecting the fault and watching the check fail —
a check that has only ever passed has not been tested.

## Running the daemon without a stick

```sh
make smoke      # ~20s
```

`qemu-user-static` in the toolchain image runs the big-endian MIPS binary on the
build host, so the whole request path can be exercised: framing, auth, form
parsing, validation, apply classification, the routes. A stub `/etc/scripts/flash`
stands in for the device, answering in the two shapes the daemon parses, so
writes run end to end and the read-back comparison is real.

That path is worth testing precisely because it fails *silently* on hardware. It
already had a bug of exactly that shape: the whole request came from a single
`read()`, so a body the browser sent in a second TCP segment arrived empty and
the daemon answered `{"results":[],"apply":"none"}` — no error, nothing written.
A body larger than the buffer was worse, truncated mid-value and then written,
with the read-back comparing the fragment against *itself* and reporting success.

Every check in there is a bug this has actually had, and each was confirmed to
fail against the code from before its fix — 13 of the 28 do. A test that has only
ever passed proves nothing about the thing it is watching.

## Looking at it without a stick

```sh
scripts/preview.sh                       # the real binary under qemu on :18080
npm i puppeteer-core && node scripts/shot.mjs
docker rm -f odi-ui-preview              # stop it
```

`preview.sh` runs the ACTUAL daemon — same routing, same asset table, same auth
— with stubs for `/etc/scripts/flash` and `/bin/diag` answering in the shapes
the device does. `shot.mjs` drives the browser you already have, screenshots
every tab, and fails on any console error or failed request.

This is not redundant with `make check`. That proves the module graph loads and
the functions run; it cannot see that a grid rule put every label in the wrong
row. Three bugs were found the first time anyone looked at the rendered page:

- `.side.right dt { order: 1 }` — in a grid, `order` sorts **all** items as one
  sequence, so the mirrored Host column laid out three values and then three
  labels, and every row showed another row's label.
- `'+' + spec.hi` — the receive window's upper bound is −4 dBm, rendered
  `+−4 dBm`.
- A key with no value rendered as `undefined (current, not a listed value)` in
  a dropdown. Not hypothetical: several keys read `GET fail` on both sticks.

A fourth thing it caught was the *fixture* being wrong rather than the page —
the first diag stub answered every `pon get transceiver *` with one block, and
the page showed the temperature as the Rx power. Worth saying because that is
the failure mode of a harness: it can lie in the direction of alarming you.

## Keeping the schema honest

```sh
SSH_OPTS='-S /tmp/odi_ctl' scripts/schema-drift.sh admin@<stick>
```

Asserts the schema and a live device agree **in both directions**, and that no
`address` still carries the display form.

It compares three lists, not two: `flash all` parsed by a reference copy of the
parser in the script, `/api/values` as the daemon's own parser sees the same XML,
and `keys.tsv`. The schema is judged against the *daemon*, because that is what
the UI sees; the reference exists to catch the daemon's parser disagreeing with
it. Checking only against the reference left the daemon's copy untested by the
one script whose entire job is catching this kind of disagreement.

That second check exists because the two notations are easy to confuse and the
confusion is silent. A table row is *displayed* as `SW_PORT_TBL[1].PVID` — this
project's own notation — while `xmlconfig` wants `SW_PORT_TBL.1.PVID`. Handing
it the display form does not fail: it resolves to a **different entry**, writes
that, and exits 0 echoing the wrong key. Writes therefore go through the schema's
`address` column, never the name. A key on the
device but not in the schema is invisible; a key in the schema but not on the
device renders a control that can never work. Neither fails loudly on its own.
It has already earned its keep once, catching four table keys whose names the
generator had prettified.

Regenerate rather than hand-adding keys:

```sh
ssh admin@<stick> '/etc/scripts/flash all cs' > /tmp/cs
ssh admin@<stick> '/etc/scripts/flash all hs' > /tmp/hs
ssh admin@<stick> 'cat /etc/runomci.sh'       > /tmp/runomci.sh
scripts/gen-schema.py /tmp/cs /tmp/hs /tmp/runomci.sh > schema/keys.tsv
```

`type` and `apply` are worth correcting by hand afterwards; the file is checked
in for that reason.

### Hex-encoded ASCII

`GPON_PLOAM_PASSWD` stores the **hex of an ASCII string** — `1234567890` is kept
as `31323334353637383930` — so the UI shows the readable form with the hex
alongside, since the hex is what the device stores and what you would type back.

That is driven by the schema type `hexascii`, never sniffed. `INT1` holds
`2147483647`, which is valid hex and decodes to the printable nonsense `!GH6G`,
so a heuristic would mangle ordinary integers. A PLOAM password is 10 arbitrary
octets by standard and need not be printable; one that is not stays hex.

## Applying changes without a reboot

Config is read **once at boot** — `/etc/runomci.sh` builds the whole `omci_app`
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
src/confd.c         listener, auth, routing, JSON  (freestanding C, no libc)
src/util.h          base64, JSON escaping, small string helpers
src/syscall.h       copied from sfp-exporter; fix it in both places
web/                the entire UI: one page, one script, one stylesheet
schema/keys.tsv     the keyspace, generated from a device
schema/meta.tsv     curated help: labels, options, ranges, dependencies
scripts/            build verification, schema drift, deploy
```

Nothing is fetched from a CDN. The stick has no route to the internet, so
anything loaded from one renders an unstyled page exactly when you need it
most — which rules out webfonts and is why the type is a system stack with the
personality carried by large tabular numerals.

## The look

Styled as test equipment rather than as a dashboard, because that is what this
is: a fibre-optic line terminal whose measured values *are* the interface.
Structure comes from rules and space, not cards and shadows.

The two accents are taken from the objects the stick is plugged into —
singlemode jacket yellow `#E8B931` and APC connector green `#35B37E`, on cool
slate.

Three deliberate choices worth keeping:

- **Optical power is drawn on a scale, not printed as a number.** The band
  behind the needle is the class B+ window the optics is specified for, so
  −23.01 dBm is judged rather than merely reported.
- **O1 to O5 is rendered as a ladder.** It is the one thing on the page that is
  genuinely a sequence — an ONU climbs it on every registration — so it is the
  one place numbering earns its keep.
- **Forwarding shows throughput, not totals.** `omci_app` clears port 0's
  counters every performance-monitoring interval while port 2 runs free, so the
  running totals diverge wildly — 14 GB against 58 MB on a stick forwarding
  perfectly — and side by side that reads as a fault. Rates between refreshes
  mirror to within 0.1%, which is the actual test.

## Related

- `~/git/odi-sandbox` — the firmware image, provisioning runbooks, line profiles
- `~/git/sfp-exporter` — the Prometheus exporter and the freestanding runtime
- `~/git/odi-sandbox/docs/superpowers/specs/2026-09-09-config-ui-design.md` — the design
