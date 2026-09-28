#!/usr/bin/env bash
#
# Record a stick's configuration as the baseline the UI compares against.
#
# This exists because the device cannot tell you its own defaults. Only ten
# values are shipped in /etc/config_default*.xml; the rest are built into the
# MIB, and there is no read-only way to dump them —  `xmlconfig -def_mib -os`
# looks like it should and prints the current configuration instead, which
# would make every key appear to be a default.
#
# So the reference is a snapshot of a stick you consider correct. "Changed since
# this baseline" is the question that actually gets asked, and unlike a guessed
# default it is a claim that can be checked.
#
# Re-capture after deliberately changing something you intend to keep, or the UI
# will keep flagging it.
#
# The baseline is per-stick, so it is written straight to the device rather than
# checked in: two sticks on different lines legitimately differ in serial, VLAN
# and address, and one shared file would show the second one as drifted in
# dozens of places.
#
#   SSH_OPTS='-S /tmp/odi_ctl' scripts/capture-baseline.sh admin@<stick>

set -euo pipefail

HOST="${1:?usage: capture-baseline.sh <user@host>}"

read -r -a SSH_EXTRA <<< "${SSH_OPTS:-}"
# ConnectTimeout bounds the handshake; ServerAlive* bounds a session that
# connected fine and then went quiet. No GNU timeout(1) on macOS to wrap this
# in, so the bound is ssh's own.
SSH=(ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 \
	 -o ServerAliveInterval=5 -o ServerAliveCountMax=3 \
	 "${SSH_EXTRA[@]}" "$HOST")

DEST=/etc/config/confd/baseline.tsv

cs=$("${SSH[@]}" '/etc/scripts/flash all cs' 2>/dev/null)
hs=$("${SSH[@]}" '/etc/scripts/flash all hs' 2>/dev/null)
[ -n "$cs" ] || { echo "no config read back from $HOST" >&2; exit 1; }

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

{
printf '# baseline captured from %s on %s\n' "$HOST" "$(date -u +%Y-%m-%dT%H:%MZ)"
printf '# by scripts/capture-baseline.sh -- re-capture after a change you mean to keep.\n'
printf 'name\tvalue\n'

printf '%s\n%s\n' "$cs" "$hs" | python3 -c '
import re, sys

table = index = None
for line in sys.stdin:
    d = re.search(r"<Dir Name=\"([^\"]+)\">(?:\s*<!--index=(\d+)-->)?", line)
    if d:
        table, index = d.group(1), d.group(2)
        if table in ("MIB_TABLE", "HW_MIB_TABLE"):
            table = None
        continue
    v = re.search(r"<Value Name=\"([^\"]*)\" Value=\"([^\"]*)\"", line)
    if not v:
        continue
    # Dropped, not emitted bare: a value in a table Dir with no index has no
    # addressable form. Same rule as gen-schema.py and the daemon.
    if table and not index:
        continue
    name = f"{table}[{index}].{v.group(1)}" if table else v.group(1)
    # Tabs would break the file format; no device value has ever contained one,
    # but a silent corruption here would be invisible.
    print(name + "\t" + v.group(2).replace("\t", " "))
'
} > "$tmp"

n=$(grep -vc '^#' "$tmp")
[ "$n" -gt 50 ] || { echo "only $n rows captured -- refusing to install a truncated baseline" >&2; exit 1; }

"${SSH[@]}" "mkdir -p $(dirname $DEST); cat > $DEST" < "$tmp"
printf 'installed %s rows to %s on %s\n' "$n" "$DEST" "$HOST"
