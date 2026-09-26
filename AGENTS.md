# AGENTS.md

Guidance for any coding agent (or human) working in this repository. Read
the top-level `README.md` first for what this project is, and
[`docs/DESIGN.md`](docs/DESIGN.md) for why it is built the way it is; this
file is about how to work in it safely and correctly.

## What this is, and how it fits with the firmware image

`odi-ui` builds `confd`, a small web configuration UI (daemon + static
JS/HTML + a data-driven schema) that runs **on** an RTL9601-based GPON SFP
ONU stick, part of the [odi-oss](https://github.com/AndreZiviani/odi-oss)
firmware project. On the stock/OEM firmware `confd` runs alongside the
vendor's own web server, on its own port, rather than replacing it; on the
odi-oss image the vendor server is gone entirely and `confd` replaces it,
serving on port 80. The device does no templating: `confd` serves a static
page and a JSON API, and the browser renders forms generically from a schema
file, so adding a configuration key is a data change, not a new C handler.

This repo does not build a flashable firmware image. The
[odi-sandbox](https://github.com/AndreZiviani/odi-sandbox) firmware project
consumes this repo's **releases** (the `confd` binary, a
`confd-assets.tar.gz` bundle of the web files and schema tables, and
`SHA256SUMS`, verified before use) rather than its source, and bakes them
into a custom image alongside the stock vendor firmware and a metrics
exporter. `confd` is not self-contained: without the asset bundle beside it,
it starts, listens, and answers 404 to everything -- a failure that looks
like success from the build side. If you are looking for image-building,
flashing, or device-provisioning logic, it lives in that other project, not
here.

## Layout

    src/                 the daemon: main.c, routes.c, http.c, mib.c,
                          firmware.c, status.c, omci.c, buffers.c, start.S
    web/                 the static page: app.js plus one module per tab
                          (status.js, config.js, l2.js, omci.js, ...)
    schema/               keys.tsv, meta.tsv, consumers.tsv, features.tsv, settings.tsv --
                          the data the UI is generated from
    scripts/              build/check/deploy tooling -- see below
    toolchain.env         the toolchain image (odi-toolchain freestanding), pinned by digest
    scripts/toolchain-image.sh  prints (and pulls) it; docs/BUILDING.md has the details
    Makefile               every target below; re-enters itself with IN_CONTAINER=1
    .github/workflows/release.yml   build + gate on every push, publish on v* tags

## Build and test commands

    make confd     # build build/confd (needs Docker only)
    make verify    # ELF shape + instruction audit against the RLX5281
    make check     # schema/assets/web-module consistency -- no device needed;
                    # needs the host's python3 and node, no cross-compiler
    make smoke     # run confd under qemu and talk HTTP to it (~20s): framing,
                    # auth, form parsing, validation -- this is the request
                    # path that fails silently on real hardware
    make schema HOST=admin@<stick>   # schema-vs-device drift check; needs a stick
    make test      # verify + check + smoke -- the full non-device gate
    make all       # confd + verify + check + smoke
    make assets    # the release tarball: web/*.html/css/js + schema/*.tsv
    make sums      # SHA256SUMS over confd + confd-assets.tar.gz
    make release   # confd + verify + check + smoke + assets + sums --
                    # exactly what CI runs on a tag
    make clean

## Release process

Every push and PR builds and gates the daemon (`make confd verify check
smoke`) so a tag can never fail on something an ordinary commit would have
caught. Only a `v*` tag publishes a GitHub release, with `confd`,
`confd-assets.tar.gz`, and `SHA256SUMS` as assets. `BUILD_ID` is `git
describe --tags --always --dirty`, computed on the host (the toolchain
container has no git history) and compiled in, reported by `confd` itself
and shown in the Firmware tab -- this is how you tell an on-device override
apart from what the flashed image actually ships. A shallow checkout breaks
this silently by making every tag describe as `unknown`; CI always fetches
full history. Never publish a release by hand: `scripts/check-stamp.sh`
refuses a binary whose stamp is not exactly the tag from a clean tree, and
v1.0.1 (a hand upload reporting `v1.0.0-dirty`) is why.

## Coding rules

- **Freestanding C, no libc, no dependencies.** `-nostdlib -nostartfiles
  -static`, one hand-written `_start` in `src/start.S`, raw syscalls. There
  is no libc worth linking against on this device; going freestanding
  removes the ISA-compatibility question entirely.
- **Big-endian MIPS-I, targeting a specific trapping core.** The RLX5281
  core implements the MIPS instruction set in pieces: `movz`/`movn`/`ll`/
  `sc`/`sync`/`bltzl`/`madd` are confirmed to work; `mul`, `clz` (and the
  rest of the SPECIAL2 class), `teq`/`tne`/`tge`/`tlt`, and `beql`/`bnel`
  are confirmed illegal and raise SIGILL. Every build uses `-march=mips1
  -mabi=32 -EB -msoft-float -G0 -fno-pic -mno-abicalls -ffreestanding
  -fno-builtin -fno-stack-protector`, plus `-flto` (splitting the daemon
  into translation units cost measurable code size back before LTO
  recovered it -- keep `make verify`'s ISA audit in the loop whenever you
  touch `-flto` or split files further, since LTO changes codegen and this
  core traps on instructions GCC will happily emit). Do not raise
  `-march`, add FPU code, or assume a generic MIPS32 toolchain default is
  safe here.
  - `make verify` is the actual gate: ELF shape (ELF32, big-endian, MIPS,
    static, no `PT_INTERP`, no `NEEDED`) plus the shared instruction audit
    from the toolchain image (`isa-audit`, fatal; `isa-allowlist`, which
    reports anything never executed on the hardware). Run it after any codegen-affecting change,
    not just after a normal edit.
- **No apostrophes in shell-script comments.** A single quote inside a
  single-quoted inline block (e.g. `bash -c '...'`) silently terminates the
  shell word and runs the rest of the line in the outer shell. Rephrase;
  do not escape.
- **A write is validated server-side and read back**, never trusted from
  `flash set`'s exit code alone -- that command reports success for things
  it did not do. Keep that pattern (validate by type, apply, read back,
  compare) for any new writable key.
- **Cross-site writes are refused**: a POST whose `Origin` does not match
  `Host` gets `403`. Do not relax this to make local testing easier.
- **Nothing is applied implicitly.** A config write does nothing on the
  device until its reader re-reads it (omcid or `omci_app` restarts,
  `apply.sh network`, or a reboot); the API reports which apply class and
  which actions a change needs and lets the caller decide. Do not have a
  route restart or reboot on its own. `schema/settings.tsv` is the image own
  table of what each key costs; keep a key out of it unless the image reads
  it, and keep its class matching its action (`make check` enforces both).
- **The MIB browser must never be able to break the MIB service it
  displays.** `/api/omci` refuses `get tables` outright -- see "The MIB
  tabs" in `docs/DESIGN.md` for why. Any change to that route needs to preserve
  the refusal and its smoke check.
- Sizing anything written to the device's config partition is done from
  **measured, compressed size**, not `wc -c`: `/etc/config` is jffs2, which
  compresses on write and allocates in whole erase blocks. See
  `scripts/deploy.sh`'s comments before changing what counts as "how much
  room a deploy needs" -- a wrong estimate has previously both under- and
  over-refused a deploy that actually fit or did not.

## Testing on a stick safely

- **Never replace the running `confd` in place.** `scripts/deploy.sh`
  stages the new binary as `confd.new` in the same jffs2 filesystem, waits
  for the old process to exit, verifies the md5 of what actually landed on
  the device against the local build, and only then renames it over the
  live path -- rename within one filesystem is atomic, so the live path is
  never a partially written binary. It also fails closed if it cannot read
  free space on the target partition, and refuses to run a binary that
  is not `file`-confirmed big-endian MIPS.
  `SSH_OPTS='...' scripts/deploy.sh admin@<stick> [port]`.
- This install path is for iterating, not for living in: it survives
  reboots and reflashes (it lands on the same jffs2 partition the image
  build never writes), but the released asset bundle is what a flashed
  image actually ships, and the two can drift -- the Firmware tab's build
  info is how you notice that.
- This repo does not flash firmware and has no `sw_tryactive`/`sw_commit`
  logic; if your task involves writing to a flash partition or a boot slot,
  that is out of scope here.
- With no auth file present on the device, `confd` answers to a built-in
  weak default credential (set on first use, from the Config tab or by
  hand) -- do not remove that fallback path, since a factory reset erases
  the auth file along with everything else in `/etc/config`, and a config
  UI that then refuses everyone is worse than one with a known-weak
  default that is still checked and still returns 401 on a wrong password.

## Dangerous commands on the stick

These are properties of the device's other userland tools, not of `confd`
itself, but anyone testing on real hardware needs to know them:

- **`omcicli get tables` wedges the OMCI daemon** -- it returns zero bytes
  and leaves every later `mib get` empty until the daemon is restarted.
  `confd`'s own MIB route already refuses this verb; do not call it
  directly from a script either.
- **`diag`, read from a stdin that never closes, spins at 100% CPU.** Any
  script or shell that pipes to `diag` and leaves stdin open (no EOF, no
  command) will peg the CPU. Always give it a way to see EOF, or wrap the
  invocation in a timeout.
- **Reading an undecoded SoC register address with `devmem` can stall the
  bus until the hardware watchdog resets the device.** Do not probe
  addresses you cannot already account for.
