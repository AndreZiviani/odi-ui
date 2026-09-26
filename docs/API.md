# API reference

Quick reference for `confd`'s HTTP API. Every write route also validates and
authenticates as described in [`DESIGN.md`](DESIGN.md#authentication) — this
page is the wire contract, not the rationale. See `DESIGN.md` for why each
route behaves the way it does.

All writes require the same HTTP Basic credential as the page, refuse a
cross-site `Origin`, and (for `/api/config`) read every value back before
reporting success.

## Config and values

    GET  /api/settings                  settings.tsv as JSON, [] when absent
    GET  /api/values                     current values, as the daemon's own parser sees them
    POST /api/config   key=value&key2=value2
                                          per-key result, apply class, and whether
                                          that class is a traced fact or an assumption;
                                          identity keys need `_confirm=identity`
    POST /api/apply     what=network|omci
                                          apply.sh on odi-oss; without it, `omci`
                                          restarts omci_app
    POST /api/switch    name=...&on=0|1  create or remove one allowlisted switch file
                                          (currently just `omci-identity.on`)

Refused regardless of schema: `LAN_SDS_MODE`, `LAN_SPEED_MODE`, `FIBER_MODE`.

## MIB and services

    GET  /api/omci      cmd=...          `omcicli mib get` passthrough; refuses
                                          `get tables` outright (see DESIGN.md)

## Status and diagnostics

    GET  /api/log                        kernel ring buffer, via klogctl
    POST /api/ping       host=<IPv4>      literals only, no DNS
    GET  /api/l2                         `diag l2-table get entry address valid`
                                          (stock and odi-oss, different column sets)

## Firmware

    POST /api/upload                     raw tarball as the body (not multipart)
    POST /api/firmware   action=write&partition=N
    GET  /api/firmware                    partitions, versions, build manifest,
                                          `defaultauth`, `switches`, write progress

## Backup and reset

    GET  /api/backup                      both config stores as a file, identity included
    POST /api/reset      _confirm=reset   `flash default cs` (service store only;
                                          `hs`, the hardware identity, is not reachable here)

Restoring a backup has no dedicated endpoint: the browser replays it through
`/api/config`, key by key — see DESIGN.md.

## Admin

    POST /api/password   user=...&password=...
    GET  /api/sshkeys                     {"path":..., "keys":[{"i":0,"line":"ssh-ed25519 AAAA... comment"}]}
    POST /api/sshkeys    key=<line>       append; shape-checked (type word, base64
                                          blob, one printable line)
    POST /api/sshkeys    delete=<i>       rewrite the file without line i
