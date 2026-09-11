/*
 * The OMCI MIB read path: what the OLT has actually provisioned on this ONU.
 *
 * Everything here is read-only. `omcicli mib set` exists and is not reachable
 * from this daemon: the MIB is the OLT's copy of the service, it is rebuilt at
 * every re-registration, and a write that survives one reboot and not the next
 * is a worse answer than no write at all. Changing service configuration is the
 * config page's job, through keys that persist.
 */

#ifndef CONFD_OMCI_H
#define CONFD_OMCI_H

/* GET /api/omci?cmd=... — see routes.c for the allowlisted verbs. */
void emit_omci_json(int fd, const char *query);

#endif /* CONFD_OMCI_H */
