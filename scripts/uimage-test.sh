#!/usr/bin/env bash
#
# src/uimage.h against an independent CRC: python's zlib builds the images, the
# C header checks them. A uImage with a good header and data CRC is accepted;
# an erased partition, a flipped data byte, a flipped header byte, a short
# write and a size that overruns the partition are not. The reference value
# for the CRC is the standard check string.
set -u
cd "$(dirname "$0")/.." || exit 1
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
cc -std=c99 -Wall -Wextra -Werror -o "$T/chk" scripts/uimage_check.c || exit 1

python3 -I - "$T" <<'PY'
import struct, sys, zlib, os
t = sys.argv[1]
data = bytes((i * 7 + 3) & 0xff for i in range(50000))
def image(data, size=None, name=b"Linux Kernel Image 6.18"):
    h = bytearray(struct.pack(">IIIIIIIBBBB32s", 0x27051956, 0, 1760000000,
                              len(data) if size is None else size, 0x80000000, 0x80000000,
                              zlib.crc32(data), 5, 5, 2, 3, name))
    struct.pack_into(">I", h, 4, zlib.crc32(bytes(h)))
    return bytes(h) + data
good = image(data)
pad = lambda b: b + b"\xff" * (0x14c000 - len(b))
open(f"{t}/good", "wb").write(pad(good))
open(f"{t}/erased", "wb").write(b"\xff" * 0x14c000)
bad = bytearray(pad(good)); bad[64 + 20000] ^= 1
open(f"{t}/flipdata", "wb").write(bytes(bad))
bad = bytearray(pad(good)); bad[40] ^= 1                  # a name byte: header CRC
open(f"{t}/fliphdr", "wb").write(bytes(bad))
open(f"{t}/short", "wb").write(pad(good)[:64 + 30000] + b"\xff" * 20000)   # cut short
open(f"{t}/oversize", "wb").write(pad(image(data, size=0x14c000)))
open(f"{t}/crcref", "wb").write(b"123456789")
open(f"{t}/crcbig", "wb").write(data * 3)
print(f"{zlib.crc32(data * 3):08x}", file=open(f"{t}/crcbig.want", "w"))
PY

t() { if [ "$2" = "$3" ]; then echo "ok    $1"; pass=$((pass + 1)); else echo "FAIL  $1: want [$2] got [$3]"; fail=$((fail + 1)); fi; }
P=$((0x14c000))
t "crc32 of the standard check string" "cbf43926" "$("$T/chk" --crc "$T/crcref")"
t "crc32 in pieces equals zlib's"      "$(cat "$T/crcbig.want")" "$("$T/chk" --crc "$T/crcbig")"
t "a good kernel partition is accepted"            ok  "$("$T/chk" "$T/good" "$P")"
t "an erased partition is refused"                 bad "$("$T/chk" "$T/erased" "$P")"
t "a flipped data byte is refused"                 bad "$("$T/chk" "$T/flipdata" "$P")"
t "a flipped header byte is refused"               bad "$("$T/chk" "$T/fliphdr" "$P")"
t "a write cut short is refused"                   bad "$("$T/chk" "$T/short" "$P")"
t "a size that overruns the partition is refused"  bad "$("$T/chk" "$T/oversize" "$P")"
t "a good image in a partition too small is refused" bad "$("$T/chk" "$T/good" 40000)"
printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
