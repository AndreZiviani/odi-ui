#!/usr/bin/env bash
#
# Run the daemon and talk HTTP to it, without a stick.
#
# The binary is big-endian MIPS; qemu-user-static in the toolchain image
# executes it on the build host. That is enough to exercise the whole request
# path -- reading a request, authenticating it, parsing a form body, validating
# a value -- which is the part of this daemon where a mistake is SILENT on real
# hardware. The write path itself is not exercised: /etc/scripts/flash does not
# exist here, so a write is expected to report that it did not stick, and the
# assertions below are about what the daemon accepted and refused, not what it
# stored.
#
# Every case here is a bug this has actually had.
#
#   scripts/smoke.sh          (via make smoke; runs itself inside the container)

set -euo pipefail
cd "$(dirname "$0")/.."

BIN=build/confd
PORT=18080
# Deliberately NOT the built-in default: with both the same, every check below
# passes whether the fallback works, is broken, or is ignored.
AUTH='admin:s3cret'

if [ "${IN_CONTAINER:-0}" != 1 ]; then
	# --cap-add SYSLOG so /api/log can actually be tested. klogctl is refused
	# in a default container (no CAP_SYSLOG, and the Docker VM sets
	# dmesg_restrict=1), and without the capability that route answers "the
	# kernel would not hand over its log buffer" here while working fine on
	# a stick -- a check that always fails teaches nothing. The container
	# reads the host VM's ring buffer; the assertion is only that bytes came
	# back, and nothing is written to it.
	IMAGE=$(scripts/toolchain-image.sh) || exit 1
	docker run --rm --cap-add SYSLOG -v "$PWD":/src -w /src "$IMAGE" \
		env IN_CONTAINER=1 scripts/smoke.sh
	exit $?
fi

[ -x "$BIN" ] || { echo "no $BIN -- run 'make confd' first" >&2; exit 1; }

# The daemon reads absolute paths. We are root in the container, so give it the
# real ones rather than teaching it about a prefix it would only need for tests.
mkdir -p /etc/confd /etc/config
cp schema/keys.tsv schema/meta.tsv schema/consumers.tsv schema/features.tsv schema/settings.tsv /etc/confd/
cp web/*.html web/*.css web/*.js /etc/confd/
printf '%s' "$AUTH" > /etc/config/confd.auth
chmod 600 /etc/config/confd.auth

# A stand-in for /etc/scripts/flash, so the write path runs end to end rather
# than stopping at a missing binary. It answers in the two shapes the daemon
# parses: `flash all <store>` prints the config XML, `flash set K V` echoes
# "K=V" the way the real one echoes its own xmlconfig read-back. That is enough
# to exercise write_key's read-back comparison and to give /api/values
# something real to return.
mkdir -p /etc/scripts
cat > /etc/scripts/flash <<'FLASH'
#!/bin/sh
case "$1" in
all)
	cat <<'XML'
<Dir Name="MIB_TABLE">
  <Value Name="VLAN_MANU_TAG_VID" Value="110"/>
  <Value Name="VLAN_CFG_TYPE" Value="1"/>
  <Value Name="LAN_IP_ADDR" Value="192.168.1.1"/>
  <Value Name="PON_VENDOR_ID" Value="ODI0"/>
</Dir>
<Dir Name="SW_PORT_TBL"> <!--index=1-->
  <Value Name="PVID" Value="1"/>
</Dir>
XML
	;;
set)
	echo "$2=$3"
	;;
default)
	# The real script rewrites /var/config/lastgood.xml from the built-in MIB
	# defaults and says this. Only the cs store is ever asked for -- the route
	# hardcodes it, and this refuses anything else so that stays testable.
	[ "$2" = cs ] || { echo "Restore to default configurationg fail."; exit 1; }
	echo "Reset CS to default configuration success."
	echo "Please reboot system."
	;;
esac
FLASH
chmod +x /etc/scripts/flash

qemu-mips-static "$BIN" "$PORT" &
DAEMON=$!
trap 'kill $DAEMON 2>/dev/null || true' EXIT

for _ in $(seq 40); do
	curl -fsS -u "$AUTH" -o /dev/null "http://127.0.0.1:$PORT/api/schema" && break
	sleep 0.25
done

pass=0
fail=0
check() {  # check <name> <expected> <actual>
	if [ "$2" = "$3" ]; then
		pass=$((pass + 1))
		printf '  ok    %s\n' "$1"
	else
		fail=$((fail + 1))
		printf '  FAIL  %s\n        expected %s, got %s\n' "$1" "$2" "$3"
	fi
}

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
err() { case "$1" in *"$2"*) echo yes ;; *) echo "no: $1" ;; esac; }

# A stand-in for /bin/omcicli. The route builds its argv from the query string,
# so the stub ECHOES what it was given before printing a dump: that is what
# makes "the entity id reaches the command" a check that can fail, rather than
# an assumption. Real omcicli is not runnable here -- it talks to omci_app.
# A stand-in for /bin/diag. It reads commands on stdin the way the real one
# does, because that batching is the whole reason status is one fork rather
# than seven -- and until now nothing here exercised it at all: /api/status and
# /api/l2 were both untested, and a missing /bin/diag reads as "diag failed",
# which is indistinguishable from a stick with a broken one.
#
# The l2-table reply is the REAL capture in scripts/fixtures/, not something
# shaped to match the parser.
cat > /bin/diag <<'DIAG'
#!/bin/sh
# argv form first: the l2 route uses it because diag never returns when that
# command is fed on stdin. If this stub only handled stdin, the route could go
# back to stdin and the check would still pass.
case "$1" in
l2-table) cat /src/scripts/fixtures/l2-table.txt; exit 0 ;;
esac
while read -r l; do
	printf "RTK.0> %s\n" "$l"
	case "$l" in
	*"transceiver rx-power"*)    printf "  Rx Power          : -18.42 dBm\n" ;;
	*"transceiver tx-power"*)    printf "  Tx Power          : 2.15 dBm\n" ;;
	*"transceiver temperature"*) printf "  Temperature       : 45.50 C\n" ;;
	*"transceiver voltage"*)     printf "  Voltage           : 3.28 V\n" ;;
	*onu-state*)                 printf "  Operation State(O5)\n" ;;
	*alarm-status*)              printf "  LOS Alarm         : clear\n" ;;
	*"counter port all"*)        printf "Port: 0\n  ifInOctets : 1\nPort: 2\n  ifInOctets : 2\n" ;;
	*l2-table*)                  cat /src/scripts/fixtures/l2-table.txt ;;
	*)                           printf "  ok\n" ;;
	esac
done
DIAG
chmod +x /bin/diag

# An nv stub. Without one sw_active is unknown, and the guard that refuses to
# write the RUNNING partition has nothing to compare against -- so the check
# below would pass whether that guard works or is absent.
cat > /bin/nv <<'NV'
#!/bin/sh
case "$1 $2" in
"getenv sw_active") echo "sw_active=0" ;;
"getenv ") printf "sw_active=0\nsw_commit=0\nsw_tryactive=2\nsw_version0=a\nsw_version1=b\n" ;;
"getenv")  printf "sw_active=0\nsw_commit=0\nsw_tryactive=2\nsw_version0=a\nsw_version1=b\n" ;;
esac
exit 0
NV
chmod +x /bin/nv

cat > /bin/omcicli <<'OMCICLI'
#!/bin/sh
echo "ARGV: $*"
[ "$1 $2 $3" = "mib get 84" ] && cat /src/scripts/fixtures/omci/84-VlanTagFilterData.txt
exit 0
OMCICLI
chmod +x /bin/omcicli

echo "== auth"
check "no credential is refused"    401 "$(code "http://127.0.0.1:$PORT/api/schema")"
check "wrong credential is refused" 401 "$(code -u admin:wrong "http://127.0.0.1:$PORT/api/schema")"
check "right credential is served"  200 "$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/schema")"
check "the credential file is in force" false \
	"$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/firmware" | sed -n 's/.*"defaultauth":\([a-z]*\).*/\1/p')"

