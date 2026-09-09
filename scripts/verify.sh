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
# An allowlist of what has been proven on the hardware would be stricter, but
# the failure that actually happens is one of these five, so name them.
TRAPS='mul clz teq beql bnel beqzl bnezl'
dis=$(mips-linux-gnu-objdump -d "$BIN")
for m in $TRAPS; do
	n=$(printf '%s\n' "$dis" | awk -v m="$m" '$3==m' | wc -l | tr -d ' ')
	if [ "$n" = 0 ]; then ok "no $m"; else bad "$n x $m -- the RLX5281 traps on this"; fi
done
n=$(printf '%s\n' "$dis" | grep -cE '\s(add|sub|mul|div)\.[sd]\s' || true)
if [ "$n" = 0 ]; then ok "no floating point (this core has no FPU)"; else bad "$n FP instructions"; fi

printf '\n== size\n'
printf '  info  %s bytes\n' "$(wc -c < "$BIN" | tr -d ' ')"

[ "$fail" = 0 ] || { printf '\nverify FAILED\n'; exit 1; }
printf '\nall checks passed\n'
