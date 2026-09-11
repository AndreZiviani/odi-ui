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

/* Written by the image build: image=, base=, confd=, exporter=, built=.
 * One file naming every component, so "what is on this stick" is a single read
 * rather than three build stamps that have to be correlated by hand. Absent on
 * a stick running an override, which is itself worth seeing. */
#define BUILD_MANIFEST "/etc/odi-build"

#endif /* CONFD_H */
