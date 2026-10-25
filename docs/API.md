# API reference

Quick reference for `confd`'s HTTP API. Every write route also validates and
authenticates as described in [`DESIGN.md`](DESIGN.md#authentication) — this
page is the wire contract, not the rationale. See `DESIGN.md` for why each
route behaves the way it does.

Every request, before the credential is looked at, must carry a `Host` that is an
IP literal, a single label or a private suffix (`.local`, `.lan`, `.home.arpa`,
`.localdomain`, `.internal`, `.localhost`, `.home`), or a name listed in
`/etc/config/confd.hosts`; anything else is `403` (DNS rebinding). A request a
browser marks `Sec-Fetch-Site: cross-site` or `same-site` is `403` unless it is a
top-level navigation.

All writes require the same HTTP Basic credential as the page, refuse a
cross-site `Origin`, and (for `/api/config`) read every value back before
reporting success.

## Config and values

    GET  /api/settings                  settings.tsv as JSON, [] when absent
    GET  /api/values                     current values, as the daemon's own parser sees them
    POST /api/config   key=value&key2=value2
                                          per-key result, apply class, and whether
                                          that class is a traced fact or an assumption;
                                          identity keys need `_confirm=identity`.
                                          On odi-oss also `needs` (the actions),
                                          `stock` and `interrupts` (whether the
                                          omci action drops the fibre service)
    POST /api/apply     what=network|omci|syslog|ntp|igmp
                                          apply.sh on odi-oss (`omci` signals the
                                          running omcid to reload: a VLAN change is
                                          rebuilt in place, an identity change
                                          re-registers the ONU); without it, `omci`
                                          restarts omci_app
    POST /api/switch    name=...&on=0|1  create or remove one allowlisted switch file
                                          (currently just `omci-identity.on`)

The page's data files, each a TSV from `/etc/confd/` (or its override in
`/etc/config/confd/`) served as a JSON array of objects, one per row:

    GET  /api/schema                     keys.tsv: name, store, address, section,
                                          type, apply, writable, common;
                                          500 {"error":"no schema"} when absent
    GET  /api/meta                       meta.tsv: name, label, help, options,
                                          depends, range; [] when absent
    GET  /api/consumers                  consumers.tsv: name, apply, readers
                                          (which programs read each key); [] when absent
    GET  /api/features                   features.tsv: mask, bit, feature, module
                                          (the OMCI_CUSTOM_* bits decoded); [] when absent
    GET  /api/baseline                   baseline.tsv: name, value; [] when absent
    GET  /api/defaults                   the image defaults, from /etc/config_default.xml
                                          and /etc/config_default_hs.xml, in the
                                          /api/values shape; {} when neither exists

Refused regardless of schema: `LAN_SDS_MODE`, `LAN_SPEED_MODE`, `FIBER_MODE`.

## MIB and services

    GET  /api/omci      cmd=...          `omcicli mib get` passthrough; refuses
                                          `get tables` outright (see DESIGN.md).
                                          Also refuses (403) classes 148, 157,
                                          307 and 65530, their names and `all`: they hold
                                          secrets the OLT provisioned.
                                          `me` is a class id (1-65535) or a table
                                          name (letters, digits, `_`, 39 at most);
                                          `entity` is optional hex, 1-4 digits (16
                                          bits), `0x` allowed

    GET  /api/voip                       the phone lines the OLT provisioned:
                                          {"raw": `omcicli voip`, "truncated", "ok"},
                                          or {"ok":false,"error"} with the raw text
                                          (no omcicli, timeout, refused). The masked
                                          view only: number, display name and login
                                          are shortened (`MASKED-` and the last four
                                          characters), the password is only said to be
                                          set. The argv is fixed, so no field can add
                                          `--secrets`
    POST /api/voip/secrets  password=... the same view with the number, name, login and
                                          password in clear, for a caller that repeats
                                          the admin password in the body. 403 on a wrong
                                          password (after a one-second delay) and while
                                          the built-in admin:admin is in force, 400
                                          without a password, 503 `{"ok":false}` and no
                                          output when the image has no omcicli.
                                          Nothing is logged and confd wipes the
                                          password and the output after answering

## Status and diagnostics

    GET  /api/status                     {"raw": one diag run (rx/tx power,
                                          temperature, voltage, ONU state, alarms,
                                          port counters)}; the page splits it on the
                                          prompt. {"error":"diag failed"} on failure
    GET  /api/ntp                        {"now": the stick's clock, epoch seconds,
                                          "ntp": null, or {"event","time","offset",
                                          "stratum","last_sync"} from /tmp/ntp-status
                                          (odi-oss; known events only, values digits,
                                          `.` and `-`)}
    GET  /api/log                        kernel ring buffer, via klogctl
    POST /api/ping       host=<IPv4>      a literal a host can have (first number
                                          1-223, not 127, no leading zeros), no DNS
    GET  /api/l2                         `diag l2-table get entry address valid`
                                          (stock and odi-oss, different column sets)
    GET  /api/diag                       the diagnostics bundle, a tar.gz download:
                                          runs the image /etc/scripts/diag-bundle.sh
                                          (odi-oss; it collects and redacts) and
                                          streams what it wrote, up to 2 MiB.
                                          500 with {"ok":false,"error","output"}
                                          when the script fails or passes 60 s;
                                          501 on an image without the script

