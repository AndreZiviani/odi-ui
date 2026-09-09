# odi-ui — web configuration UI for the ODI DFP-34X-2C2 (Realtek RTL9601D).
#
# The C build runs in a container -- Docker is all that is needed to produce the
# binary, and it works on macOS. The Makefile re-enters itself inside the
# container with IN_CONTAINER=1.
#
# `make check` is the exception: it runs scripts/check-schema.py with the host's
# python3, because it checks data files and needs no cross-compiler. `make all`
# and `make test` depend on it, so python3 is a host requirement too.

IMAGE := odi-ui-toolchain
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
        src/firmware.c src/status.c src/buffers.c
HDRS := $(wildcard src/*.h)

# One compiler invocation rather than per-object rules and a link step: there
# are eight inputs, the whole build takes under a second, and there is no
# incremental case worth the machinery. Splitting into real translation units
# was for the source, not for the build.
$(BUILD)/confd: $(SRCS) $(HDRS) | $(BUILD)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $(filter %.S %.c,$^)
	$(STRIP) $@

$(BUILD):
	mkdir -p $@

else

RUN := docker run --rm -v "$(CURDIR)":/src -w /src $(IMAGE)

.PHONY: all confd image verify check smoke schema test clean help

all: confd verify check smoke

image:
	docker build -q -t $(IMAGE) . >/dev/null

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

clean:
	rm -rf $(BUILD)

help:
	@echo "make confd    build the daemon"
	@echo "make verify   ELF shape + ISA audit"
	@echo "make check    the data files against each other, no device needed"
	@echo "make smoke    run the daemon under qemu and talk HTTP to it (~20s)"
	@echo "make schema HOST=admin@<stick>   schema-vs-device drift check"

endif
