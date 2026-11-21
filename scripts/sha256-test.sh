#!/usr/bin/env bash
#
# src/sha256.c against the published vectors, and against an independent
# implementation: the same source the daemon is built from, compiled for the
# host, next to hashlib in python. SHA-256 from FIPS 180-4 (the empty message,
# "abc", the 448-bit message, a million "a"), HMAC from RFC 4231, PBKDF2 from
# RFC 7914 section 11 and the usual "password"/"salt" set. A hash that is
# wrong still hashes: every sign-in would work until the day the file is
# read by another implementation, so this is the only place it can be caught.
set -u
cd "$(dirname "$0")/.." || exit 1
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
cc -std=c99 -Wall -Wextra -Werror -o "$T/chk" scripts/sha256_check.c src/sha256.c || exit 1

t() { if [ -n "$3" ] && [ "$2" = "$3" ]; then echo "ok    $1"; pass=$((pass + 1)); else echo "FAIL  $1: want [$2] got [$3]"; fail=$((fail + 1)); fi; }
f() { printf '%s' "$2" > "$T/$1"; }

: > "$T/empty"
f abc abc
f m448 abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq
head -c 1000000 /dev/zero | tr '\0' a > "$T/million"
t "sha256 of the empty message" \
	e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 "$("$T/chk" sha256 "$T/empty")"
t "sha256 of abc" \
	ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad "$("$T/chk" sha256 "$T/abc")"
t "sha256 of the 448-bit message" \
	248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1 "$("$T/chk" sha256 "$T/m448")"
t "sha256 of a million a" \
	cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0 "$("$T/chk" sha256 "$T/million")"

# RFC 4231: test case 1, test case 2, and test case 6, whose key is longer
# than a block and is hashed first.
python3 -I - "$T" <<'PY'
import sys
t = sys.argv[1]
open(f"{t}/k1", "wb").write(b"\x0b" * 20)
open(f"{t}/k6", "wb").write(b"\xaa" * 131)
PY
[ -s "$T/k1" ] && [ -s "$T/k6" ] || { echo "FAIL  python did not write the HMAC keys" >&2; exit 1; }
f m1 "Hi There"
f k2 Jefe
f m2 "what do ya want for nothing?"
f m6 "Test Using Larger Than Block-Size Key - Hash Key First"
t "hmac, RFC 4231 case 1" \
	b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7 "$("$T/chk" hmac "$T/k1" "$T/m1")"
t "hmac, RFC 4231 case 2" \
	5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843 "$("$T/chk" hmac "$T/k2" "$T/m2")"
t "hmac, RFC 4231 case 6: a key longer than a block" \
	60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54 "$("$T/chk" hmac "$T/k6" "$T/m6")"

# RFC 7914 section 11 gives 64 bytes; this is its first block, which is all
# pbkdf2_sha256 makes.
f passwd passwd
f password password
f salt salt
f Password Password
f NaCl NaCl
t "pbkdf2, RFC 7914: passwd, salt, c=1" \
	55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc "$("$T/chk" pbkdf2 "$T/passwd" "$T/salt" 1)"
t "pbkdf2, RFC 7914: Password, NaCl, c=80000" \
	4ddcd8f60b98be21830cee5ef22701f9641a4418d04c0414aeff08876b34ab56 "$("$T/chk" pbkdf2 "$T/Password" "$T/NaCl" 80000)"
t "pbkdf2: password, salt, c=1" \
	120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b "$("$T/chk" pbkdf2 "$T/password" "$T/salt" 1)"
t "pbkdf2: password, salt, c=2" \
	ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43 "$("$T/chk" pbkdf2 "$T/password" "$T/salt" 2)"
t "pbkdf2: password, salt, c=4096" \
	c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a "$("$T/chk" pbkdf2 "$T/password" "$T/salt" 4096)"

# Against hashlib, over what the vectors do not reach: every message length
# around the block and padding boundaries, a password longer than a block (the
# HMAC key is then its hash), and the 16-byte binary salt the daemon uses.
python3 -I - "$T" <<'PY'
import hashlib, hmac, sys
t = sys.argv[1]
with open(f"{t}/lens.want", "w") as w:
    for n in list(range(0, 130)) + [191, 192, 193, 1000, 65537]:
        m = bytes((i * 31 + n) & 0xff for i in range(n))
        open(f"{t}/len{n}", "wb").write(m)
        w.write(f"{n} {hashlib.sha256(m).hexdigest()}\n")
pw = bytes(range(32, 127)) + b"x" * 33          # 128 bytes, the longest password
salt = bytes(range(240, 256))
open(f"{t}/longpw", "wb").write(pw)
open(f"{t}/binsalt", "wb").write(salt)
open(f"{t}/kdf.want", "w").write(hashlib.pbkdf2_hmac("sha256", pw, salt, 1000).hex() + "\n")
open(f"{t}/hmac.want", "w").write(hmac.new(pw, salt * 9, "sha256").hexdigest() + "\n")
open(f"{t}/salt9", "wb").write(salt * 9)
open(f"{t}/done", "w").write("135\n")
PY
# The reference is the test: without it, or with half of it, there is
# nothing to compare with, and an empty answer on both sides is not a match.
[ "$(cat "$T/done" 2>/dev/null)" = 135 ] || { echo "FAIL  python did not write the reference values" >&2; exit 1; }
for f in kdf.want hmac.want; do
	[ "$(tr -d '\n' < "$T/$f" | wc -c | tr -d ' ')" = 64 ] || { echo "FAIL  $f is not a hash" >&2; exit 1; }
done
bad=0; seen=0
while read -r n want; do
	seen=$((seen + 1))
	got=$("$T/chk" sha256 "$T/len$n") || got=
	[ ${#want} = 64 ] && [ "$got" = "$want" ] || bad=$((bad + 1))
done < "$T/lens.want"
t "sha256 was compared with hashlib for 135 lengths" 135 "$seen"
t "sha256 equals hashlib for every length around a block" 0 "$bad"
t "hmac equals python: a 128-byte key, a 144-byte message" \
	"$(cat "$T/hmac.want")" "$("$T/chk" hmac "$T/longpw" "$T/salt9")"
t "pbkdf2 equals hashlib: a 128-byte password, a binary salt" \
	"$(cat "$T/kdf.want")" "$("$T/chk" pbkdf2 "$T/longpw" "$T/binsalt" 1000)"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