# Changing the credential from the UI. This is the way out of the built-in
# default, so it has to work on a stick that has no file at all -- the state
# every factory-reset stick is in.
echo "== setting the credential"
mv /etc/config/confd.auth /etc/config/confd.auth.kept
check "the default is reported while it is in force" true \
	"$(curl -s -u admin:admin "http://127.0.0.1:$PORT/api/firmware" | sed -n 's/.*"defaultauth":\([a-z]*\).*/\1/p')"
check "a password can be set with no file present" yes \
	"$(err "$(curl -s -u admin:admin -X POST -d 'user=op&password=hunter22' "http://127.0.0.1:$PORT/api/password")" '"ok":true')"
check "the file was created 0600" 600 \
	"$(stat -c '%a' /etc/config/confd.auth 2>/dev/null)"
check "the new credential works" 200 \
	"$(code -u op:hunter22 "http://127.0.0.1:$PORT/api/schema")"
check "the default stops working once one is set" 401 \
	"$(code -u admin:admin "http://127.0.0.1:$PORT/api/schema")"
check "and the default is no longer reported" false \
	"$(curl -s -u op:hunter22 "http://127.0.0.1:$PORT/api/firmware" | sed -n 's/.*"defaultauth":\([a-z]*\).*/\1/p')"

# A credential that cannot be expressed in the file format is REFUSED, not
# quietly rewritten into one that can: a mangled credential is one nobody can
# log in with, on a device where finding that out means a site visit.
for bad in 'user=a:b&password=hunter22' 'user=&password=hunter22' \
           'user=op&password=abc' 'user=op&password=' 'user=op' 'password=x'; do
	check "refuses $bad" 400 \
		"$(code -u op:hunter22 -X POST -d "$bad" "http://127.0.0.1:$PORT/api/password")"
done
check "a newline in the password is refused" 400 \
	"$(code -u op:hunter22 -X POST -d 'user=op&password=one%0Atwo' "http://127.0.0.1:$PORT/api/password")"

# Writing admin:admin into the file must NOT clear the warning: the question
# the page answers is "is this stick on the credential everybody knows", and
# a file containing the default is the worst of both.
curl -s -u op:hunter22 -X POST -d 'user=admin&password=admin' "http://127.0.0.1:$PORT/api/password" >/dev/null
check "a file holding the default still reports the default" true \
	"$(curl -s -u admin:admin "http://127.0.0.1:$PORT/api/firmware" | sed -n 's/.*"defaultauth":\([a-z]*\).*/\1/p')"
mv /etc/config/confd.auth.kept /etc/config/confd.auth