## Firmware

    POST /api/upload                     raw tarball as the body (not multipart);
                                          1 byte to 6 MiB, and it must start like a
                                          tar archive (`ustar` at offset 257), else
                                          400 and nothing is kept
    POST /api/firmware   action=write&partition=N
    GET  /api/firmware                    partitions, versions, build manifest,
                                          `defaultauth`, `switches`, write progress;
                                          `env` (the sw_* of `nv getenv`),
                                          `fallback` (the sw_* of `nv fallback`, the
                                          other environment copy; empty on stock nv),
                                          `slots` ({"0":{"kernel":..., "built":<unix>}},
                                          from each kernel partition's uImage header;
                                          {} when it cannot be read);
                                          `exe`, the path this confd was started from
    POST /api/firmware   action=try|commit|reboot&partition=N

## Host port and safe mode (odi-oss)

    GET  /api/hostlink                    the state the image keeps, read with no fork:
                                          the host-port mode and trial
                                          (`/var/run/host-autoneg`), the safe-mode
                                          flag for this boot and the record of an
                                          unacknowledged one, the host link;
                                          `supported` is false on an image without it
    POST /api/hostlink  action=try&mode=on|off
                        action=confirm | revert | ack
                                          one of four fixed verbs: try, confirm and
                                          revert run `host-autoneg.sh`, ack runs
                                          `safe-mode.sh ack`; bounded at 20 s.
                                          `HOST_AUTONEG` is never written by
                                          `/api/config`: only `confirm` stores it

## Management address trial (odi-oss)

    GET  /api/netaddr                     the state the image keeps (`/var/run/mgmt-addr`,
                                          read with no fork: `phase`, `trial_deadline`,
                                          `prev_ip`, `old_<KEY>`/`new_<KEY>` for the five
                                          keys, the last `event`), `uptime`, and where this
                                          request came from: `via`, the address it was sent
                                          to, and `peer`, the client. `supported` is false
                                          on an image without `mgmt-addr.sh` and in a
                                          safe-mode boot, where the keys are stored directly
    POST /api/netaddr   action=try&LAN_IP_ADDR=...&LAN_SUBNET=...
                        action=confirm | revert
                                          one of three fixed verbs, run as `mgmt-addr.sh`
                                          and bounded at 30 s. `try` takes the keys it
                                          changes (`LAN_IP_ADDR`, `LAN_SUBNET`,
                                          `LAN_ENABLE_IP2`, `LAN_IP_ADDR2`, `LAN_SUBNET2`),
                                          each checked like a write to `/api/config` (type,
                                          the pair rules, the second address not equal to the
                                          first) and then by `network.sh` itself, and answers
                                          before the address moves; the stick applies it a
                                          second later, keeps the old primary up beside it
                                          and reverts after 90 s unless confirmed.
                                          `confirm` passes the script the address and the
                                          client of THIS connection, taken from the socket:
                                          it is refused unless the request arrived on a new
                                          address, which is the proof it works, and only then
                                          are the keys stored. While the script exists
                                          `/api/config` refuses these five keys (outside a
                                          safe-mode boot), so a trial value is never in the
                                          store before it was confirmed

There is no route for the redirect. The page on the old address looks for the
new one with a `no-cors` `fetch` of `/` (`credentials: omit`, a throwaway query),
which resolves for any HTTP answer and rejects when nothing answers, so it needs
no CORS grant and sends no credential. The stick answers that fetch with `403`
and the text `cross-site request refused` before it looks at any credential (and
so without the one-second delay a failed sign-in costs); nothing else leaves the
stick. Then it navigates to the new address, a top-level navigation, which is
allowed and answers `401` with the Basic challenge: the browser asks for the
password there, because it keeps a credential per address. There is no token or
cookie to hand over (DESIGN.md, "Moving the management address").

## Backup and reset

    GET  /api/backup                      both config stores as a file, identity included
    POST /api/reset      _confirm=reset   `flash default cs` (service store only;
                                          `hs`, the hardware identity, is not reachable here)

Restoring a backup has no dedicated endpoint: the browser replays it through
`/api/config`, key by key — see DESIGN.md. The management address keys of a
backup go through `/api/netaddr` instead when the image has the trial.

## Admin

    GET  /api/logout                     always 401 with a fresh Basic challenge and
                                          a "Signed out" page, so the browser drops the
                                          cached credential (any method)
    POST /api/password   user=...&password=...
                                          user 1-64 printable characters, no space or
                                          colon; password 4-128 printable ASCII
    GET  /api/sshkeys                     {"path":..., "keys":[{"i":0,"line":"ssh-ed25519 AAAA... comment"}]}
    POST /api/sshkeys    key=<line>       append; the type is one of ssh-ed25519,
                                          ssh-rsa, ecdsa-sha2-nistp256/384/521 or an
                                          sk- type, the blob is whole base64 that
                                          parses to that same type, one printable
                                          line of at most 1000 characters; a key
                                          already in the file is refused
    POST /api/sshkeys    delete=<i>       rewrite the file without line i
