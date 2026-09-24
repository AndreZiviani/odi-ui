/*
 * confd — a web configuration UI for the ODI DFP-34X-2C2 (Realtek RTL9601D).
 *
 * Runs alongside the vendor's boa on its own port. It does not replace boa and
 * does not try to: boa's UI is 88 handlers compiled into the boa binary with no
 * CGI seam to hook, so the only way to extend it is to not use it.
 *
 * The design that makes this small: serve a static page and a JSON API, and let
 * the browser render. The device's configuration is ~184 MIB keys plus a couple
 * of indexed tables, described by a schema file rather than by C, so adding a
 * key is a data change and not a new handler.
 *
 * Values are emitted as the literal text `flash` printed. Nothing is parsed to
 * a number and formatted back, which is why a freestanding build with no libc
 * costs nothing here.
 *
 * This header carries what every translation unit needs: the paths it reads and
 * the two ports it binds. Everything else lives behind its own header.
 */

#ifndef CONFD_H
#define CONFD_H

#include "util.h"

/*
 * Stamped in by the Makefile from `git describe`. It is reported by
 * /api/firmware and shown in the page footer for the same reason the exporter
 * reports its own: /etc/config/confd/confd overrides the image's copy and
 * survives reflashing, so the binary that is running can quietly outlive the
 * image it was built against. Which one is live should be a query, not an
 * inspection.
 */
#ifndef BUILD_ID
#define BUILD_ID "unknown"
#endif

#define DEFAULT_PORT 8080
#define BACKLOG      8

#define FLASH_PATH "/etc/scripts/flash"
#define DIAG_PATH  "/bin/diag"
#define OMCICLI_PATH "/bin/omcicli"
#define PING_PATH    "/bin/ping"
#define MD5SUM_PATH  "/bin/md5sum"
#define FWU_STARTER  "/etc/scripts/fwu_starter.sh"
/*
 * What fwu_starter.sh leaves behind on an image that writes in the background
 * (odi-oss): the state, "running|ok|failed <pid> <slot> [rc]", and the flasher's
 * own output. /api/firmware reports both so the page can follow a write
 * without this daemon blocking for the eighty seconds it takes. Absent on an
 * image whose fwu_starter.sh still blocks, and then the POST answer is final.
 */
#define FWU_STATE    "/tmp/fwu.state"
#define FWU_LOG      "/tmp/fwu.log"
/*
 * How the image applies saved settings without a reboot (odi-oss
 * /etc/scripts/apply.sh): `apply.sh network` re-applies the management
 * addresses, live; `apply.sh omci` restarts the OMCI daemon and re-ranges the
 * ONU, which interrupts the internet. Absent, "omci" falls back to restarting
 * the stock omci_app, and "network" is refused.
 */
#define APPLY_PATH   "/etc/scripts/apply.sh"
/* The override network.sh prefers over LAN_IP_ADDR; reported so the page can
 * say the key is ignored while it exists. */
#define LANIP_OVERRIDE "/etc/config/lan-ip"
/*
 * Switch files on the config partition that the UI may create and remove.
 * An allowlist of exact names: the route that toggles them builds a path from
 * a request, and nothing but these names may reach the filesystem.
 *
 *   omci-identity.on   report the OLT identity keys (OMCI_SW_VER1/2,
 *                      GPON_ONU_MODEL, OMCC_VER, OMCI_VENDOR_PRODUCT_CODE) to
 *                      the OLT. Off, omcid answers what it always has.
 */
#define SWITCH_DIR   "/etc/config/"
#define SWITCH_OMCI_IDENTITY "omci-identity.on"

/*
 * Where an uploaded image lands. /tmp is ramfs sharing ~27 MB with everything
 * else running, and about 12.9 MB of that is actually free -- so a 3 MB image
 * fits with room, and something much larger would not. UPLOAD_MAX is the guard:
 * it refuses before writing rather than after filling the filesystem every
 * other process on this device is also using.
 */
