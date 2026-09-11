#!/usr/bin/env bash
#
# Install confd on a running stick without reflashing it.
#
# The rootfs is read-only squashfs, so the daemon and its assets go to
# /etc/config/confd/, which is /var/config -- mtd3, jffs2, read-write, and the
# one place fwu.sh never writes. Everything there survives a reboot and a
# reflash. The payload is around 96 KB against the partition's ~196 KB free,
# and the staged binary copy takes the peak to roughly 116 KB -- so this is half
# the partition, not the 35 KB an earlier version of this comment claimed.
# Filling it puts device configuration at risk, which is a far worse outcome
# than having no UI, so the space check below is computed from the actual files
# rather than being a number someone remembered.
#
# Connection details differ per stick, so pass whatever ssh needs in SSH_OPTS:
#
#   SSH_OPTS='-S /tmp/odi_ctl' scripts/deploy.sh admin@<stick> [port]

set -euo pipefail

HOST="${1:?usage: deploy.sh <user@host> [port]}"
PORT="${2:-8080}"
DEST=/etc/config/confd

read -r -a SSH_EXTRA <<< "${SSH_OPTS:-}"
SSH=(ssh -o StrictHostKeyChecking=accept-new "${SSH_EXTRA[@]}" "$HOST")

[ -f build/confd ] || { echo "no build/confd -- run 'make confd'" >&2; exit 1; }
if ! file build/confd | grep -q "ELF 32-bit MSB executable, MIPS"; then
	echo "build/confd is not a big-endian MIPS executable -- refusing" >&2
	exit 1
fi

# Globbed, not listed: the UI is many modules now, and a hand-kept list here
# would be a fourth copy of it. scripts/check-assets.py is what asserts web/
# and the daemon's own table agree.
ASSETS=(schema/keys.tsv schema/meta.tsv schema/consumers.tsv web/*.html web/*.css web/*.js)

echo "==> free space on the config partition"
# What this actually needs, on jffs2 rather than on your disk.
#
# This used to sum `wc -c` and refused a deploy that fits three times over:
# 244 KB estimated against 188 KB free, for a payload that really occupies
# about 114 KB. /var/config is jffs2, which COMPRESSES on write, and summing
# uncompressed sizes over-counts text by a factor of three.
#
# The model is measured, not assumed. Uploading a 29,000-byte confd to a stick
# moved free space by exactly 16,384 bytes; that file gzips to 13,782, and
# ceil(13782 / 4096) * 4096 is 16,384 — jffs2 compresses, then allocates whole
# 4 KB erase blocks (`erasesize` from /proc/mtd). So: compress each file, round
# it up to a block, add them up.
#
# gzip -6, not -9: that is zlib's default and what jffs2 uses, so the estimate
# stays on the pessimistic side of the truth. The binary is counted twice
# because it is staged as confd.new in the same filesystem before the rename,
# and the headroom stays because jffs2 is log-structured — overwriting a file
# does not free its old blocks until garbage collection, so even re-deploying
# identical content can transiently need the payload again.
BLOCK=4096
NEED=0
for f in "${ASSETS[@]}" build/confd build/confd; do
	z=$(gzip -6 -c "$f" | wc -c | tr -d ' ')
	NEED=$((NEED + ((z + BLOCK - 1) / BLOCK) * BLOCK))
done
NEED_KB=$(((NEED + 1023) / 1024 + 32))

# shellcheck disable=SC2016  # $4 is awk's and must reach the device unexpanded
AVAIL=$("${SSH[@]}" 'df /var/config 2>/dev/null | awk "NR==2{print \$4}"')
case "$AVAIL" in
'' | *[!0-9]*)
	# Fail CLOSED. This used to pass when df returned nothing, which is the
	# wrong direction for the one guard standing between a deploy and a full
	# config partition.
	echo "    could not read free space on /var/config -- refusing" >&2
	echo "    (override with FORCE=1 if you have checked by hand)" >&2
	[ "${FORCE:-0}" = 1 ] || exit 1
	;;
*)
	printf '    %s KB available, %s KB needed\n' "$AVAIL" "$NEED_KB"
	if [ "$AVAIL" -lt "$NEED_KB" ]; then
		echo "    not enough room -- refusing" >&2
		exit 1
	fi
	;;
esac

# baseline.tsv is NOT shipped: it is per-stick and captured on the device by
# scripts/capture-baseline.sh. Overwriting it from here would replace one
# stick's reference with another's.
echo "==> $DEST"
"${SSH[@]}" "mkdir -p $DEST"
for f in "${ASSETS[@]}"; do
	base=$(basename "$f")
	# shellcheck disable=SC2094  # the redirect writes on the device, not here
	"${SSH[@]}" "cat > $DEST/$base" < "$f"
	printf '    %s\n' "$base"
done
# To a temporary name in the SAME filesystem, then rename after the old process
# is gone. Linux refuses to write a running executable outright ("Text file
# busy"), and renaming within jffs2 is atomic, so the live path is never a
# partially written binary.
"${SSH[@]}" "cat > $DEST/confd.new; chmod +x $DEST/confd.new" < build/confd

echo "==> verifying"
LOCAL=$(md5 -q build/confd 2>/dev/null || md5sum build/confd | cut -d' ' -f1)
REMOTE=$("${SSH[@]}" "md5sum $DEST/confd.new | cut -d' ' -f1")
if [ "$LOCAL" != "$REMOTE" ]; then
	echo "    md5 mismatch -- leaving the running binary alone" >&2
	"${SSH[@]}" "rm -f $DEST/confd.new" || true
	exit 1
fi
printf '    md5 %s\n' "$REMOTE"

echo "==> restarting on :$PORT"
# Wait for the old process to be gone before binding: kill is asynchronous and
# SO_REUSEADDR covers TIME_WAIT, not a live listener. trap '' HUP is what makes
# the new one outlive this ssh session -- there is no setsid or nohup on this
# busybox, and an ignored signal disposition survives exec where a handler does
# not.
"${SSH[@]}" "kill \$(pidof confd) 2>/dev/null
	i=0
	while [ \$i -lt 15 ] && pidof confd >/dev/null 2>&1; do sleep 1; i=\$((i+1)); done
	mv $DEST/confd.new $DEST/confd
	trap '' HUP
	( $DEST/confd $PORT </dev/null >/dev/null 2>&1 & )
	true"
sleep 2

if "${SSH[@]}" "pidof confd" >/dev/null 2>&1; then
	echo "    running"
else
	echo "    confd did not start" >&2
	exit 1
fi

if ! "${SSH[@]}" "[ -s /etc/config/confd.auth ]" 2>/dev/null; then
	echo
	echo "NOTE: /etc/config/confd.auth is missing, so confd is answering to its"
	echo "      built-in admin/admin. Set your own on the Config tab -- the page"
	echo "      warns until you do, and creates the file for you. By hand:"
	echo "  ssh $HOST 'printf \"user:password\" > /etc/config/confd.auth; chmod 600 /etc/config/confd.auth'"
fi
