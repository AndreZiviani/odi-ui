# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

## v1.4.0 - 2026-10-15

- The `meta.tsv` buffer in confd is 24 KB instead of 16 KB. The table had grown
  to 16.6 KB with the new keys, past the old buffer, and confd silently dropped
  the last rows (their help, options and ranges) on the device; `make check`
  caught it.

- Config, Network: a Host port control for the odi-only key `HOST_AUTONEG`
  (odi-oss: host port auto-negotiation, on by default, off forces
  1000BASE-X full duplex for a router port with auto-negotiation off). It
  never stores the key: Try runs `host-autoneg.sh try on|off`, the image
  applies the mode a second later in RAM, and a dialog counts the two-minute
  window down ("Keep this setting? Reverting in N s"); Keep runs `confirm`,
  Revert runs `revert`, and with no answer the image goes back by itself.
  The dialog polls the stick and says when it stops answering. New route
  `/api/hostlink`: GET reads the state the image keeps (`/var/run/host-autoneg`,
  the safe-mode flag and record, the host link) with no fork; POST runs one
  of four fixed verbs (try, confirm, revert on host-autoneg.sh; ack on
  safe-mode.sh), bounded at 20 s. `HOST_AUTONEG` is `writable=never` in the
  schema, so Save and Restore cannot write it, and it is on neither the
  Network nor the Stock keys list.

- A banner on every view, beside the default-password one, when the image
  changed what runs by itself: the boot fallback (`HOST_AUTONEG` is off but
  this boot found no host link forced; clears by itself at the next boot
  that brings it up), a safe-mode boot (odi-oss: the fibre off, the host
  port on auto-negotiation, the default password for that boot only; the
  banner says so and how to leave: set a password if lost, acknowledge,
  reboot), and a past safe-mode boot nobody acknowledged yet (an
  Acknowledge button, which runs `safe-mode.sh ack`).

- The safe-mode and boot-fallback banners are now the same full-width striped
  band as the trial boot, one short line each, stacked under it: "Safe mode.
  A recovery boot: the fibre (PON) is off and the default passwords work for
  this boot only", with Details and Acknowledge; after Acknowledge the bar
  stays for that boot, without the button, and says the next boot is normal;
  a later boot with an unacknowledged record says the build and the number of
  short power cycles. The long explanation (what the mode does, how to leave
  it, how to enter it, the trade-off) moved to "Locked out? The safe mode" on
  System, Access, which Details opens. The Host port block on Config, Network
  is now drawn as the other settings rows (label and help on the left, the
  buttons on the right, status as compact key/value rows, the unreachable-stick
  note as a Details disclosure) instead of a lone button in a full-width card.

- How to enter the safe mode, on System, Access ("Locked out?") and under
  Host port: plug in, wait about 80 seconds, pull, wait a few seconds;
  five times (three with the host port forced); then leave it in. The
  window is roughly 60 to 110 s after power-on, since about 54 s pass
  before the kernel starts (measured; it can vary by board). The banner no
  longer says the power-ups were under a minute: they are cut about 80 s
  after power-on, before the boot itself has run a minute.

- Safe mode: on a safe-mode boot (`/var/run/safe-mode`) the web UI accepts
  the built-in `admin:admin` instead of the saved credential, in memory
  only: `confd.auth` is not read and not touched, a password saved meanwhile
  is written to it and in force from the next boot, and the page reports
  the default as in force. `/api/hostlink` adds `safemode_now`, the flag of
  the boot, beside `safemode`, the record (now `/etc/config/safe-mode`).

- Config: an *Expert settings* disclosure, collapsed, at the foot of the ONU
  identity subtab. It warns that its keys change how the stick presents itself
  to the OLT, and holds `OMCI_UNKNOWN_ME_OK` and `OMCI_FIXED_ME`, moved out of the
  identity list. `OMCI_FIXED_ME` is now a table editor, one row per entry (class, instance, attribute,
  bytes), with Add entry and Remove, checked as you type against the rules the
  daemon enforces; the form that answers every instance shows `any` in
  instance and attribute. Saving and applying are unchanged. The key takes a
  second entry form, `CLASS:INSTANCE:ATTR:HEX` (instance 0-65535, decimal or
  `0x`; attribute 1-16), which makes an entity that exists only at that
  instance, and the limit is 16 entries. confd (type `fixedme`), the browser
  check and the help text follow. The entry form needs an odi-oss image whose
  omcid reads it (odi-oss, same batch); an older omcid turns the whole key off.

