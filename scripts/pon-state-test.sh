#!/bin/sh
# Run inside an isolated toolchain container, loopback only.
set -eu
mkdir -p /etc/config /etc/confd
printf 'admin:synthetic-password\n' > /etc/config/confd.auth
cp web/login.html web/login.js web/style.css /etc/confd/
status=/tmp/confd-pon-status
marker=/etc/config/login-pon-state.on
rm -f "$marker" "$status"
qemu-mips-static build/confd-pon-test 18080 > /tmp/confd-pon-test.log 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || :; rm -f "$marker" "$status"' EXIT
url=http://127.0.0.1:18080
n=0
while ! curl -fsS --max-time 1 "$url/login" >/dev/null 2>&1; do
    n=$((n+1)); [ "$n" -lt 50 ] || exit 1; sleep 0.1
done
code() { curl --max-time 5 -sS -o /tmp/confd-pon-body -D /tmp/confd-pon-head -w '%{http_code}' "$@"; }
check() { [ "$(code "$@")" = "$want" ]; }
printf 'state 5 (O5)\nprivate synthetic\n' > "$status"
want=204; check "$url/api/pon-state"; [ ! -s /tmp/confd-pon-body ]
grep -qi '^Cache-Control: no-store' /tmp/confd-pon-head
want=401; check -X POST -d 'name=login-pon-state.on&on=1' "$url/api/switch"
want=401; check "$url/api/status"; check "$url/api/init"
want=403; check -H 'Host: foreign.example' "$url/api/pon-state"
check -H 'Sec-Fetch-Site: cross-site' "$url/api/pon-state"
check -H 'Origin: http://foreign.example' "$url/api/pon-state"
check -u admin:synthetic-password -H 'Origin: http://foreign.example' -X POST -d 'name=login-pon-state.on&on=1' "$url/api/switch"
want=200; check -u admin:synthetic-password -X POST -d 'name=login-pon-state.on&on=1' "$url/api/switch"
[ -f "$marker" ]
check "$url/api/pon-state"
[ "$(cat /tmp/confd-pon-body)" = '{"state":"registered"}' ]
grep -qi '^Cache-Control: no-store' /tmp/confd-pon-head
printf 'state 3 (O3)\nprivate synthetic\n' > "$status"
check "$url/api/pon-state"; [ "$(cat /tmp/confd-pon-body)" = '{"state":"not_registered"}' ]
printf 'state 5 (O3)\n' > "$status"
check "$url/api/pon-state"; [ "$(cat /tmp/confd-pon-body)" = '{"state":"unknown"}' ]
rm -f "$status"
check "$url/api/pon-state"; [ "$(cat /tmp/confd-pon-body)" = '{"state":"unknown"}' ]
want=403; check -H 'Sec-Fetch-Site: cross-site' "$url/api/pon-state"
want=200; check -u admin:synthetic-password -X POST -d 'name=login-pon-state.on&on=0' "$url/api/switch"
[ ! -f "$marker" ]
want=204; check "$url/api/pon-state"
want=401; check "$url/api/status"; check "$url/api/init"
rm -f /etc/config/confd.auth
want=403; check -u admin:admin -X POST -d 'name=login-pon-state.on&on=1' "$url/api/switch"
[ ! -f "$marker" ]
want=204; check "$url/api/pon-state"
echo 'ok: public PON status off/on/missing/malformed; auth, origin and host checks'
