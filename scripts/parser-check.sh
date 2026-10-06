#!/usr/bin/env bash
# The flash all parsers that live in scripts/ must agree with the daemon
# (src/mib.c, covered by smoke.sh) on one shape: odi-oss appends its odi-only
# scalars after the last table block, so a </Dir> has to end table context.
# Runs gen-schema.py, and the python embedded in capture-baseline.sh and
# schema-drift.sh, over scripts/fixtures/flash-all-cs-odi-tail.xml.
#   scripts/parser-check.sh
set -uo pipefail
cd "$(dirname "$0")/.."

fx=scripts/fixtures/flash-all-cs-odi-tail.xml
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fail=0

want() {  # want <parser> <file>: scalar after the tables kept, rows addressed, no bare table value
	local who=$1 f=$2
	grep -qx 'NTP_SERVER' "$f" || { echo "FAIL $who: NTP_SERVER after a closed table was dropped"; fail=1; return; }
	grep -qx 'SW_PORT_TBL\[1\].PVID' "$f" || { echo "FAIL $who: table row lost its TBL[n].Field address"; fail=1; return; }
	grep -qx 'LAN_IP_ADDR' "$f" || { echo "FAIL $who: MIB_TABLE scalar lost"; fail=1; return; }
	echo "ok   $who"
}

# gen-schema.py wants cs hs runomci.sh and prints a TSV: name is column 1.
: > "$tmp/empty"
python3 scripts/gen-schema.py "$fx" "$tmp/empty" "$tmp/empty" 2>&1 | grep -v '^#' | tail -n +2 | cut -f1 > "$tmp/gen"
want gen-schema.py "$tmp/gen"

# capture-baseline.sh: python3 -c '...' fed on stdin, prints name<TAB>value.
awk "/^printf '%s\\\\n%s\\\\n' .*python3 -c '\$/ {on=1; next} on && /^'\$/ {on=0} on" \
	scripts/capture-baseline.sh > "$tmp/cb.py"
[ -s "$tmp/cb.py" ] || { echo "FAIL could not extract the capture-baseline.sh parser"; exit 1; }
python3 "$tmp/cb.py" < "$fx" | cut -f1 > "$tmp/cb"
want capture-baseline.sh "$tmp/cb"

# schema-drift.sh: python3 - cs hs <<'PY' ... PY, prints one name per line.
awk "/^python3 - .*<<'PY'\$/ {on=1; next} on && /^PY\$/ {on=0} on" scripts/schema-drift.sh > "$tmp/sd.py"
[ -s "$tmp/sd.py" ] || { echo "FAIL could not extract the schema-drift.sh parser"; exit 1; }
python3 "$tmp/sd.py" "$fx" > "$tmp/sd"
want schema-drift.sh "$tmp/sd"

exit "$fail"