- Config: `OMCI_ACCEPT_REBOOT` gains a third option, `2` acknowledge only: the
  OLT Reboot is answered with success and the stick does not reboot. The
  help text says so.

## v1.3.2 - 2026-10-14

- Config: a select whose key is unset showed an empty box. The image always
  does something without a key, so a new settings.tsv column `unset` names
  that value for every key with options (`OLT_SW_DOWNLOAD` accept;
  `OMCI_UNKNOWN_ME_OK`, `OMCI_ACCEPT_REBOOT`, `LAN_ENABLE_IP2`,
  `VLAN_CFG_TYPE` and `VLAN_MANU_MODE` 0), and the page shows it selected,
  never "(not set)" and never an option to unset; choosing it stores
  nothing. scripts/check-schema.py requires the column for those keys.

- Config: the odi-only key `OMCI_ACCEPT_REBOOT` on the ONU identity subtab, a
  yes/no field: "Lets the OLT reboot the stick over OMCI. Off by default."
  Live, nothing to apply: omcid reads it each time a Reboot arrives. Needs an
  odi-oss image that knows the key; older images keep the value and ignore it.

## v1.3.1 - 2026-10-14

- Config: the odi-only key `OMCI_FIXED_ME` on the ONU identity subtab, up to
  8 `CLASS:HEX` entries (class 1-65535, 1 to 25 bytes of hex, optional `0x`,
  no class twice, e.g. `200:0x0011aa,201:01020304`). omcid answers an OLT Get
  of a class it has no model for with that entry's bytes; an implemented
  class is never overridden. Empty clears it, it re-registers the ONU like
  `OMCI_UNKNOWN_ME_OK`, and a malformed list is refused in the browser and in
  confd (new type `fixedme`) because omcid would turn the whole key off. The
  bytes are never logged. Pairs with odi-oss #88.
- Config: the "OLT identity" subtab is now "ONU identity". Its keys
  describe the stick (what it reports to the OLT), not the OLT, which a
  reader of the old name found misleading.

## v1.3.0 - 2026-10-13

