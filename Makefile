# odi-ui — web configuration UI for the ODI DFP-34X-2C2 (Realtek RTL9601D).
#
# The C build runs in a container -- Docker is all that is needed to produce the
# binary, and it works on macOS. The Makefile re-enters itself inside the
# container with IN_CONTAINER=1.
#
# `make check` is the exception: it runs scripts/check-schema.py with the host's
# python3, because it checks data files and needs no cross-compiler. `make all`
# and `make test` depend on it, so python3 is a host requirement too.

# The toolchain container: the freestanding image from odi-toolchain, pinned
# by digest in toolchain.env and pulled on first use; TOOLCHAIN_IMAGE
# overrides it (scripts/toolchain-image.sh, docs/BUILDING.md). Exported so
# scripts/smoke.sh runs in the same image.
include toolchain.env
TOOLCHAIN_IMAGE ?= $(TOOLCHAIN_IMAGE_PINNED)
export TOOLCHAIN_IMAGE
IMAGE := $(TOOLCHAIN_IMAGE)
BUILD := build

BUILD_ID ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo unknown)

ifeq ($(IN_CONTAINER),1)

CROSS := mips-linux-gnu-
CC    := $(CROSS)gcc
STRIP := $(CROSS)strip

# Identical to sfp-exporter's, and for the same reasons: MIPS-I because the
# RLX5281 traps on much of MIPS32, big-endian, no FPU, no GOT, and freestanding
# so nothing is quietly turned back into a libc call.
CFLAGS  := -std=c99 -Os -Wall -Wextra \
           -march=mips1 -mabi=32 -EB -msoft-float -G0 \
           -fno-pic -mno-abicalls -ffreestanding -fno-builtin -fno-stack-protector \
           -flto \
           -DBUILD_ID='"$(BUILD_ID)"' 
# -flto on both sides. Splitting confd.c into translation units cost 6.5 KB of
# lost cross-file inlining (20664 -> 27208); LTO gives it back at 20712, within
# 48 bytes of the single-file build. `make verify` re-runs the ISA audit on the
# result, which is the check that matters: LTO changes codegen, and this core
# traps on instructions GCC will happily emit.
LDFLAGS := -nostdlib -nostartfiles -static -Wl,-e,_start -Wl,--build-id=none -flto

SRCS := src/start.S src/main.c src/routes.c src/http.c src/mib.c \
        src/firmware.c src/status.c src/omci.c src/buffers.c
HDRS := $(wildcard src/*.h)

# One compiler invocation rather than per-object rules and a link step: there
# are eight inputs, the whole build takes under a second, and there is no
# incremental case worth the machinery. Splitting into real translation units
# was for the source, not for the build.
# BUILD_ID is compiled in, but it is a make VARIABLE -- make cannot see it
# change, so with the sources untouched it will not rebuild and the binary keeps
# whatever stamp it was last compiled with. sfp-exporter shipped exactly that: a
# manifest naming one exporter version and a binary reporting another.
#
# Park the value in a file and depend on the file. FORCE runs the recipe every
# time; `cmp` means the file -- and its mtime -- only moves when the value
# actually differs.
.PHONY: FORCE
$(BUILD)/.build-id: FORCE | $(BUILD)
	@printf '%s' '$(BUILD_ID)' | cmp -s - $@ 2>/dev/null || printf '%s' '$(BUILD_ID)' > $@

$(BUILD)/confd: $(SRCS) $(HDRS) $(BUILD)/.build-id | $(BUILD)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $(filter %.S %.c,$^)
	$(STRIP) $@

$(BUILD):
	mkdir -p $@

else

RUN := docker run --rm -v "$(CURDIR)":/src -w /src $(IMAGE)

.PHONY: all confd image verify check smoke schema test clean help assets sums release stamp

all: confd verify check smoke

image:
	@TOOLCHAIN_IMAGE='$(IMAGE)' scripts/toolchain-image.sh >/dev/null

confd: image
	$(RUN) make IN_CONTAINER=1 BUILD_ID='$(BUILD_ID)' $(BUILD)/confd
	@ls -l $(BUILD)/confd

# The target cannot run anything this refuses.
#
# Depends on confd, not just on the container: `verify` and `test` on a clean
# tree used to fail with "cannot open build/confd", which reads like a broken
# check rather than a missing build step. `all` only worked because confd
# happened to be listed first, and -j would have broken that too.
verify: confd
	$(RUN) scripts/verify.sh $(BUILD)/confd

# The data files against each other. No device needed, so this is the one that
# runs every time: the generated schema and the hand-written metadata can drift
# apart silently, and a `depends` naming a key that does not exist makes the UI
# say "needs FOO=1" forever with nothing to notice.
check:
	scripts/check-schema.py
	scripts/check-assets.py
	node scripts/web-check.mjs

# Run the daemon under qemu and talk HTTP to it. No stick needed: it is the
# request path -- framing, auth, form parsing, validation -- that fails silently
# on real hardware, and every case in there is a bug this has actually had.
# The idle-client check waits out a 15 s socket timeout, so budget ~20 s.
smoke: confd
	scripts/smoke.sh

# Assert the schema and the device agree in both directions. Needs a stick.
schema:
	scripts/schema-drift.sh $(HOST)

test: verify check smoke
	@echo "ok"

# The release assets, in the layout the odi-oss image builder unpacks
# (src/fetch-releases.sh): the web files and the four schema tables flat in
# one tarball, the daemon beside it, and one SHA256SUMS over both. What the
# workflow publishes on a v* tag is exactly this, so a tag cannot fail on
# something `make release` would have caught locally.
# Inside the container, like sums: build/ is created by the container as root,
# so on Linux -- every CI runner -- the host user cannot write into it. macOS
# maps the ownership and hides that.
assets: | $(BUILD)
	$(RUN) sh -c 'rm -rf $(BUILD)/assets && mkdir -p $(BUILD)/assets && cp web/* schema/*.tsv $(BUILD)/assets/ && tar -C $(BUILD)/assets -czf $(BUILD)/confd-assets.tar.gz .'

sums: confd assets
	$(RUN) sh -c 'cd $(BUILD) && sha256sum confd confd-assets.tar.gz > SHA256SUMS && cat SHA256SUMS'

# The stamp names the release, or nothing is published: HEAD exactly a v* tag,
# a clean tree, and that tag compiled into build/confd. v1.0.1 shipped a
# binary reporting v1.0.0-dirty because nothing checked.
stamp: confd
	scripts/check-stamp.sh

release: confd stamp verify check smoke assets sums

$(BUILD):
	mkdir -p $@

clean:
	rm -rf $(BUILD)

help:
	@echo "make confd    build the daemon"
	@echo "make verify   ELF shape + ISA audit"
	@echo "make check    the data files against each other, no device needed"
	@echo "make smoke    run the daemon under qemu and talk HTTP to it (~20s)"
	@echo "make schema HOST=admin@<stick>   schema-vs-device drift check"

endif
