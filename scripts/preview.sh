#!/usr/bin/env bash
#
# Run the real daemon under qemu, on a host port, with fixture data behind it.
#
# The only other way to look at this page is to flash a stick and open a
# browser, which is a slow loop for a CSS bug. This serves the ACTUAL binary --
# same routing, same asset table, same auth -- with stubs for /etc/scripts/flash
# and /bin/diag that answer in the shapes the device does.
#
# The diag stub answers each command separately, which matters: an earlier
# version replied to every `pon get transceiver *` with one block, and the page
# then showed the temperature as the Rx power. That was the fixture being wrong,
# not the page, and it took a screenshot to notice.
#
#   scripts/preview.sh                     -> http://127.0.0.1:18080
#   scripts/shot.mjs                       -> screenshots + console errors
#   docker rm -f odi-ui-preview            -> stop it
set -e
docker rm -f odi-ui-preview >/dev/null 2>&1 || true
docker run -d --name odi-ui-preview -p 18080:18080 \
  -v "$PWD":/src -w /src odi-ui-toolchain bash -c '
    mkdir -p /etc/confd /etc/config /etc/scripts
    cp schema/*.tsv web/*.html web/*.css web/*.js /etc/confd/
    printf admin:admin > /etc/config/confd.auth
    cat > /etc/scripts/flash <<"FLASH"
#!/bin/sh
case "$1" in
all) cat <<XML
<Dir Name="MIB_TABLE">
  <Value Name="VLAN_MANU_TAG_VID" Value="110"/>
  <Value Name="VLAN_CFG_TYPE" Value="1"/>
  <Value Name="VLAN_MANU_MODE" Value="1"/>
  <Value Name="DEVICE_TYPE" Value="0"/>
  <Value Name="LAN_IP_ADDR" Value="192.168.1.1"/>
  <Value Name="GPON_SN" Value="4F44490012345678"/>
  <Value Name="PON_VENDOR_ID" Value="ODI0"/>
  <Value Name="GPON_PLOAM_PASSWD" Value="31323334353637383930"/>
</Dir>
<Dir Name="SW_PORT_TBL"> <!--index=1-->
  <Value Name="PVID" Value="1"/>
</Dir>
XML
;;
set) echo "$2=$3" ;;
esac
FLASH
    chmod +x /etc/scripts/flash
    cat > /bin/diag <<"DIAG"
#!/bin/sh
while read -r l; do
  printf "RTK.0> %s\n" "$l"
  case "$l" in
   *"transceiver rx-power"*)    printf "  Rx Power          : -18.42 dBm\n" ;;
   *"transceiver tx-power"*)    printf "  Tx Power          : 2.15 dBm\n" ;;
   *"transceiver temperature"*) printf "  Temperature       : 45.50 C\n" ;;
   *"transceiver voltage"*)     printf "  Voltage           : 3.28 V\n" ;;
   *onu-state*)  printf "  Operation State(O5)\n" ;;
   *alarm-status*) printf "  LOS Alarm         : clear\n  LOF Alarm         : clear\n  LCDA Alarm        : clear\n  SF Alarm          : clear\n  SD Alarm          : clear\n  TF Alarm          : clear\n  DACT Alarm        : clear\n" ;;
   *"counter port all"*) printf "Port: 0\n  ifInOctets : 148392011\n  ifOutOctets : 91002233\n  dot1dTpPortInDiscards : 0\nPort: 2\n  ifInOctets : 91004410\n  ifOutOctets : 148390115\n  dot1dTpPortInDiscards : 0\n" ;;
   *) printf "  ok\n" ;;
  esac
done
DIAG
    chmod +x /bin/diag
    exec qemu-mips-static build/confd 18080'
sleep 2
curl -s -o /dev/null -w "daemon: HTTP %{http_code}\n" -u admin:admin http://127.0.0.1:18080/
