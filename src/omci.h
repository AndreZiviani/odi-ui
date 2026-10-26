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

/* GET /api/voip: `omcicli voip`, masked. Never passes --secrets. */
void emit_voip_json(int fd);

/* POST /api/voip/secrets: the --secrets view, for a caller that repeats the
 * admin password in `body`. Wipes `body` and its own buffers before returning. */
void emit_voip_secrets_json(int fd, char *body);

/* POST /api/voip/status: the router reports its SIP registration state for one
 * phone port (`port=1&state=registered`); GET /api/voip/status says what is held
 * and how old it is. Neither takes or keeps a SIP value. */
void emit_voip_status_post(int fd, char *body);
void emit_voip_status_get(int fd);

#endif /* CONFD_OMCI_H */