- fix: the Commit button (`action=commit`) now runs `nv commit <slot>` and
  then `/etc/scripts/slot-state.sh`. It used to run `nv setenv sw_commit`,
  which writes one copy of the U-Boot environment and leaves the other
  naming the old slot, and nothing refreshed `/var/run/odi-slot`, which is
  written once at boot. So `OdiUncommittedImage` (the exporter's
  `gpon_uncommitted`) kept firing on a stick that had just been committed,
  and the login notice stayed. `nv commit` refuses a slot that is not the
  running one and verifies both copies; its reason is shown when it refuses.
  The reply carries `refreshed`, false when the state file could not be
  rewritten (the commit stands). The stock `nv` has no `commit` verb, and
  there the old single `nv setenv` is still used, and the note says one copy.
  Pairs with odi-oss `slot-state.sh` setting its own `PATH` and not waiting
  for syslogd on a re-run (odi-oss v1.4.0, #64); an older image still works, its
  script only lacks both. Smoke cases cover the success, the refusal, the
  failed refresh and the stock nv.
- Config: a key the firmware ignores in the current mode is shown without a
  control or a value ("Not used in this mode"), with the reason and the key
  to change first; the stored value is under Details. The VLAN ID and
  priority used to stay editable in VLAN config mode 0 and failed validation
  when cleared, so the page seemed to require a value nothing reads
  (odi-oss #29). The condition follows pending edits: choosing mode 1 unlocks
  the fields before saving, and setting it back drops an edit typed there.
  Save refuses any such edit left over; the daemon still accepts the keys, so
  a backup restore writes them as before.

## v1.2.1 - 2026-10-12

- fix: on odi-oss the Config page showed `SYSLOG_SERVER` and `NTP_SERVER` empty
  after a reload, although they were saved and `flash get` returned them.
  `flash all cs` prints the odi-only keys after the last table block, and the
  `flash all` parsers never left table context on `</Dir>`, so those keys were
  read as table values with no index and dropped. `/api/values` (src/mib.c),
  `gen-schema.py`, `capture-baseline.sh` and `schema-drift.sh` now end table
  context on `</Dir>`. The store never nests Dirs, so no stack is needed.
  New `scripts/parser-check.sh` (in `make check`) and a smoke case cover it.
- docs: repair text merged into duplicated entries by union-resolved rebases.
  The v1.1.0 section described `/api/firmware` `slots` and `fallback` twice
  and the diagnostics bundle download twice (once as on the Admin tab, once
  as on System > Logs & tools); each is now one entry, worded for the
  redesigned UI.
- AGENTS.md has a release checklist: every change since the last tag has an
  entry, no merge debris, `Unreleased` moved into the tag section, and the
  published notes checked.

## v1.2.0 - 2026-09-29

### Added
- Config rows for the keys odi-oss added: `ONU_HW_VERSION` (ONU hardware
  version, the ONU-G version some OLTs whitelist; at most 14 printable ASCII
  characters, empty removes the key; INTERRUPTS INTERNET), `OLT_SW_DOWNLOAD`
  (Firmware pushed by the ISP: accept answers and discards the image, reject
  refuses it, nothing is ever installed; LIVE, read at each download step) and
  `OMCI_UNKNOWN_ME_OK` (answer unknown entities with success; off by default,
  the risk stated in the help; INTERRUPTS INTERNET), all on the OLT identity
  subtab. New schema type `ascii14` for the first, the only odi-only key that
  can be cleared besides the `hostport` ones, and settings action `none` for a
  live key with nothing to run.
- `/api/config` answers `"interrupts"` beside `"needs"`: whether the `omci`
  action drops the fibre service (false when every key of the batch is LIVE).
- A light/dark toggle at the top right of the header, next to Sign out: a sun
  or a moon (inline SVG, no fetch) for the mode it switches to. The page still
  follows the browser's colour scheme until you pick; the pick is kept in
  localStorage (`odi-theme`) and applied from the head before first paint, so
  it does not flash. It works with storage blocked, for the page only.

### Changed
- The four VLAN keys (`VLAN_CFG_TYPE`, `VLAN_MANU_MODE`, `VLAN_MANU_TAG_VID`,
  `VLAN_MANU_TAG_PRI`) are LIVE now, not INTERRUPTS INTERNET: odi-oss omcid
  rereads the store on SIGHUP and rebuilds the bridge connections in place,
  with the ONU staying in O5, so a save applies them at once with no
  confirmation. The action stays `omci`, since `apply.sh omci` is what sends
  the signal; a batch that also carries an identity key still offers *Apply
  now* behind the confirmation, which now says omcid clears its MIB and
  re-ranges the ONU rather than restarts. `GPON_SN` moves from REBOOT to
  INTERRUPTS INTERNET with the same action: the odi-oss driver now rewrites
  the serial into the PON MAC while the ONU is deactivated, which is what the
  re-registration does. It is not verified on a stick yet.
- `VLAN_MANU_MODE` reads "1 — Stick tags" and "0 — Router tags
  (transparent): service stops unless the router tags", and its help says who
  tags the service in each. Every value that can cut the service says so in
  its option label (`VLAN_CFG_TYPE` 0, `OMCI_UNKNOWN_ME_OK` 1, `LAN_ENABLE_IP2`
  off), `OLT_SW_DOWNLOAD` says neither value touches the service, and the first
  line of the help, the one shown without Details, says how a wrong value cuts
  it for the service VLAN ID, the serial number, the PLOAM password and the
  LOID. The identity keys and the identity switch say an OLT that expects
  another identity can leave the ONU in O5 with no service.
- A save of the LIVE VLAN keys that would stop the stick tagging, start it, or
  move it to another VLAN asks first, as a Live change, and says what happens
  to the traffic (the ONU stays in O5, so nothing else would); declining writes
  nothing. A priority change alone does not ask.
- An identity key saved while the identity switch is off costs nothing: omcid
  does not report it, so it does not re-register. The save bar no longer
  counts it as INTERRUPTS INTERNET, the page does not offer *Apply now* for
  it, and the row's warning says the service is not dropped.
- `scripts/check-schema.py` fails when a schema table outgrows the confd
  buffer it is read into (`src/buffers.c`): `read_file()` stops one byte short
  without an error, so the tail rows would lose their options and help on the
  device only.
- Receive is now read at the same size as Transmit (44 px at most, was 52 px):
  one size, weight and unit style for both readouts.

## v1.1.1 - 2026-09-29

### Changed
- "Keep" is now "Commit" everywhere: the trial banner offers Commit to this
  image, the running slot Commit to partition N, the default slot is badged
  Committed, and the confirmations say what committing means. System >
  Firmware explains it under the partitions (What committing means): U-Boot
  boots the committed partition by default, a trial is one-shot, committing
  makes the running image the default, and a committed image that later fails
  keeps booting itself.
- The trial banner no longer says what the other partition holds (it is not
  always the stock firmware): "This image (partition 1) is not committed. The
  next reboot returns to partition 0." System > Firmware shows what each holds.
- The receive readout is smaller (52 px at most, was 76), closer to transmit
  (44 px), so it leads the Status page without dominating it.

- Screenshots retaken, with three new ones: `ui-mactable.png` (forwarding
  and learned addresses), `ui-trial.png` (the trial banner) and
  `ui-committing.png` (Firmware during a trial, the commit explanation open).
  The file names are stable; odi-oss links to them.

### Fixed
- Forwarding rates show at most two decimals; below 1 kB/s they printed the
  raw float.
- OMCI > Services: T-CONTs with Alloc-ID 255 (G.988: no Alloc-ID assigned on
  G.984; 65535 on later PONs) are counted as unassigned, not provisioned, so
  a line with five in use reads "5 assigned: 282, 794, 1050, 1306, 538" and
  "11 unassigned" instead of "16 provisioned".

## v1.1.0 - 2026-09-29

### Changed
- The web UI is redesigned. Four sections with subtabs replace the eight flat
  tabs: Status; Config (Line, VLAN, OLT identity, Network, Services, Stock
  keys); OMCI (Services, MIB browser); System (Firmware, Access, Backup &
  reset, Logs & tools). The hash names the view (`#config/vlan`), old tab names
  still land, and both levels are keyboard tablists.
- Settings rows show a label, one line of help and a Details disclosure,
  beside the control and its cost; on a phone they stack, and the page no
  longer scrolls sideways. The four apply classes share one badge (one to four
  bars in the class colour) on each key, in the sticky save bar ("3 changes",
  "2 interrupts internet", "1 live"), on the apply buttons and in the
  confirmations. Subtabs count their unsaved changes.
- The receive and transmit levels are drawn as instruments: the reading on the
  class B+ window, with the margin to each edge as dimension lines, and a
  verdict (in window, near the edge, out of window). Near the edge is the
  outer 16% of each window (about 3 dB receive, 0.7 dB transmit); the windows
  are the ONU class B+ figures from ITU-T G.984.2 Amendment 1. A header pill repeats the
  ONU state and receive level on every view.
- New palette from the fibre world (singlemode yellow, APC green, UPC blue,
  alarm red on cool slate), with a light theme following
  `prefers-color-scheme`, checked for WCAG AA. Readouts use a 2.4 KB subset of
  B612 Bold (SIL OFL), embedded in `style.css`; nothing is fetched.
- Long explanations moved behind disclosures next to what they explain; the
  per-tab "Why this device behaves this way" blocks and hover popovers are gone,
  their text kept.
- The default-password banner shows on Status and System > Access; elsewhere it
  is a small header chip.

### Added
- `GET /api/diag` and a "Download a diagnostics bundle" button on System >
  Logs & tools: confd runs the image `/etc/scripts/diag-bundle.sh` (odi-oss),
  which collects logs, the previous boot ramlog, dmesg, slot variables, an exporter
  scrape and the config with every secret redacted, and streams the tar.gz it
  wrote (up to 2 MiB, then removed). Bounded at 60 s
  (`DIAG_BUNDLE_TIMEOUT_MS`); a failure or timeout is a 500 carrying the
  script message, an image without the script a 501. Needs an odi-oss image
  that ships `diag-bundle.sh`. Covered by `make smoke` against a stub script.
- A trial-boot band in the header on every view while `sw_commit`, in either
  environment copy, names another slot than the running one: where the next
  reboot goes, what that slot holds, and Keep this image (the existing commit).
  Not dismissible.
- `/api/firmware` reports `slots` (each kernel partition's uImage name and
  build time, read from the mtd device found by name in `/proc/mtd`; `{}` when
  it cannot be read) and `fallback` (the sw_* of `nv fallback`, the other copy
  of the redundant U-Boot environment; empty on the stock `nv`). The Firmware
  view names what each slot holds from that, not from U-Boot `sw_version<p>`,
  and when the other slot holds the stock firmware it says that writing
  replaces it and loses it as a fallback, and asks a second time.
- Kernel log: heartbeat lines (`rcS: alive`, `odi_wdt: alive`) are hidden by
  default and counted, with a checkbox to show them; levels render as words.

### Fixed
- Config help was printed twice where `meta.tsv` and `settings.tsv` said the
  same thing (SYSLOG_SERVER, NTP_SERVER, the identity keys, the VLAN ID). The
  duplicated sentences are removed from the data, and the page drops a note
  sentence the help already said.
- OMCI Services: the parser reads the odi-oss omcid dump shape (`268
  GemPortCtp 1`, raw attribute bytes, `N rows`), so GEM ports are listed instead
  of "The OLT has not created any". An empty read of an entity the ONU creates
  itself (software image, OLT-G, T-CONT) is shown as "Could not read", never as
  none; each card shows reading, could not read, none, or its rows.
- Kernel log: `<12>`-style userland priority prefixes (facility and level) are
  stripped and the level read from the low three bits; the stale "there is no
  syslog here" note is replaced.
- Firmware: an override is recognised by the path the running confd was started
  from (`/api/firmware` now reports `exe`), not by comparing build ids, so a local
  build (`confd=local` in `/etc/odi-build`) is no longer called an override.
  Try is offered only on the slot not running; the running, uncommitted slot
  offers Keep this image, the same action as the trial banner.
- The Reboot button reads "Reboot" with its cost badge, not "Reboot now —
  REBOOT"; the SSH key Remove button matches the other buttons.

## v1.0.8 - 2026-09-28

### Fixed
- `SYSLOG_SERVER` and `NTP_SERVER` can be cleared from the Config page: an empty
  value is accepted for `hostport` keys, by confd and by the page. Needs
  odi-oss v1.0.8 or later, whose `flash` stores these two keys in
  `/etc/config/odi.conf` and removes the key on an empty value. Other keys still
  refuse an empty value.

## v1.0.7 - 2026-09-28

### Added
- `SYSLOG_SERVER` and `NTP_SERVER` are set from the Config page (under
  "other") and apply as SERVICE RESTART: after the save the page runs
  `apply.sh syslog` / `apply.sh ntp` through `/api/apply`, which kills the
  daemon so busybox init respawns it and it rereads the store. The run is
  bounded by the same `APPLY_TIMEOUT_MS` as every other apply. The fibre
  service is not touched. Both keys have a new `hostport` schema type
  (IPv4 literal or hostname, optional `:port` 1-65535; no spaces or quotes),
  checked by confd and by the page, and rows in `settings.tsv`.
  `/api/apply` accepts `what=syslog` and `what=ntp`, and a save reports them
  in `needs`. Note: confd refuses an empty value, so a key cannot be cleared
  from the page.

## v1.0.6 - 2026-09-28

### Fixed
- Bounded every wait confd does on a forked child (`omcicli`, `diag`,
  `flash`, `apply.sh`, `fwu_starter.sh`, `nv`, `ping`, `md5sum`, `mkdir`) with
  a per-command timeout: past it the child is SIGKILLed and reaped instead of
  leaving the daemon parked in `read()`/`waitpid()` forever, which would
  freeze every other request behind it (confd is single-threaded). Mirrors a
  fix in the sibling `odi-sfp-exporter` for the same failure mode (a stuck
  `omcid` left a child never answering). Also bounded the host-side
  `scripts/deploy.sh`, `capture-omci.sh`, `capture-baseline.sh` and
  `schema-drift.sh` ssh sessions with `ConnectTimeout`/`ServerAlive*`, which
  had none.

## v1.0.5 - 2026-09-25

### Added
- Pinned the shared `odi-toolchain` build image by digest instead of a
  floating tag.

### Changed
- Reordered the config sections, added a MIB class picker, and swept the
  deployment text for accuracy.
- Relicensed the project GPL-2.0-only, matching the kernel it runs
  alongside.

## v1.0.4 - 2026-09-24

### Added
- Enabled the MAC table on odi-oss and show multicast groups in it.

## v1.0.3 - 2026-09-24

### Fixed
- Corrected the smoke suite oversized-body check to send 20 KB instead of
  64 KB.

## v1.0.2 - 2026-09-24

### Added
- Added a release workflow and `make assets`/`make sums`/`make release`
  targets, mirroring `sfp-exporter`.
- `AGENTS.md`: guidance for coding agents working in this repo.
- README: documented the SSH keys section (Admin tab, `/api/sshkeys`, the
  key file and its `-D` contract).
- odi-oss: show only the config keys the image actually reads, each with
  its apply class.

### Changed
- `make assets` now runs inside the build container, since `build/` ends up
  root-owned on Linux runners.

### Fixed
- A confd whose build stamp does not match its tag is now refused at
  publish time, instead of shipping silently.

## v1.0.1 - 2026-09-21

### Added
- SSH public keys for device login: `/api/sshkeys` (list, add, delete) and
  an SSH keys block on the Admin page. Keys live in
  `/etc/config/dropbear.d/authorized_keys`, paired with an odi-oss image
  that starts dropbear with `-D` on that directory.

## v1.0.0 - 2026-09-12

First tagged release of `confd`, the web configuration UI for the ODI
DFP-34X-2C2 (Realtek RTL9601D/RTL9602C): a freestanding, static, big-endian
MIPS-I binary with no libc and no PIC.

### Added
- Read-only and then read-write configuration UI for the device, with
  everyday and advanced config tabs, field-level guidance (labels, options,
  ranges and dependencies), and a picker for OMCI ME classes.
- Firmware tab: upload and write a firmware image from the page, and surface
  the version chain, the `RX_LOS` trap, and the auth difference between
  images.
- OMCI MIB pages: a decoded Services view and a raw MIB view, plus decoding
  of the `OMCI_CUSTOM_*` feature bitmasks from the image own symbol tables.
- Tools tab: the kernel log, and ping from the stick.
- Admin: set the config UI password from the page (creating the credential
  file if needed), with a built-in `admin`/`admin` fallback when none
  exists yet.
- One-click config backup, and restore from a backup, from the page.
- Reset the service configuration from the page, with an automatic backup
  first.
- Show the switch's learned addresses.
- Serve the image build manifest, so the UI can show what it is actually
  running.
- `make verify` (ELF shape plus the RLX5281 instruction audit), `make check`
  (the data files checked against each other) and `make smoke` (the daemon
  run under qemu, 131 HTTP checks) as the non-device test gate.

### Changed
- Split the UI into modules served from an allowlist, and split `confd.c`
  into translation units, then turned on LTO to recover the code size that
  split cost.
- Centred the tabs, dropped the hostname from the chrome, and documented
  uploading an image.

### Fixed
- Made the request parser read a whole request and fail closed on anything
  else it does not recognize.
- Made `verify` and `BUILD_ID` real dependencies of the build, so a stale
  build stamp can never ship.
- Computed deploy space checks from the actual files against the jffs2
  compressed layout, instead of raw byte counts, and stopped inventing
  VLAN 0.
- Fixed rendering bugs found by reading through the page, and stopped
  `/api/l2` from hanging.
