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
# --cap-add SYSLOG so the Tools tab has a kernel log to show: klogctl is
# refused in a default container. It reads the host VM's buffer, which is not
# what a stick would say but is the right SHAPE -- priority prefixes and all.
docker run -d --name odi-ui-preview -p 18080:18080 --cap-add SYSLOG \
  -v "$PWD":/src -w /src odi-ui-toolchain bash -c '
    mkdir -p /etc/confd /etc/config /etc/scripts
    cp schema/*.tsv web/*.html web/*.css web/*.js /etc/confd/
    # No credential file on purpose: this is the state a freshly flashed or
    # factory-reset stick is in, and the fallback plus its banner is exactly
    # what wants looking at. Write one here to preview the other state.
    cat > /etc/scripts/flash <<"FLASH"
#!/bin/sh
case "$1" in
all) cat <<XML
<Dir Name="MIB_TABLE">
  <Value Name="VLAN_MANU_TAG_VID" Value="110"/>
  <Value Name="VLAN_CFG_TYPE" Value="1"/>
  <Value Name="VLAN_MANU_MODE" Value="1"/>
  <Value Name="DEVICE_TYPE" Value="0"/>
  <Value Name="LAN_IP_ADDR" Value="192.168.0.3"/>
  <Value Name="GPON_SN" Value="4F44490012345678"/>
  <Value Name="PON_VENDOR_ID" Value="ODI0"/>
  <Value Name="GPON_PLOAM_PASSWD" Value="31323334353637383930"/>
  <Value Name="OMCI_CUSTOM_BDP" Value="258"/>
  <Value Name="OMCI_CUSTOM_RDP" Value="4"/>
  <Value Name="OMCI_CUSTOM_MCAST" Value="0"/>
  <Value Name="OMCI_CUSTOM_ME" Value="65792"/>
</Dir>
<Dir Name="SW_PORT_TBL"> <!--index=1-->
  <Value Name="PVID" Value="1"/>
</Dir>
XML
;;
set) echo "$2=$3" ;;
default) echo "Reset CS to default configuration success."; echo "Please reboot system." ;;
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
   *l2-table*) cat /src/scripts/fixtures/l2-table.txt ;;
   *) printf "  ok\n" ;;
  esac
done
DIAG
    chmod +x /bin/diag
    # The omcicli stub. ME 84 and 171 come from scripts/fixtures/omci/, which
    # is real device output; the rest are hand-built and the ATTRIBUTE NAMES in
    # them are assumptions, not captures. So a screenshot of the Services tab
    # proves the layout and the frame parsing, and proves nothing about whether
    # this firmware really calls the ME 7 version attribute "Version". Only
    # scripts/capture-omci.sh against a real stick settles that.
    cat > /bin/omcicli <<"OMCICLI"
#!/bin/sh
frame() { printf "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX\n%s\nXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX\n" "$1"; }
case "$1 $2 $3" in
"mib get 84")  cat /src/scripts/fixtures/omci/84-VlanTagFilterData.txt ;;
"mib get 171") cat /src/scripts/fixtures/omci/171-ExtVlanTagOperCfgData.txt ;;
"mib get 7")
  frame SWImage
  printf "=================================\nEntityId: 0x0000\nVersion: ODI-260910-6861b53\nIsCommitted: 1\nIsActive: 1\nIsValid: 1\n=================================\n"
  printf "=================================\nEntityId: 0x0001\nVersion: V1.0-220923\nIsCommitted: 0\nIsActive: 0\nIsValid: 1\n=================================\n" ;;
"mib get 131")
  frame OltG
  printf "=================================\nEntityId: 0x0000\nOltVendorId: 0x414c434c\nEquipmentId: 0x00\nVersion: 0x00\nTime: 0x00\n=================================\n" ;;
"mib get 262")
  frame Tcont
  printf "=================================\nEntityId: 0x8000\nAllocId: 1026\nPolicy: 0\n=================================\n" ;;
"mib get 268")
  frame GemPortCtp
  for e in 0x0101 0x0102 0x0103; do
    printf "=================================\nEntityId: %s\nPortId: 2177\nTcontPtr: 0x8000\n=================================\n" "$e"
  done ;;
"get tables ") printf "class id: 2 OntData\nclass id: 7 SWImage\nclass id: 84 VlanTagFilterData\nclass id: 171 ExtVlanTagOperCfgData\n" ;;
"dump conn ") printf "no connection\n" ;;
*) printf "" ;;
esac
exit 0
OMCICLI
    chmod +x /bin/omcicli
    # A ping stub. The container has no /bin/ping, and its networking is not
    # the one a stick has, so this answers in the shape busybox ping does.
    cat > /bin/ping <<"PING"
#!/bin/sh
while [ $# -gt 1 ]; do shift; done
echo "PING $1 ($1): 56 data bytes"
echo "64 bytes from $1: seq=0 ttl=64 time=0.412 ms"
echo "64 bytes from $1: seq=1 ttl=64 time=0.388 ms"
echo "64 bytes from $1: seq=2 ttl=64 time=0.401 ms"
echo
echo "--- $1 ping statistics ---"
echo "3 packets transmitted, 3 packets received, 0% packet loss"
echo "round-trip min/avg/max = 0.388/0.400/0.412 ms"
PING
    chmod +x /bin/ping
    exec qemu-mips-static build/confd 18080'
sleep 2
curl -s -o /dev/null -w "daemon: HTTP %{http_code}\n" -u admin:admin http://127.0.0.1:18080/