# The fallback. A stick flashed with an image that has never had a credential
# file written -- which is every stick after a factory reset, since
# /etc/config IS the partition that gets erased -- must still be reachable.
# It falls back to a WEAKER credential, never to none, so the refusals above
# must all still hold with no file present.
mv /etc/config/confd.auth /etc/config/confd.auth.kept
check "with no file, the default credential works" 200 \
	"$(code -u admin:admin "http://127.0.0.1:$PORT/api/schema")"
check "with no file, no credential is still refused" 401 \
	"$(code "http://127.0.0.1:$PORT/api/schema")"
check "with no file, a wrong credential is still refused" 401 \
	"$(code -u admin:wrong "http://127.0.0.1:$PORT/api/schema")"
check "with no file, the file's credential no longer works" 401 \
	"$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/schema")"
check "the page is told the default is in force" true \
	"$(curl -s -u admin:admin "http://127.0.0.1:$PORT/api/firmware" | sed -n 's/.*"defaultauth":\([a-z]*\).*/\1/p')"

# An empty file is how anyone clears a password, and treating it as "accept
# nothing" would lock the operator out of the device they were changing it on.
: > /etc/config/confd.auth
check "an empty file falls back rather than locking out" 200 \
	"$(code -u admin:admin "http://127.0.0.1:$PORT/api/schema")"

# And a real credential must still WIN over the default once it exists,
# otherwise the fallback would be a permanent second key.
mv /etc/config/confd.auth.kept /etc/config/confd.auth
check "a real credential overrides the default" 200 \
	"$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/schema")"
check "and the default stops working once it does" 401 \
	"$(code -u admin:admin "http://127.0.0.1:$PORT/api/schema")"

echo "== ssh keys"
rm -f /etc/config/dropbear.d/authorized_keys
check "no file lists no keys" '{"path":"/etc/config/dropbear.d/authorized_keys","keys":[]}' \
	"$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/sshkeys")"
check "a line that is not a key is refused" 400 \
	"$(code -u "$AUTH" -X POST --data-urlencode 'key=hello world' "http://127.0.0.1:$PORT/api/sshkeys")"
check "an empty key is refused" 400 \
	"$(code -u "$AUTH" -X POST -d 'key=' "http://127.0.0.1:$PORT/api/sshkeys")"
K1='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGxJq2sL3o5p8Qh1u7v9wXyZaBcDeFgHiJkLmNoPqRsT laptop'
K2='ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC0m8v2xFakeKeyBlobForTheSmokeTest0123456789abcdefghijklmnopqrstuvwxyz desk'
check "a key is added" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST --data-urlencode "key=$K1" "http://127.0.0.1:$PORT/api/sshkeys")" '"ok":true')"
check "and a second one" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST --data-urlencode "key=$K2" "http://127.0.0.1:$PORT/api/sshkeys")" '"ok":true')"
check "the file has both, one per line, mode 600" "2 600" \
	"$(wc -l < /etc/config/dropbear.d/authorized_keys | tr -d ' ') $(stat -c '%a' /etc/config/dropbear.d/authorized_keys)"
check "the list carries both with their line numbers" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/sshkeys")" '{"i":0,"line":"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGxJq2sL3o5p8Qh1u7v9wXyZaBcDeFgHiJkLmNoPqRsT laptop"},{"i":1,"line":"ssh-rsa')"
check "deleting the first leaves the second at line 0" yes \
	"$(curl -s -u "$AUTH" -X POST -d 'delete=0' "http://127.0.0.1:$PORT/api/sshkeys" >/dev/null; err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/sshkeys")" '"keys":[{"i":0,"line":"ssh-rsa')"
check "deleting a line that is not there is 404" 404 \
	"$(code -u "$AUTH" -X POST -d 'delete=7' "http://127.0.0.1:$PORT/api/sshkeys")"
check "without a credential the keys are not readable" 401 \
	"$(code "http://127.0.0.1:$PORT/api/sshkeys")"
rm -f /etc/config/dropbear.d/authorized_keys

echo "== request framing"
# The bug: headers and body in separate segments made the body arrive empty,
# and handle_write answered {"results":[],"apply":"none"} with no error at all.
split_post=$(python3 - "$PORT" "$AUTH" <<'PY'
import base64, socket, sys, time
port, auth = int(sys.argv[1]), sys.argv[2]
body = b"VLAN_MANU_TAG_VID=100"
cred = base64.b64encode(auth.encode()).decode()
s = socket.create_connection(("127.0.0.1", port), timeout=10)
s.sendall(
    b"POST /api/config HTTP/1.0\r\n"
    b"Authorization: Basic " + cred.encode() + b"\r\n"
    b"Content-Type: application/x-www-form-urlencoded\r\n"
    b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n")
time.sleep(0.4)          # a second segment, exactly as a browser sends it
s.sendall(body)
out = b""
while True:
    d = s.recv(4096)
    if not d:
        break
    out += d
print(out.decode("utf-8", "replace").split("\r\n\r\n", 1)[-1])
PY
)
case "$split_post" in
*'"name":"VLAN_MANU_TAG_VID"'*) r=seen ;;
*) r="not seen: $split_post" ;;
esac
check "body in a second segment is read" seen "$r"

# The other half: a body too large used to be truncated mid-value and written.
big=$(python3 -c 'print("&".join("PON_VENDOR_ID=" + "x"*500 for _ in range(60)))')
check "an oversized body is refused, not trimmed" 413 \
	"$(code -u "$AUTH" -X POST --data "$big" "http://127.0.0.1:$PORT/api/config")"

