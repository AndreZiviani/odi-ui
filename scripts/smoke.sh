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
AUTH='admin:admin'

if [ "${IN_CONTAINER:-0}" != 1 ]; then
	docker run --rm -v "$PWD":/src -w /src odi-ui-toolchain \
		env IN_CONTAINER=1 scripts/smoke.sh
	exit $?
fi

[ -x "$BIN" ] || { echo "no $BIN -- run 'make confd' first" >&2; exit 1; }

# The daemon reads absolute paths. We are root in the container, so give it the
# real ones rather than teaching it about a prefix it would only need for tests.
mkdir -p /etc/confd /etc/config
cp schema/keys.tsv schema/meta.tsv schema/consumers.tsv schema/features.tsv /etc/confd/
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

# A stand-in for /bin/omcicli. The route builds its argv from the query string,
# so the stub ECHOES what it was given before printing a dump: that is what
# makes "the entity id reaches the command" a check that can fail, rather than
# an assumption. Real omcicli is not runnable here -- it talks to omci_app.
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
err() { case "$1" in *"$2"*) echo yes ;; *) echo "no: $1" ;; esac; }

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
check "an untraced key is reported as untraced" yes \
	"$(err "$(post 'LAN_IP_ADDR=192.168.1.1')" '"untraced":true')"
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
check "the OMCI feature bits are served" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/features")" '"feature":"ignore_conn_uniNode_check"')"
check "the build id is reported" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/firmware")" '"confd":')"

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
check "the registered table list is read" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/omci?cmd=tables")" 'ARGV: get tables')"
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
