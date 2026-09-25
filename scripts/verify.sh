#!/bin/sh
#
# Refuse a binary the target cannot execute.
#
# Two independent failure modes, both silent on the device: the wrong ELF shape
# (dynamically linked, little-endian, or expecting an interpreter that is not
# there), and instructions the RLX5281 traps on. The second is the subtle one —
# `mul`, `clz`, `teq`, `beql` and `bnel` all assemble happily for mips32 and
# SIGILL on this core, and gcc emits `teq` for every divide-by-zero check.

set -eu

BIN="${1:?usage: verify.sh <binary>}"
fail=0
ok()  { printf '  ok    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; fail=1; }

printf '\n== ELF shape\n'
desc=$(file -b "$BIN")
case "$desc" in
*"ELF 32-bit MSB"*) ok "32-bit MSB (big-endian)" ;;
*) bad "not 32-bit big-endian: $desc" ;;
esac
case "$desc" in
*MIPS*) ok "MIPS" ;;
*) bad "not MIPS: $desc" ;;
esac
case "$desc" in
*"statically linked"*) ok "statically linked" ;;
*) bad "not static: $desc" ;;
esac
case "$desc" in
*interpreter*) bad "wants an interpreter" ;;
*) ok "no interpreter" ;;
esac

printf '\n== ISA audit\n'
# The shared gate from the toolchain image (odi-toolchain isa/isa-audit):
# isa-audit refuses the instructions this core traps on and any floating
# point, disassembled at mips32 so the SPECIAL2 encodings decode as mul and
# clz rather than as .word; isa-allowlist reports any mnemonic never executed
# on the hardware. A trap fails verify; an unverified mnemonic is reported
# and does not, since the fix is to execute it on a device and extend the
# list in odi-toolchain.
# Output captured first: this is /bin/sh without pipefail, so a status read
# through a pipe into sed would be the status of sed.
out=$(isa-audit "$BIN" 2>&1) && rc=0 || rc=$?
printf '%s\n' "$out" | sed 's/^/  /'
if [ "$rc" = 0 ]; then ok "no instruction the RLX5281 traps on, no floating point"
else bad "isa-audit refused it"; fi
out=$(isa-allowlist "$BIN" 2>&1) && rc=0 || rc=$?
printf '%s\n' "$out" | sed 's/^/  /'
case $rc in
0) ok "every mnemonic confirmed on the hardware" ;;
2) printf '  WARN  unverified mnemonics above -- execute them on a device before trusting this binary\n' ;;
*) bad "isa-allowlist refused it" ;;
esac

printf '\n== size\n'
printf '  info  %s bytes\n' "$(wc -c < "$BIN" | tr -d ' ')"

[ "$fail" = 0 ] || { printf '\nverify FAILED\n'; exit 1; }
printf '\nall checks passed\n'
