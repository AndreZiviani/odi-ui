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
/* One U-Boot variable, by name. Returns 0 if it is not set. */
int nv_get(const char *key, char *out, unsigned long cap);

#endif /* CONFD_FIRMWARE_H */
