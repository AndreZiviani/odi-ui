/*
 * The status scrape: one diag invocation, handed to the browser raw.
 *
 * Parsing stays on the browser side deliberately -- diag echoes each command
 * after its "RTK.0> " prompt, so the reply splits back into sections there, and
 * adding a status field costs no C at all.
 */

#ifndef CONFD_STATUS_H
#define CONFD_STATUS_H

void emit_status_json(int fd);
void emit_l2_json(int fd);
void emit_log_json(int fd);
void emit_diag_bundle(int fd);

#endif /* CONFD_STATUS_H */
