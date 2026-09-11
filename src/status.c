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
	/*
	 * ARGUMENTS, not stdin -- and this is not a style choice.
	 *
	 * Fed `l2-table get entry address valid` on stdin, diag never returns:
	 * measured on a stick at 100% CPU in state R until killed, taking this
	 * single-threaded daemon down with it because every other request then
	 * queues behind a child that will not exit. The identical command as
	 * argv returns immediately.
	 *
	 * emit_status_json above still batches on stdin and is right to: its
	 * `pon get` / `gpon get` / `mib dump` commands all terminate that way,
	 * and one invocation for seven questions is worth ~200 ms. The lesson
	 * is per command, not general -- so a new diag command goes through
	 * argv until it has been shown to terminate on stdin.
	 */
	static char *const argv[] = { "diag", "l2-table", "get", "entry",
				      "address", "valid", 0 };
	long got, code = -1;

	got = run_to_buf_ex(DIAG_PATH, argv, omci, sizeof(omci), &code);
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

/*
 * The kernel ring buffer.
 *
 * This device keeps no other log: there is no syslogd in the image and no
 * dmesg applet in its busybox, so the only record of what the switch and the
 * OMCI stack complained about is in here until it scrolls away. It is where
 * `create ani vlan for mbcast fail` and `RT_ERR_RG_VLAN_USED_BY_SYSTEM` show
 * up -- the symptoms of an OMCI_OLT_MODE nobody should be using -- and nothing
 * in this UI looked at it before.
 *
 * klogctl rather than /proc/kmsg: reading that file consumes the buffer and
 * then blocks waiting for more, so a page refresh would both eat the history
 * and hang the server, which is single-threaded.
 */
void emit_log_json(int fd)
{
	long got = read_klog(omci, sizeof(omci));

	if (got < 0) {
		put_fd(fd, "{\"error\":\"the kernel would not hand over its log buffer\"}");
		return;
	}
	put_fd(fd, "{\"raw\":\"");
	put_json_cstr(fd, omci);
	put_fd(fd, "\",\"truncated\":");
	/* The ring buffer is usually smaller than this, but say so when it is
	 * not: the OLDEST lines are what klogctl drops, so a silently short
	 * answer looks like a device that has been quiet. */
	put_fd(fd, ((unsigned long)got + 1 >= sizeof(omci)) ? "true" : "false");
	put_fd(fd, "}");
}
