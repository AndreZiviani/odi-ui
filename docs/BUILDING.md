# Building, testing and deploying

Everything compiles in a container; the host needs Docker and `make`.

    make            # confd, verify (ELF shape + ISA audit), check, smoke
    make release    # everything CI does, including the assets and SHA256SUMS

## The toolchain image

The container is the **freestanding toolchain image** from the
odi-toolchain repository (<https://github.com/AndreZiviani/odi-toolchain>),
shared with the other projects for this stick: Debian `gcc-mips-linux-gnu`,
`qemu-mips-static`, and the shared ISA audit (`isa-audit`,
`isa-allowlist`). `toolchain.env` pins it **by digest** -- the one place that
names it -- and `scripts/toolchain-image.sh` pulls it on first use; every
make target that needs it goes through that script (`make image`), and so do
`scripts/smoke.sh` and `scripts/preview.sh`. It is published for
`linux/amd64` and `linux/arm64`.

**The pull needs no login or token.** The package is public, so
`scripts/toolchain-image.sh` pulls it anonymously. A `GITHUB_TOKEN` (or any
token with `read:packages`) is accepted **optionally**, only to raise
ghcr.io's anonymous-pull rate limit if you hit it in CI or a busy build
machine -- it is never required for an ordinary pull:

    echo "$TOKEN" | docker login ghcr.io -u <github user> --password-stdin

A failed pull says this and prints the fallback below.

## Building the image locally instead

    git clone https://github.com/AndreZiviani/odi-toolchain
    make -C odi-toolchain freestanding          # tags odi-toolchain-freestanding:local
    TOOLCHAIN_IMAGE=odi-toolchain-freestanding:local make

A local tag is used as is and never pulled. The binary it builds is the same
as with the pinned image: v1.0.3 rebuilt with it is byte-for-byte the
released `confd`.

## Moving the pin

Tag a new image version in odi-toolchain, take the digest from the summary
of its publish run, change `toolchain.env`, and rebuild. The binary should
come out identical to the one the old pin produced; if it does not, every
difference needs a reason before the change merges.

## CI

`.github/workflows/release.yml` pulls the pinned image anonymously and
builds. No login step is needed for that pull; see "The toolchain image"
above for the optional token.

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

## Build and deploy

```sh
make confd                                  # -> build/confd, ~20 KB
make test                                   # ELF shape + ISA audit, data files, HTTP
SSH_OPTS='-S /tmp/odi_ctl' scripts/deploy.sh admin@<stick> 8080
```

Docker builds and runs everything, in the shared freestanding toolchain image
from [odi-toolchain](https://github.com/AndreZiviani/odi-toolchain), pinned by
digest in `toolchain.env` and pulled on first use (above has the token details
and building it locally instead). `make check` also needs the host's
`python3` and `node`, since it reads data files and loads the web modules and
wants no cross-compiler. It runs on macOS.

`/api/firmware` also returns a `build` object read from `/etc/odi-build`, the
manifest the image build writes: which image, which base, and which `confd` and
exporter are inside it. The Firmware tab shows it, and flags the case that used
to be invisible — the daemon answering being a *different* build from the one
the image ships, which means an override in `/etc/config` is in use.

The binary reports the build it was made from, as `confd` in `/api/firmware` and
in the Firmware tab's footer. A release is built from its tag only:
`scripts/check-stamp.sh` (run by `make release`, and by the workflow on a `v*`
tag) refuses unless HEAD is exactly the tag, the tree is clean, and the binary
carries that tag. v1.0.1 was published by hand before the workflow existed, from
a tree still on v1.0.0 with the SSH-key change uncommitted, which is why that
release reports itself as `v1.0.0-dirty`. An override at `/etc/config/confd/confd` beats the
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

## In the firmware image

`~/git/odi-sandbox` builds `confd` and its assets into the image and starts it
from `rc35`, so a flashed stick serves this without anything being started by
hand. Until such an image is flashed, the deploy above is what puts it there —
and it does not survive a reboot.

## Sizing a deploy against jffs2, not against your disk

`/etc/config` is **jffs2, which compresses on write**, so summing `wc -c` to
decide whether a payload fits over-counts text by about three times. That guard
once refused a deploy that fits comfortably: 244 KB estimated, 188 KB free, and
72 KB actually consumed.

The model is measured. Uploading a 29,000-byte binary moved free space by
exactly **16,384** bytes; that file gzips to 13,782, and
`ceil(13782 / 4096) * 4096` is 16,384 — compress, then allocate whole 4 KB
erase blocks (`erasesize` from `/proc/mtd`). So `deploy.sh` compresses each file
with `gzip -6` — zlib's default, which is what jffs2 uses, keeping the estimate
pessimistic — and rounds each to a block.

Two things that still bite:

- **A re-deploy can be refused even though the same payload just fitted.** jffs2
  is log-structured: overwriting a file does not free its old blocks until
  garbage collection. Deleting the override directory frees them immediately.
- The partition is 240 KB **total**, shared with the device identity and the
  exporter override, so the headroom is not ceremony.

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