echo "== csrf"
check "cross-origin POST is refused" 403 \
	"$(code -u "$AUTH" -X POST -H 'Origin: http://evil.example' \
		--data 'action=reboot' "http://127.0.0.1:$PORT/api/firmware")"
check "same-origin POST is allowed" 200 \
	"$(code -u "$AUTH" -X POST -H "Origin: http://127.0.0.1:$PORT" \
		--data 'LAN_IP_ADDR=192.168.1.1' "http://127.0.0.1:$PORT/api/config")"
check "no Origin still works (curl, scripts)" 200 \
	"$(code -u "$AUTH" -X POST --data 'LAN_IP_ADDR=192.168.1.1' \
		"http://127.0.0.1:$PORT/api/config")"

echo "== validation"
post() { curl -s -u "$AUTH" -X POST --data "$1" "http://127.0.0.1:$PORT/api/config"; }

check "a refused SerDes key is refused" yes \
	"$(err "$(post 'LAN_SDS_MODE=4')" 'refused')"
check "an out-of-range VLAN is refused" yes \
	"$(err "$(post 'VLAN_MANU_TAG_VID=99999')" 'outside the range')"
check "an in-range VLAN passes validation" yes \
	"$(err "$(post 'VLAN_MANU_TAG_VID=100')" '"name":"VLAN_MANU_TAG_VID"')"
# VLAN_CFG_TYPE, not PON_MODE: PON_MODE is an identity key and is refused one
# rung earlier, which tests the confirmation gate rather than the option list.
check "a value outside an option list is refused" yes \
	"$(err "$(post 'VLAN_CFG_TYPE=9')" 'not one of the values')"
check "a value inside the option list is written" yes \
	"$(err "$(post 'VLAN_CFG_TYPE=1')" '"ok":true,"value":"1"')"
check "a bad octet is refused" yes \
	"$(err "$(post 'LAN_IP_ADDR=1.2.3.999')" 'not valid for its type')"
check "a good address is written" yes \
	"$(err "$(post 'LAN_IP_ADDR=192.168.1.1')" '"ok":true,"value":"192.168.1.1"')"

echo "== apply classification"
# consumers.tsv is authoritative where it has a row. The daemon used to ignore
# the file entirely and call everything that was not restart:omci a reboot.
check "a restart:omci key says so" yes \
	"$(err "$(post 'VLAN_MANU_TAG_VID=110')" '"apply":"restart:omci"')"
# settings.tsv, this image own table, decides what a write needs: the actions
# the page runs (network) or offers (omci, reboot), and whether a key is read
# by nothing here at all.
check "an omcid key needs the omci action" yes \
	"$(err "$(post 'VLAN_MANU_TAG_VID=110')" '"needs":["omci"]')"
check "a management address needs the network action" yes \
	"$(err "$(post 'LAN_IP_ADDR=192.168.1.1')" '"needs":["network"]')"
check "and is no longer reported as untraced" yes \
	"$(err "$(post 'LAN_IP_ADDR=192.168.1.1')" '"untraced":false')"
check "a key only the stock firmware reads is reported as such" yes \
	"$(err "$(post 'DNS1=1.1.1.1')" '"needs":[],"stock":true')"
check "a batch reports every action it needs" yes \
	"$(err "$(post 'LAN_IP_ADDR2=192.168.100.1&VLAN_MANU_TAG_PRI=0')" '"needs":["network","omci"]')"
check "SYSLOG_SERVER needs the syslog action" yes \
	"$(err "$(post 'SYSLOG_SERVER=10.0.0.5:514')" '"needs":["syslog"]')"
check "NTP_SERVER needs the ntp action" yes \
	"$(err "$(post 'NTP_SERVER=pool.ntp.org')" '"needs":["ntp"]')"
check "both together need both" yes \
	"$(err "$(post 'SYSLOG_SERVER=logs.lan&NTP_SERVER=192.168.1.10:123')" '"needs":["syslog","ntp"]')"
check "an empty SYSLOG_SERVER clears it (hostport keys only)" yes \
	"$(err "$(post 'SYSLOG_SERVER=')" '"ok":true')"
check "an empty NTP_SERVER clears it" yes \
	"$(err "$(post 'NTP_SERVER=')" '"ok":true')"
check "an empty stock key is still refused" yes \
	"$(err "$(post 'LAN_IP_ADDR=')" 'cannot be cleared')"
for bad in 'a b' 'a"b' "a'b" 'host:0' 'host:70000' 'host:' ':514' '-host' 'host.'; do
	check "a bad host is refused: $bad" yes \
		"$(err "$(curl -s -u "$AUTH" -X POST --data-urlencode "SYSLOG_SERVER=$bad" "http://127.0.0.1:$PORT/api/config")" 'not valid for its type')"
done
check "settings.tsv is served" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/settings")" '"name":"LAN_ENABLE_IP2","apply":"live","action":"network"')"
# Without the table, the old classification stands.
mv /etc/confd/settings.tsv /tmp/settings.tsv.kept
check "without settings.tsv an untraced key is reported as untraced" yes \
	"$(err "$(post 'LAN_IP_ADDR=192.168.1.1')" '"untraced":true')"
check "and no actions are listed" yes \
	"$(err "$(post 'LAN_IP_ADDR=192.168.1.1')" '"needs":[]')"
check "and /api/settings answers an empty list" '[]' \
	"$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/settings")"