#define UPLOAD_PATH  "/tmp/img.tar"
#define UPLOAD_MAX   (8u * 1024u * 1024u)

/* The image ships these; /etc/config wins so the UI can be iterated without a
 * reflash, exactly as the exporter binary can. */
#define WEB_DIR      "/etc/confd/"
#define WEB_DIR_OVR  "/etc/config/confd/"
#define SCHEMA_PATH     "/etc/confd/keys.tsv"
#define SCHEMA_PATH_OVR "/etc/config/confd/keys.tsv"
#define META_PATH       "/etc/confd/meta.tsv"
#define META_PATH_OVR   "/etc/config/confd/meta.tsv"
#define CONS_PATH       "/etc/confd/consumers.tsv"
#define CONS_PATH_OVR   "/etc/config/confd/consumers.tsv"
#define BASE_PATH       "/etc/confd/baseline.tsv"
#define BASE_PATH_OVR   "/etc/config/confd/baseline.tsv"
/*
 * What THIS image does with each key: its apply class (live, restart, reboot,
 * internet), the action that applies it (network, omci, reboot), the key it is
 * written together with, who reads it, and a note. Per image like the schema:
 * a key with no row here is one nothing on the image reads -- kept in the store
 * and in backups for the stock firmware in the other slot, and not offered for
 * editing. Absent altogether, every key is offered, as before this table.
 */
#define SETT_PATH       "/etc/confd/settings.tsv"
#define SETT_PATH_OVR   "/etc/config/confd/settings.tsv"
/* Which bit of each OMCI_CUSTOM_* mask loads which plugin, generated from the
 * image's own lib/features by scripts/gen-features.py. Per-image, like the
 * schema: a different base implements a different set. */
#define FEAT_PATH       "/etc/confd/features.tsv"
#define FEAT_PATH_OVR   "/etc/config/confd/features.tsv"

/*
 * Two reference points for "is this value ours or the device's?".
 *
 * /etc/config_default*.xml is what the IMAGE ships, and is authoritative — but
 * it covers only ten keys. The full set of built-in defaults lives inside the
 * MIB and there is no read-only way to dump it: `xmlconfig -def_mib -os` looks
 * like it should and simply prints the current configuration instead, which
 * would have made every key look like a default.
 *
 * So the second reference is a baseline captured from a stick you consider
 * correct, which answers the question that actually gets asked: what have we
 * changed since.
 */
#define DEFAULT_CS "/etc/config_default.xml"
#define DEFAULT_HS "/etc/config_default_hs.xml"
#define AUTH_PATH    "/etc/config/confd.auth"
/* dropbear -D names this directory; the image starts it that way. */
#define SSHKEYS_DIR  "/etc/config/dropbear.d"
#define SSHKEYS_PATH SSHKEYS_DIR "/authorized_keys"
/*
 * What confd uses when /etc/config/confd.auth is missing or empty.
 *
 * The UI used to refuse every request in that state. That is the safer posture
 * in the abstract and the wrong one here: the config partition is exactly what
 * a factory reset erases, and an image flashed onto a stick that has never had
 * the file is not "secured", it is a config UI nobody can open -- on a device
 * whose only other management paths are telnet and a 2007 dropbear.
 *
 * So it falls back, to the same credential every other service on this stick
 * already uses: SUSER_NAME/SUSER_PASSWORD ship as admin/admin and that is the
 * ssh and telnet login too. The fallback is never silently better than what it
 * replaces, and it is never invisible -- /api/firmware reports which one is in
 * use and the page says so on every tab until a real credential is written.
 */
#define DEFAULT_AUTH "admin:admin"

/* Written by the image build: image=, base=, confd=, exporter=, built=.
 * One file naming every component, so "what is on this stick" is a single read
 * rather than three build stamps that have to be correlated by hand. Absent on
 * a stick running an override, which is itself worth seeing. */
#define BUILD_MANIFEST "/etc/odi-build"

#endif /* CONFD_H */
