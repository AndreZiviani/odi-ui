/*
 * Boot selection and the firmware view.
 *
 * U-Boot keeps a one-shot trial slot, and using it is the difference between an
 * experiment and a site visit: sw_tryactive boots a partition ONCE with the
 * watchdog armed, and an image that does not come up is reverted unattended.
 * Writing sw_commit straight away makes an unproven image permanent instead.
 */

#ifndef CONFD_FIRMWARE_H
#define CONFD_FIRMWARE_H

void emit_firmware_json(int fd);
int nv_set(const char *key, const char *value);
/*
 * Commit the running slot the one safe way: `nv commit <slot>` (odi-oss nv),
 * which refuses a slot that is not the running one and writes BOTH copies of
 * the environment, read back. A plain `nv setenv sw_commit` writes one copy,
 * which leaves the other naming the previous slot.
 *
 * Returns 1 when committed, 0 when nv refused or failed (msg holds what it
 * said), and -1 when this nv has no commit verb (the stock one): the caller
 * decides what that means. msg is always a NUL-terminated string.
 */
int nv_commit(const char *slot, char *msg, unsigned long cap);
/* Rewrite /var/run/odi-slot from the environment. 1 when it ran and exited 0. */
int slot_state_refresh(void);
/* One U-Boot variable, by name. Returns 0 if it is not set. */
int nv_get(const char *key, char *out, unsigned long cap);
/* argv[0] of this process, set by main(): the path the launcher ran. An
 * override deployed by scripts/deploy.sh runs from /etc/config/confd/, the
 * image copy from /bin/confd. Reported so the page can tell the two apart by
 * where the binary came from, not by comparing build ids -- a local build
 * stamps the manifest `confd=local`, which matches no id at all. */
extern const char *confd_exe;

#endif /* CONFD_FIRMWARE_H */
