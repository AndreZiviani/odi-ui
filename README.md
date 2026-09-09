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

## Status: phase 1, read-only

There is **no write path in this binary at all** — not disabled, absent.

| phase | scope | |
|---|---|---|
| **1** | schema, values, status | **done** |
| 2 | writes for the provisioning key set, verified, with apply | |
| 3 | remaining scalars and `SW_PORT_TBL` rows | |
| 4 | firmware upload and `sw_tryactive` trial boot | |

## Build and deploy

```sh
make confd                                  # -> build/confd, ~9 KB
make verify                                 # ELF shape + ISA audit
SSH_OPTS='-S /tmp/odi_ctl' scripts/deploy.sh admin@<stick> 8080
```

Docker is the only requirement; it runs on macOS. Everything lands in
`/etc/config/confd/` — `mtd3`, jffs2, the one partition `fwu.sh` never writes —
so it survives reboots and reflashes. About 35 KB of roughly 196 KB free, and
`deploy.sh` refuses to install if the partition is tight, because filling it
puts device configuration at risk.

## Authentication

HTTP Basic, credentials in `/etc/config/confd.auth` as `user:password`:

```sh
ssh admin@<stick> 'printf "admin:CHANGEME" > /etc/config/confd.auth; chmod 600 /etc/config/confd.auth'
```

**With no credential file, confd refuses every request.** It never runs
unauthenticated: an open config UI on the LAN is a worse outcome than no UI, and
"it stopped working" is a much better failure than "it let anyone in".

### There is no session

HTTP Basic is stateless, so this is worth being explicit about:

- **No session, no cookie, no token, and no expiry.** The browser caches the
  credential and replays it on every request; each one is authenticated
  independently.
- **No logout**, short of closing the browser or clearing its credential store.
- Failed attempts are **delayed one second**. Without that, the only limit on
  guessing was how fast the device could answer — measured at **319
  attempts/sec**, enough to walk a human-chosen password. The daemon is
  single-threaded and serial, so the delay is a hard global rate limit rather
  than a per-connection one: an attacker cannot open more sockets to go faster.
  Measured after: **1/sec**, with correct logins unaffected.

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

## Keeping the schema honest

```sh
SSH_OPTS='-S /tmp/odi_ctl' scripts/schema-drift.sh admin@<stick>
```

Asserts the schema and a live device agree **in both directions**. A key on the
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
scripts/            build verification, schema drift, deploy
```

Nothing is fetched from a CDN. The stick has no route to the internet, so
anything loaded from one renders an unstyled page exactly when you need it
most.

## Related

- `~/git/odi-sandbox` — the firmware image, provisioning runbooks, line profiles
- `~/git/sfp-exporter` — the Prometheus exporter and the freestanding runtime
- `~/git/odi-sandbox/docs/superpowers/specs/2026-09-09-config-ui-design.md` — the design
