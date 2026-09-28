#!/usr/bin/env bash
#
# Dump every OMCI table from a live stick, into scripts/fixtures/omci/.
#
# The ME parser in web/omci.js is written against real device output, and it has
# to be: the format is not consistent between tables -- ME 84 prints `EntityID`
# and ME 171 prints `EntityId`, in the same dump from the same firmware -- so a
# fixture written by hand tests the author's memory rather than the device.
#
# Two fixtures in this repo came from a support thread. Everything else is
# unseen, which is the honest state of it. Run this against a stick that is in
# O5 on a working line and the parser gets tested against the real thing.
#
#   scripts/capture-omci.sh admin@192.168.1.1
#   SSH_OPTS='-S /tmp/odi_ctl' scripts/capture-omci.sh admin@sfp-claro
#
# These sticks want password auth and legacy algorithms, so the connection is
# not hardcoded; put whatever ssh needs in SSH_OPTS. An already-open multiplex
# socket is the least painful. See odi-sandbox docs/OUR-STICKS.md.

set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${1:?usage: capture-omci.sh <user@host>}"
OUT=scripts/fixtures/omci

read -r -a SSH_EXTRA <<< "${SSH_OPTS:-}"
# ConnectTimeout bounds the handshake; ServerAlive* bounds a session that
# connected fine and then went quiet -- e.g. omcicli talking to a wedged
# omci_app. No GNU timeout(1) on macOS to wrap this in, so the bound is ssh's
# own.
SSH=(ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 \
	 -o ServerAliveInterval=5 -o ServerAliveCountMax=3 \
	 "${SSH_EXTRA[@]}" "$HOST")

mkdir -p "$OUT"

# Ask the running stack what it registered, rather than assuming the image's
# /lib/omci/mib_*.so list is all live. On a stick that never reached O5 the
# difference between those two IS the finding.
echo "==> omcicli get tables"
"${SSH[@]}" 'omcicli get tables' > "$OUT/_tables.txt" 2>&1 || true
head -5 "$OUT/_tables.txt" | sed 's/^/    /'

# Both argument forms, on a table we know answers. The pages use class ids
# because that is the form seen working in the field; if names work too, the
# raw browser's picker can stop being a second-class citizen.
echo "==> argument forms"
for form in 84 VlanTagFilterData; do
	n=$("${SSH[@]}" "omcicli mib get $form" 2>&1 | wc -l | tr -d ' ')
	printf '    mib get %-22s %s lines\n' "$form" "$n"
done

# The entity argument. The route passes it as its own word; if this firmware
# wants `84,0x01` instead, this is where that shows up.
echo "==> entity argument"
"${SSH[@]}" 'omcicli mib get 84 0x01' 2>&1 | head -4 | sed 's/^/    /'

echo "==> per-table dumps"
# The tables the image can register, from the base's own plugin list. Anything
# that comes back empty is skipped rather than saved: an empty file is
# indistinguishable from a capture that failed.
TABLES=$("${SSH[@]}" 'ls /lib/omci/ 2>/dev/null' | sed 's/^mib_//;s/\.so$//')
[ -n "$TABLES" ] || { echo "no /lib/omci on the device -- nothing to enumerate" >&2; exit 1; }

saved=0
for t in $TABLES; do
	f="$OUT/$t.txt"
	if "${SSH[@]}" "omcicli mib get $t" > "$f" 2>&1 && [ -s "$f" ]; then
		printf '    %-40s %s bytes\n' "$t" "$(wc -c < "$f" | tr -d ' ')"
		saved=$((saved + 1))
	else
		rm -f "$f"
	fi
done

echo "==> data path"
for d in conn srvflow qmap; do
	"${SSH[@]}" "omcicli dump $d" > "$OUT/_dump_$d.txt" 2>&1 || true
	[ -s "$OUT/_dump_$d.txt" ] || rm -f "$OUT/_dump_$d.txt"
done

echo
echo "$saved tables saved under $OUT/"
echo "Review them before committing: a MIB carries the line's VLANs and the"
echo "ONU serial, which is operational detail rather than a credential -- but"
echo "read what you are about to commit, not what you expect to be there."
