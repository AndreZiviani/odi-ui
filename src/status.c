/*
 * The status scrape.
 */

#include "confd.h"
#include "buffers.h"
#include "status.h"

/*
 * Device status, in one diag invocation. diag costs ~32 ms to start and almost
 * nothing to run, so every question goes in on stdin at once; see
 * sfp-exporter's notes on the same trick.
 */
void emit_status_json(int fd)
{
	static char *const argv[] = { "diag", 0 };
	static const char script[] =
		"pon get transceiver rx-power\n"
		"pon get transceiver tx-power\n"
		"pon get transceiver temperature\n"
		"pon get transceiver voltage\n"
		"gpon get onu-state\n"
		"gpon get alarm-status\n"
		"mib dump counter port all\n"
		"exit\n";

	if (run_script_to_buf(DIAG_PATH, argv, script, status, sizeof(status)) <= 0) {
		put_fd(fd, "{\"error\":\"diag failed\"}");
		return;
	}
	/* Raw for now: the browser splits on the RTK.0> prompt. Keeping the
	 * parsing on that side means adding a status field costs no C. */
	put_fd(fd, "{\"raw\":\"");
	put_json_cstr(fd, status);
	put_fd(fd, "\"}");
}

/*
 * The switch's learned MAC addresses.
 *
 * Its own route rather than another line in the status scrape, for one reason:
 * size. The status buffer is 16 KB and the counter dump alone is 5.9 KB, while
 * this table grows with every host that has talked through the stick -- a few
 * hundred entries would push the optics and the ONU state out of the response
 * and break the page that is always on screen to improve one that is not.
 *
 * What it answers is the other half of the Forwarding section. Those counters
 * say whether frames cross; this says which side each MAC was learned on, which
 * is what tells you a host is reachable through the fibre rather than only
 * talking to the stick.
 */
void emit_l2_json(int fd)
{
	static char *const argv[] = { "diag", 0 };
	static const char script[] =
		"l2-table get entry address valid\n"
		"exit\n";
	long got;

	got = run_script_to_buf(DIAG_PATH, argv, script, omci, sizeof(omci));
	if (got <= 0) {
		put_fd(fd, "{\"error\":\"diag failed\"}");
		return;
	}
	put_fd(fd, "{\"raw\":\"");
	put_json_cstr(fd, omci);
	put_fd(fd, "\",\"truncated\":");
	put_fd(fd, ((unsigned long)got + 1 >= sizeof(omci)) ? "true" : "false");
	put_fd(fd, "}");
}
