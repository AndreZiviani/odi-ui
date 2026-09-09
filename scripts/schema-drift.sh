#!/usr/bin/env bash
#
# Assert the schema and a live device agree, in BOTH directions.
#
# A key on the device but not in the schema is invisible in the UI. A key in the
# schema but not on the device renders a control that can never work. Neither
# fails loudly on its own, which is why this is the test worth having: it caught
# four table keys whose names the generator had prettified, and which would have
# silently rendered blank.
#
# Three lists are compared, not two:
#
#   reference  `flash all` parsed here, by the copy of the parser below
#   daemon     /api/values -- what confd's own parser makes of the same XML
#   schema     keys.tsv
#
# Comparing the schema only against the reference would have left the daemon's
# parser untested by the one script whose whole job is catching disagreement:
# a bug there produces a UI missing keys that this script would call in sync.
# The reference exists to test the daemon, and the daemon is what the UI sees,
# so the schema is judged against the daemon.
#
#   SSH_OPTS='-S /tmp/odi_ctl' scripts/schema-drift.sh admin@<stick>

set -euo pipefail

HOST="${1:?usage: schema-drift.sh <user@host>}"
SCHEMA="${SCHEMA:-schema/keys.tsv}"

read -r -a SSH_EXTRA <<< "${SSH_OPTS:-}"
SSH=(ssh -o StrictHostKeyChecking=accept-new "${SSH_EXTRA[@]}" "$HOST")

[ -f "$SCHEMA" ] || { echo "no schema at $SCHEMA" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

"${SSH[@]}" '/etc/scripts/flash all cs' > "$tmp/cs" 2>/dev/null
"${SSH[@]}" '/etc/scripts/flash all hs' > "$tmp/hs" 2>/dev/null
[ -s "$tmp/cs" ] || { echo "no config read back from $HOST" >&2; exit 1; }

# Same shape the daemon emits: scalars bare, table rows as TBL[index].Field.
python3 - "$tmp/cs" "$tmp/hs" > "$tmp/device" <<'PY'
import re, sys
for path in sys.argv[1:]:
    table = index = None
    for line in open(path, encoding="utf-8", errors="replace"):
        d = re.search(r'<Dir Name="([^"]+)">(?:\s*<!--index=(\d+)-->)?', line)
        if d:
            table, index = d.group(1), d.group(2)
            if table in ("MIB_TABLE", "HW_MIB_TABLE"):
                table = None
            continue
        v = re.search(r'<Value Name="([^"]*)" Value="', line)
        if not v:
            continue
        # A value inside a table Dir with no index has no addressable form, so
        # it is dropped -- same rule as gen-schema.py and the daemon.
        if table and not index:
            continue
        print(f"{table}[{index}].{v.group(1)}" if table else v.group(1))
PY

grep -v '^#' "$SCHEMA" | tail -n +2 | cut -f1 | sort -u > "$tmp/schema"
sort -u "$tmp/device" > "$tmp/ref"
fail=0

# --- the daemon's own parser, over the same XML ------------------------------
#
# Read the credential and port off the device rather than asking for them: they
# are already there, and a second argument nobody remembers to pass is a check
# nobody runs.
port=$("${SSH[@]}" 'cat /etc/config/confd.port 2>/dev/null' | tr -dc '0-9')
port="${port:-8080}"
auth=$("${SSH[@]}" 'cat /etc/config/confd.auth 2>/dev/null' | tr -d '\r\n')
addr="${HOST#*@}"

if [ -z "$auth" ]; then
	echo "no /etc/config/confd.auth on $HOST -- cannot query the daemon" >&2
	echo "(the schema was still checked against the reference parser)" >&2
	cp "$tmp/ref" "$tmp/dev"
elif ! curl -fsS --max-time 20 -u "$auth" "http://$addr:$port/api/values" > "$tmp/api.json"; then
	echo "could not reach confd at $addr:$port -- is it running?" >&2
	exit 1
else
	python3 -c 'import json,sys; [print(k) for k in json.load(open(sys.argv[1]))]' \
		"$tmp/api.json" | sort -u > "$tmp/dev"

	only_ref=$(comm -23 "$tmp/ref" "$tmp/dev")
	only_api=$(comm -13 "$tmp/ref" "$tmp/dev")
	if [ -n "$only_ref" ] || [ -n "$only_api" ]; then
		fail=1
		echo "confd's parser disagrees with the reference over the same XML:"
		printf '%s\n' "$only_ref" | while IFS= read -r k; do
			[ -n "$k" ] && printf '  only in flash all:   %s\n' "$k"
		done
		printf '%s\n' "$only_api" | while IFS= read -r k; do
			[ -n "$k" ] && printf '  only in /api/values: %s\n' "$k"
		done
	fi
fi

missing=$(comm -13 "$tmp/schema" "$tmp/dev")
extra=$(comm -23 "$tmp/schema" "$tmp/dev")

# Key names contain spaces (`SW_PORT_TBL[0].VLAN on LAN Enabled`), so these are
# read line by line rather than word-split -- splitting turns one wrong key into
# four bogus ones and makes the report useless.
if [ -n "$missing" ]; then
	fail=1
	echo "on the device, MISSING from the schema (invisible in the UI):"
	printf '%s\n' "$missing" | while IFS= read -r k; do printf '  %s\n' "$k"; done
fi
if [ -n "$extra" ]; then
	fail=1
	echo "in the schema, ABSENT from the device (renders a dead control):"
	printf '%s\n' "$extra" | while IFS= read -r k; do printf '  %s\n' "$k"; done
fi
[ "$fail" = 0 ] || exit 1

# The display name and the address are different notations, and confusing them
# is silent rather than loud: handing xmlconfig a bracketed name resolves to a
# DIFFERENT entry, writes it, and exits 0 echoing the wrong key. Assert the
# address column never carries the display form.
badaddr=$(grep -v '^#' "$SCHEMA" | tail -n +2 | awk -F'\t' '$3 ~ /\[/ {print $1}')
if [ -n "$badaddr" ]; then
	echo "addresses still in display form (would write the wrong entry):"
	printf '%s\n' "$badaddr" | while IFS= read -r k; do printf '  %s\n' "$k"; done
	exit 1
fi

echo "in sync: $(wc -l < "$tmp/schema" | tr -d ' ') keys match $HOST, and confd's parser agrees"
