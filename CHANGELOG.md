# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added
- `GET /api/diag` and a "Download a diagnostics bundle" button on the Admin
  tab: confd runs the image `/etc/scripts/diag-bundle.sh` (odi-oss), which
  collects logs, the previous boot ramlog, dmesg, slot variables, an exporter
  scrape and the config with every secret redacted, and streams the tar.gz it
  wrote (up to 2 MiB, then removed). Bounded at 60 s
  (`DIAG_BUNDLE_TIMEOUT_MS`); a failure or timeout is a 500 carrying the
  script message, an image without the script a 501. Needs an odi-oss image
  that ships `diag-bundle.sh`. Covered by `make smoke` against a stub script.
- `/api/firmware` reports `slots`, each kernel partition's uImage name and
  build time (read from the mtd device found by name in `/proc/mtd`; `{}` when
  it cannot be read), and `fallback`, the sw_* of `nv fallback`, the other copy
  of the redundant U-Boot environment (empty on the stock `nv`). What a slot
  holds can then be told from the slot itself rather than from `sw_version<p>`.

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
