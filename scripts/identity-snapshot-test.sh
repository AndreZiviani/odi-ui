#!/bin/sh
# Local synthetic files in a disposable container; no stick or apply action.
set -eu
mkdir -p /etc/config /etc/confd /etc/scripts /var/config /var/tmp
printf 'admin:synthetic-password\n' > /etc/config/confd.auth
cp web/login.html web/login.js web/style.css /etc/confd/
printf 'image=v0.0.0-beta.1\n' > /etc/odi-build
printf '<Config>\n<Value Name="GPON_SN" Value="FAKE00000001"/>\n<Value Name="GPON_PLOAM_PASSWD" Value="synthetic-secret-one"/>\n<Value Name="ELAN_MAC_ADDR" Value="020000000001"/>\n<Value Name="LOID_PASSWD" Value="synthetic-secret-two"/>\n</Config>\n' > /var/config/lastgood.xml
printf '<Config>\n</Config>\n' > /var/config/lastgood_hs.xml
# CI uses a script double with the exact show/restore contract. Locally an
# optional upstream identity.sh can exercise the real store implementation.
if [ -n "${REAL_IDENTITY_SCRIPT:-}" ]; then
    cp "$REAL_IDENTITY_SCRIPT" /etc/scripts/identity.sh
else
    cat > /etc/scripts/identity.sh <<'SCRIPT'
#!/bin/sh
case "$1" in
snapshot)
    printf 'fixture\n' > /var/config/identity.orig ;;
show)
    changed='differs'
    grep -q 'FAKE00000001' /var/config/lastgood.xml && changed=same
    cat <<ROWS
image=v0.0.0-beta.1
taken=unknown
GPON_SN: FAKE00000001 [cs] $changed
GPON_PLOAM_PASSWD: (hidden) [cs] same
ELAN_MAC_ADDR: 020000000001 [cs] $changed
GPON_ONU_MODEL: (absent) same
LOID: (absent) same
LOID_PASSWD: (hidden) [cs] $changed
LOID_OLD: (absent) same
LOID_PASSWD_OLD: (absent) same
ONU_HW_VERSION: (absent) same
MAC_KEY: (absent) same
PON_VENDOR_ID: (absent) same
GPON_PLOAM_FORMAT: (absent) same
ROWS
    ;;
restore)
    sed -i 's/FAKE00000002/FAKE00000001/g;s/020000000002/020000000001/g;s/synthetic-secret-current/synthetic-secret-two/g' /var/config/lastgood.xml
    echo 'identity: GPON_SN: restored to FAKE00000001'
    echo 'identity: LOID_PASSWD: restored to (hidden)'
    echo 'identity: next: apply.sh omci (re-registers with the OLT: interrupts internet)'
    echo 'identity: next: reboot, ELAN_MAC_ADDR takes effect at boot'
    ;;
*) exit 1 ;;
esac
SCRIPT
fi
chmod +x /etc/scripts/identity.sh
# An apply/reboot is never part of the interface.
printf '#!/bin/sh\ntouch /tmp/unexpected-apply\n' > /etc/scripts/apply.sh
chmod +x /etc/scripts/apply.sh
rm -f /var/config/identity.orig /tmp/unexpected-apply
qemu-mips-static build/confd 18080 > /tmp/identity-snapshot-test.log 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || :' EXIT
url=http://127.0.0.1:18080
n=0
while ! curl -fsS --max-time 1 "$url/login" >/dev/null 2>&1; do
    n=$((n+1)); [ "$n" -lt 50 ] || exit 1; sleep 0.1
done
code() { curl --max-time 35 -sS -o /tmp/identity-body -w '%{http_code}' "$@"; }
auth() { code -u admin:synthetic-password "$@"; }
endpoint="$url/api/identity-snapshot"
[ "$(code "$endpoint")" = 401 ]
[ "$(auth "$endpoint")" = 200 ]
[ "$(cat /tmp/identity-body)" = '{"available":false}' ]
[ "$(auth -d '_confirm=identity' "$endpoint")" = 404 ]
/etc/scripts/identity.sh snapshot >/dev/null
# Changed current values, all fictitious; no real provisioning happens.
sed -i 's/FAKE00000001/FAKE00000002/g;s/020000000001/020000000002/g;s/synthetic-secret-two/synthetic-secret-current/g' /var/config/lastgood.xml
[ "$(auth "$endpoint")" = 200 ]
grep -q '"available":true,"image":"v0.0.0-beta.1"' /tmp/identity-body
grep -q '"key":"GPON_SN","captured":"present","current":"different"' /tmp/identity-body
grep -q '"key":"LOID_PASSWD","captured":"present","current":"different"' /tmp/identity-body
! grep -Eq 'FAKE000|synthetic-secret|02000000000' /tmp/identity-body
[ "$(code -d '_confirm=identity' "$endpoint")" = 401 ]
[ "$(auth -d 'GPON_SN=FAKE00000003&_confirm=identity' "$endpoint")" = 400 ]
[ "$(auth -d '_confirm=wrong' "$endpoint")" = 400 ]
[ "$(auth -H 'Origin: http://foreign.example' -d '_confirm=identity' "$endpoint")" = 403 ]
grep -q 'FAKE00000002' /var/config/lastgood.xml
[ "$(auth -d '_confirm=identity' "$endpoint")" = 200 ]
[ "$(cat /tmp/identity-body)" = '{"ok":true,"omci":true,"reboot":true}' ]
grep -q 'FAKE00000001' /var/config/lastgood.xml
grep -q 'synthetic-secret-two' /var/config/lastgood.xml
[ ! -f /tmp/unexpected-apply ]
[ "$(auth "$endpoint")" = 200 ]
grep -q '"key":"GPON_SN","captured":"present","current":"same"' /tmp/identity-body
! grep -Eq 'FAKE000|synthetic-secret|02000000000' /tmp/identity-body
! grep -Eq 'FAKE000|synthetic-secret|02000000000' /tmp/identity-snapshot-test.log
echo 'ok: snapshot unavailable, private diff, only confirmed fixed restore, no apply'
