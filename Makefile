# odi-ui — web configuration UI for the ODI DFP-34X-2C2 (Realtek RTL9601D).
#
# Everything runs in containers; nothing but Docker is needed on the host, and
# it works on macOS. The C build re-enters this Makefile inside the container
# with IN_CONTAINER=1.

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
           -fno-pic -mno-abicalls -ffreestanding -fno-builtin -fno-stack-protector
LDFLAGS := -nostdlib -nostartfiles -static -Wl,-e,_start -Wl,--build-id=none

HDRS := src/syscall.h src/util.h

$(BUILD)/confd: src/start.S src/confd.c $(HDRS) | $(BUILD)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $(filter %.S %.c,$^)
	$(STRIP) $@

$(BUILD):
	mkdir -p $@

else

RUN := docker run --rm -v "$(CURDIR)":/src -w /src $(IMAGE)

.PHONY: all confd image verify check schema test clean help

all: confd verify check

image:
	docker build -q -t $(IMAGE) . >/dev/null

confd: image
	$(RUN) make IN_CONTAINER=1 BUILD_ID='$(BUILD_ID)' $(BUILD)/confd
	@ls -l $(BUILD)/confd

# The target cannot run anything this refuses.
verify: image
	$(RUN) scripts/verify.sh $(BUILD)/confd

# The data files against each other. No device needed, so this is the one that
# runs every time: the generated schema and the hand-written metadata can drift
# apart silently, and a `depends` naming a key that does not exist makes the UI
# say "needs FOO=1" forever with nothing to notice.
check:
	scripts/check-schema.py

# Assert the schema and the device agree in both directions. Needs a stick.
schema:
	scripts/schema-drift.sh $(HOST)

test: verify check
	@echo "ok"

clean:
	rm -rf $(BUILD)

help:
	@echo "make confd    build the daemon"
	@echo "make verify   ELF shape + ISA audit"
	@echo "make check    the data files against each other, no device needed"
	@echo "make schema HOST=admin@<stick>   schema-vs-device drift check"

endif