mv /tmp/settings.tsv.kept /etc/confd/settings.tsv
check "an identity key needs confirmation" yes \
	"$(err "$(post 'GPON_SN=ODI12345678')" '_confirm=identity')"
check "an unknown key is refused" yes \
	"$(err "$(post 'NOT_A_REAL_KEY=1')" 'not in the schema')"

echo "== web assets"
# Every module the page imports must actually be served, and nothing outside
# the table may be. A 404 on one module is a blank page in a browser and
# nothing at all in a log.
for f in web/*.js web/*.css web/*.html; do
	b=$(basename "$f")
	u="/$b"; [ "$b" = index.html ] && u="/"
	check "serves $b" 200 "$(code -u "$AUTH" "http://127.0.0.1:$PORT$u")"
done
check "an unlisted file is refused" 404 \
	"$(code -u "$AUTH" "http://127.0.0.1:$PORT/keys.tsv")"
# The table is literals, so there is no path to traverse -- assert it anyway,
# because /etc/config/confd/ next door holds the credential.
for p in "/../confd.auth" "/..%2fconfd.auth" "//etc/config/confd.auth"; do
	check "refuses $p" 404 "$(code -u "$AUTH" "http://127.0.0.1:$PORT$p")"
done

echo "== routes"
check "sign out answers 401, not 405" 401 \
	"$(code -u "$AUTH" -X POST "http://127.0.0.1:$PORT/api/logout")"
check "values are parsed and served" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/values")" '"LAN_IP_ADDR":"192.168.1.1"')"
check "an indexed table row keeps its address" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/values")" '"SW_PORT_TBL[1].PVID"')"
# ORDER MATTERS. /api/defaults shares the values buffer, and it used to emit it
# without clearing -- so with no default files on the device it republished
# whatever /api/values had left there, and the page then labelled every key an
# image default. Asking for values first is what makes this test able to fail.
check "defaults does not republish the values buffer" '{}' \
	"$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/defaults")"
# The backup is the precondition for the one irreversible thing anyone does to
# this device, so it must contain the keys that cannot be regenerated.
check "the backup carries the identity keys" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/backup")" 'GPON_SN')"
check "the backup is served as a download" yes \
	"$(err "$(curl -si -u "$AUTH" "http://127.0.0.1:$PORT/api/backup")" 'Content-Disposition: attachment')"
check "the backup needs the credential" 401 \
	"$(code "http://127.0.0.1:$PORT/api/backup")"

echo "== diagnostics bundle"
# /api/diag runs the image /etc/scripts/diag-bundle.sh and streams the file it
# names. The real script is odi-oss; this stub stands in for its contract:
# argv[1] is the output path, exit 0 means the file is there. Its mode comes
# from a file because confd hands a child no environment.
check "no bundle script answers 501" 501 \
	"$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/diag")"
mkdir -p /tmp/diag-src/odi-diag
echo "stub bundle" > /tmp/diag-src/odi-diag/MANIFEST.txt
tar -czf /tmp/diag-stub.tar.gz -C /tmp/diag-src odi-diag
cat > /etc/scripts/diag-bundle.sh <<'STUB'
#!/bin/sh
case "$(cat /tmp/diag-stub.mode 2>/dev/null)" in
fail) echo "diag-bundle: the bundle came to 3000000 bytes, over BUNDLE_MAX" >&2; exit 1 ;;
esac
cp /tmp/diag-stub.tar.gz "$1" && echo "$1"
STUB
chmod +x /etc/scripts/diag-bundle.sh
echo ok > /tmp/diag-stub.mode
check "the bundle needs the credential" 401 \
	"$(code "http://127.0.0.1:$PORT/api/diag")"
hdr=$(curl -s -u "$AUTH" -D - -o /tmp/diag-got.tar.gz "http://127.0.0.1:$PORT/api/diag")
check "the bundle is served as a download" yes \
	"$(err "$hdr" 'Content-Disposition: attachment; filename="odi-diag.tar.gz"')"
check "the bundle is gzip" yes "$(err "$hdr" 'Content-Type: application/gzip')"
check "the bundle arrives byte for byte" "$(md5sum < /tmp/diag-stub.tar.gz)" \
	"$(md5sum < /tmp/diag-got.tar.gz)"
check "the bundle file is removed after serving" gone \
	"$([ -e /tmp/odi-diag.tar.gz ] && echo present || echo gone)"
echo fail > /tmp/diag-stub.mode
check "a failed bundle answers 500" 500 \
	"$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/diag")"
check "a failed bundle says why" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/diag")" 'over BUNDLE_MAX')"
rm -f /etc/scripts/diag-bundle.sh /tmp/diag-stub.mode /tmp/diag-stub.tar.gz /tmp/diag-got.tar.gz
rm -rf /tmp/diag-src

check "the OMCI feature bits are served" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/features")" '"feature":"ignore_conn_uniNode_check"')"
check "the build id is reported" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/firmware")" '"confd":')"

echo "== firmware upload"
# The point of this route is that a 3 MB body reaches a file through a 16 KB
# request buffer. So the check uses a REAL multi-megabyte body and compares
# md5s end to end -- a small one would pass whether the streaming loop works or
# the whole thing still fits in one read.
dd if=/dev/urandom of=/tmp/fake.tar bs=1024 count=3072 2>/dev/null
LOCAL_MD5=$(md5sum /tmp/fake.tar | cut -d" " -f1)
UP=$(curl -s -u "$AUTH" -X POST --data-binary @/tmp/fake.tar \
	-H 'Content-Type: application/octet-stream' \
	"http://127.0.0.1:$PORT/api/upload")
check "a 3 MB image uploads" yes "$(err "$UP" '"ok":true')"
check "every byte arrives" yes "$(err "$UP" '"bytes":3145728')"
check "and the file on disk is byte-identical" "$LOCAL_MD5" \
	"$(md5sum /tmp/img.tar 2>/dev/null | cut -d' ' -f1)"
check "the daemon reports that same md5" yes "$(err "$UP" "$LOCAL_MD5")"

# The guard is on the DECLARED length, tested before the file is opened and
# before a byte of body is read -- so /tmp cannot be filled by an upload that
# announces itself as too big for it.
#
# Declared 20 MB, body sixteen bytes. Sending a real oversized body instead
# made this flaky rather than wrong: the daemon rejects on the header and
# closes while curl is still sending, so curl is reset mid-send and reports 000
# instead of reading the 413. Separating the header from the body is what makes
# the check test the guard rather than the timing.
printf 'not an image at ' > /tmp/lie.bin
check "an upload declaring more than the limit is refused" 413 \
	"$(curl -s -o /dev/null -w '%{http_code}' -u "$AUTH" -X POST \
	   -H 'Content-Length: 20000000' -H 'Content-Type: application/octet-stream' \
	   --data-binary @/tmp/lie.bin "http://127.0.0.1:$PORT/api/upload")"
check "and it wrote nothing" no \
	"$([ -f /tmp/img.tar ] && [ "$(wc -c < /tmp/img.tar)" -lt 3145728 ] && echo yes || echo no)"
rm -f /tmp/lie.bin
check "an empty upload is refused" 413 \
	"$(code -u "$AUTH" -X POST -H 'Content-Type: application/octet-stream' \
	   "http://127.0.0.1:$PORT/api/upload")"
check "an upload needs the credential" 401 \
	"$(code -X POST --data-binary @/tmp/fake.tar "http://127.0.0.1:$PORT/api/upload")"
check "a cross-origin upload is refused" 403 \
	"$(code -u "$AUTH" -H 'Origin: http://evil.example' -X POST \
	   --data-binary @/tmp/fake.tar "http://127.0.0.1:$PORT/api/upload")"

# Every OTHER route must still refuse a body it cannot hold whole. read_request
# used to error on one itself; now it reports one, and this is what keeps that
# from quietly becoming a truncated config write.
#
# 20 KB, just over the 16 KB request buffer (src/buffers.h), not the 3 MB file:
# the daemon answers 413 and closes while the client is still sending, so with
# a large body curl is reset mid-send and never reads the status at all. That
# is correct of the server and useless as an assertion. 64 KB still lost that
# race on a CI runner (v1.0.2); 20 KB fits in the socket buffers, so the send
# finishes first, which tests the rule rather than TCP.
dd if=/dev/urandom of=/tmp/big.bin bs=1024 count=20 2>/dev/null
check "an oversized body on another route is still 413" 413 \
	"$(curl -s -o /dev/null -w '%{http_code}' -u "$AUTH" -X POST \
	   --data-binary @/tmp/big.bin "http://127.0.0.1:$PORT/api/config")"
# And nothing was written from the part of it that did arrive.
check "and nothing from it was written" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/values")" '"LAN_IP_ADDR":"192.168.1.1"')"
rm -f /tmp/fake.tar /tmp/big.bin

# The daemon refuses to write the partition it is running, independently of
# whatever the page offers. The nv stub says sw_active=0.
check "writing the running partition is refused" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'action=write&partition=0' "http://127.0.0.1:$PORT/api/firmware")" 'that is the partition this stick is running')"
check "a bad partition is still refused" 400 \
	"$(code -u "$AUTH" -X POST -d 'action=write&partition=9' "http://127.0.0.1:$PORT/api/firmware")"

# A background write, as odi-oss fwu_starter.sh leaves it: the state and the
# log are reported so the page can follow it.
printf 'running 4242 1\n' > /tmp/fwu.state
printf 'fwu: slot 1 -> kernel /dev/mtd6\nfwu: erasing /dev/mtd6\n' > /tmp/fwu.log
check "a running write is reported" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/firmware")" '"write":{"state":"running","pid":"4242","slot":"1","rc":""')"
check "with the end of its log" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/firmware")" 'erasing /dev/mtd6')"
printf 'failed 4242 1 3\n' > /tmp/fwu.state
check "and a failed one with its exit code" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/firmware")" '"state":"failed","pid":"4242","slot":"1","rc":"3"')"
rm -f /tmp/fwu.state /tmp/fwu.log
check "no state file, no write field" no \
	"$(case "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/firmware")" in *'"write"'*) echo yes ;; *) echo no ;; esac)"

echo "== applying"
# /etc/scripts/apply.sh does the work on odi-oss; the stub echoes what it was
# asked, so the argv the route builds is what is checked.
cat > /etc/scripts/apply.sh <<'APPLY'
#!/bin/sh
echo "apply.sh: $1"
[ "$1" = omci ] && [ -f /tmp/apply-fail ] && exit 1
exit 0
APPLY
chmod +x /etc/scripts/apply.sh
check "apply network runs apply.sh network" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'what=network' "http://127.0.0.1:$PORT/api/apply")" '"ok":true,"applied":true,"output":"apply.sh: network')"
check "apply omci runs apply.sh omci" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'what=omci' "http://127.0.0.1:$PORT/api/apply")" 'apply.sh: omci')"
check "apply syslog runs apply.sh syslog" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'what=syslog' "http://127.0.0.1:$PORT/api/apply")" 'apply.sh: syslog')"
check "apply ntp runs apply.sh ntp" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'what=ntp' "http://127.0.0.1:$PORT/api/apply")" 'apply.sh: ntp')"
touch /tmp/apply-fail
check "a failing apply is reported as not applied" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'what=omci' "http://127.0.0.1:$PORT/api/apply")" '"ok":false')"
rm -f /tmp/apply-fail
check "an unknown action is refused" 400 \
	"$(code -u "$AUTH" -X POST -d 'what=reboot' "http://127.0.0.1:$PORT/api/apply")"
check "applying needs the credential" 401 \
	"$(code -X POST -d 'what=omci' "http://127.0.0.1:$PORT/api/apply")"
check "a cross-origin apply is refused" 403 \
	"$(code -u "$AUTH" -H 'Origin: http://evil.example' -X POST -d 'what=omci' "http://127.0.0.1:$PORT/api/apply")"
rm -f /etc/scripts/apply.sh
check "without apply.sh the network action is refused" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'what=network' "http://127.0.0.1:$PORT/api/apply")" 'reboot to apply')"

check "without apply.sh the syslog action is refused, not turned into an omci restart" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'what=syslog' "http://127.0.0.1:$PORT/api/apply")" 'reboot to apply')"

echo "== switch files"
check "the OLT identity switch starts off" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/firmware")" '"switches":{"omci-identity.on":false}')"
check "it can be turned on" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'name=omci-identity.on&on=1' "http://127.0.0.1:$PORT/api/switch")" '"ok":true,"on":true')"
check "which creates the file" yes "$([ -f /etc/config/omci-identity.on ] && echo yes)"
check "and is reported" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/firmware")" '"switches":{"omci-identity.on":true}')"
check "and off again" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'name=omci-identity.on&on=0' "http://127.0.0.1:$PORT/api/switch")" '"ok":true,"on":false')"
check "which removes it" no "$([ -f /etc/config/omci-identity.on ] && echo yes || echo no)"
for bad in 'name=confd.auth&on=0' 'name=../confd.auth&on=0' 'name=omci-identity.on&on=2' 'name=omci-identity.on'; do
	check "switch refuses $bad" 400 \
		"$(code -u "$AUTH" -X POST -d "$bad" "http://127.0.0.1:$PORT/api/switch")"
done
check "the credential file survived every refusal" yes "$([ -f /etc/config/confd.auth ] && echo yes)"

echo "== tools"
# Ping takes IPv4 literals and nothing else. Not fussiness: this server is
# serial, so a hostname means a DNS lookup on a device with no route to a
# resolver, and that hangs rather than failing -- taking the whole UI with it.
# shellcheck disable=SC2016  # the $(id) case must reach the daemon unexpanded
for bad in 'host=example.com' 'host=1.2.3' 'host=1.2.3.4.5' 'host=' \
           'host=$(id)' 'host=1.2.3.4;id' 'nothost=1.2.3.4'; do
	check "ping refuses $bad" 400 \
		"$(code -u "$AUTH" -X POST -d "$bad" "http://127.0.0.1:$PORT/api/ping")"
done
check "ping accepts an IPv4 literal" 200 \
	"$(code -u "$AUTH" -X POST -d 'host=127.0.0.1' "http://127.0.0.1:$PORT/api/ping")"
# There is no /bin/ping in the toolchain container, which makes this the case
# worth pinning: a missing binary must not read as "no reply", or it sends you
# to look at the network instead of at the image.
check "a missing ping says so, rather than 'no reply'" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'host=127.0.0.1' "http://127.0.0.1:$PORT/api/ping")" 'no ping in this image')"
check "the kernel log comes back" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/log")" '"truncated"')"
check "and it is not empty" yes \
	"$([ "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/log" | wc -c)" -gt 200 ] && echo yes || echo no)"
check "reading it twice gives the same buffer" yes \
	"$([ "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/log")" = "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/log")" ] && echo yes || echo no)"

echo "== the switch MAC table"
# Its own route, not another line in the status scrape: the status buffer is
# 16 KB and the counter dump alone is 5.9 KB, so a few hundred learned
# addresses would push the optics out of the response.
check "the MAC table is read from diag" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/l2")" '78:54:2E:07:64:63')"
# It must come from the ARGV path. diag spins forever when this command arrives
# on stdin, which hung the whole daemon on a real stick.
check "and via argv, not stdin" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/l2")" 'LUT address')"
check "and it is not truncated at this size" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/l2")" '"truncated":false')"
# Never covered before, because there was no diag stub: the status scrape puts
# every question in on one stdin and splits the answers on the prompt.
check "the status scrape batches its commands" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/status")" 'Operation State(O5)')"
check "and every command in the batch answers" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/status")" 'Rx Power')"
check "it needs the credential" 401 \
	"$(code "http://127.0.0.1:$PORT/api/l2")"

echo "== resetting the service config"
# flash default cs, not flash_eraseall: the hs store holds GPON_SN, MAC_KEY and
# ELAN_MAC_ADDR, and erasing the partition is what ends sticks in the field.
check "a reset without the confirm is refused" 400 \
	"$(code -u "$AUTH" -X POST "http://127.0.0.1:$PORT/api/reset")"
check "a wrong confirm is refused" 400 \
	"$(code -u "$AUTH" -X POST -d '_confirm=yes' "http://127.0.0.1:$PORT/api/reset")"
check "a confirmed reset runs flash default cs" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d '_confirm=reset' "http://127.0.0.1:$PORT/api/reset")" 'Reset CS to default configuration success')"
check "and reports it succeeded" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d '_confirm=reset' "http://127.0.0.1:$PORT/api/reset")" '"ok":true')"
# The hs store is not reachable from here at all. The route hardcodes cs, so a
# store parameter must not be able to steer it.
check "the store cannot be steered to hs" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'store=hs&_confirm=reset' "http://127.0.0.1:$PORT/api/reset")" 'Reset CS to default')"
check "a reset needs the credential" 401 \
	"$(code -X POST -d '_confirm=reset' "http://127.0.0.1:$PORT/api/reset")"
check "a cross-origin reset is refused" 403 \
	"$(code -u "$AUTH" -H 'Origin: http://evil.example' -X POST -d '_confirm=reset' "http://127.0.0.1:$PORT/api/reset")"

echo "== the OMCI MIB route"
# Everything reaching omcicli comes off a query string, so the checks that
# matter are the ones that keep a request from choosing the command. There is
# no shell in this daemon -- run_to_buf_ex execve()s directly -- but the domain
# check is what makes a bad argument fail as "not a MIB table" here instead of
# somewhere further in.
check "a class id is read" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/omci?cmd=me&me=84")" 'VlanTagFilterData')"
check "the entity id reaches the command" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/omci?cmd=me&me=84&entity=0x04")" 'ARGV: mib get 84 0x04')"
check "a table name is accepted too" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/omci?cmd=me&me=VlanTagFilterData")" 'ARGV: mib get VlanTagFilterData')"
# `omcicli get tables` is refused, not proxied. On a stick it returns zero
# bytes and leaves the MIB service unable to answer until omci_app restarts --
# so the route that exists to read the MIB must not be able to break it. The
# names ship as data instead.
check "get tables is refused, not run" 400 \
	"$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/omci?cmd=tables")"
check "and the reason says why" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/omci?cmd=tables")" 'wedges the MIB service')"
check "an allowlisted dump is read" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/omci?cmd=dump&what=srvflow")" 'ARGV: dump srvflow')"

for bad in 'cmd=me&me=84;reboot' 'cmd=me&me=../../etc/passwd' 'cmd=me&me=-rf' \
           'cmd=me&me=84%20171' 'cmd=me' 'cmd=dump&what=conn;id' 'cmd=dump' \
           'cmd=set&me=84' ''; do
	check "refuses ?$bad" 400 \
		"$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/omci?$bad")"
done
check "a non-hex entity is refused" 400 \
	"$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/omci?cmd=me&me=84&entity=zz")"

# The query string is split off the path for every route, not just this one.
# Before that, a single `?` made /api/status a 404.
check "a query string does not break another route" 200 \
	"$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/schema?cachebust=1")"

echo "== a malformed schema must fail closed"
# confd prefers /etc/config/confd/keys.tsv, which is edited live on the device
# and which `make check` never sees. A row there that is short, or whose type is
# misspelt, used to be the MOST permissive row in the file: the out-params were
# left empty, and empty was neither "never" nor a known type, so the key became
# writable and unvalidated.
mkdir -p /etc/config/confd
{
	printf 'name\tstore\taddress\tsection\ttype\tapply\twritable\tcommon\n'
	printf 'SHORT_ROW\tcs\tSHORT_ROW\tTest\tint\tunknown\n'
	printf 'BAD_TYPE\tcs\tBAD_TYPE\tTest\titn\tunknown\tyes\tno\n'
	printf 'GOOD_ROW\tcs\tGOOD_ROW\tTest\tint\tunknown\tyes\tno\n'
} > /etc/config/confd/keys.tsv

check "a row missing its columns is not writable" yes \
	"$(err "$(post 'SHORT_ROW=1')" 'not in the schema')"
check "a misspelt type is refused, not waved through" yes \
	"$(err "$(post 'BAD_TYPE=anything')" 'not valid for its type')"
check "a well-formed row in the same file still works" yes \
	"$(err "$(post 'GOOD_ROW=7')" '"ok":true,"value":"7"')"
rm -f /etc/config/confd/keys.tsv

echo "== an idle client must not take the server down"
# Single-threaded and serial, so a peer that connects and never sends used to
# block every other request indefinitely -- a port scanner holding a socket, or
# a client whose network dropped between connect and send. SO_RCVTIMEO bounds
# it. This deliberately waits out that timeout, which is why it is the slowest
# check here.
python3 -c 'import socket,sys,time
s = socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=5)
time.sleep(30)' "$PORT" &
IDLE=$!
sleep 1
if curl -fsS --max-time 25 -u "$AUTH" -o /dev/null "http://127.0.0.1:$PORT/api/schema"; then
	r=served
else
	r=blocked
fi
kill $IDLE 2>/dev/null || true
check "the server recovers from a peer that never sends" served "$r"

echo
if [ "$fail" -gt 0 ]; then
	echo "$fail failed, $pass passed"
	exit 1
fi
echo "$pass checks passed"
