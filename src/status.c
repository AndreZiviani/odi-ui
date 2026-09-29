/*
 * The status scrape.
 */

#include "confd.h"
#include "buffers.h"
#include "status.h"

/*
 * Device status, in one diag invocation. diag costs ~32 ms to start and almost
 * nothing to run, so every question goes in on stdin at once; see
 * odi-sfp-exporter's notes on the same trick.
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

	if (run_script_to_buf(DIAG_PATH, argv, script, status, sizeof(status),
			      DIAG_TIMEOUT_MS) <= 0) {
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
	 *
	 * The odi-oss diag answers the same argv with its own listing (its
	 * stock-spelling alias of `l2-table get all`), so one confd serves both
	 * slots with this one command.
	 */
	static char *const argv[] = { "diag", "l2-table", "get", "entry",
				      "address", "valid", 0 };
	long got, code = -1;

	got = run_to_buf_ex(DIAG_PATH, argv, omci, sizeof(omci), &code, DIAG_TIMEOUT_MS);
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

/*
 * GET /api/diag: the diagnostics bundle, as a download.
 *
 * The image script does all the collecting and all the redacting, and
 * writes DIAG_BUNDLE_OUT; this runs it, bounded, and streams the file. A
 * failure is an HTTP error with the script own message, never a 200 with a
 * partial archive: a browser saves whatever a 200 carries. Without the
 * script (a stock slot, an older odi-oss) the route answers 501.
 *
 * Streamed in filebuf-sized chunks, capped at DIAG_BUNDLE_MAX, and the
 * file is removed afterwards so the next request cannot be handed a stale
 * one. The socket has SO_SNDTIMEO (main.c), so a client that stops reading
 * cannot hold the daemon either.
 */
void emit_diag_bundle(int fd)
{
	static char *const argv[] = { "diag-bundle.sh", DIAG_BUNDLE_OUT, 0 };
	long got, code = -1, in;
	unsigned long sent = 0;

	if (!file_exists(DIAG_BUNDLE_SCRIPT)) {
		respond(fd, "501 Not Implemented", "application/json", 0);
		put_fd(fd, "{\"ok\":false,\"error\":\"this image has no " DIAG_BUNDLE_SCRIPT "\"}");
		return;
	}

	got = run_to_buf_ex(DIAG_BUNDLE_SCRIPT, argv, status, sizeof(status), &code,
			    DIAG_BUNDLE_TIMEOUT_MS);
	if (got == -2 || code != 0) {
		syscall3(__NR_unlink, (long)DIAG_BUNDLE_OUT, 0, 0);
		respond(fd, "500 Internal Server Error", "application/json", 0);
		put_fd(fd, "{\"ok\":false,\"error\":\"");
		put_fd(fd, got == -2 ? "diag-bundle.sh did not finish in time"
				     : "diag-bundle.sh failed");
		put_fd(fd, "\",\"output\":\"");
		if (got > 0)
			put_json_cstr(fd, status);
		put_fd(fd, "\"}");
		return;
	}

	in = syscall3(__NR_open, (long)DIAG_BUNDLE_OUT, O_RDONLY, 0);
	if (in < 0) {
		respond(fd, "500 Internal Server Error", "application/json", 0);
		put_fd(fd, "{\"ok\":false,\"error\":\"diag-bundle.sh wrote no " DIAG_BUNDLE_OUT "\"}");
		return;
	}

	respond(fd, "200 OK", "application/gzip",
		"Content-Disposition: attachment; filename=\"odi-diag.tar.gz\"\r\n");
	while (sent < DIAG_BUNDLE_MAX) {
		unsigned long want = sizeof(filebuf);
		long n;

		if (want > DIAG_BUNDLE_MAX - sent)
			want = DIAG_BUNDLE_MAX - sent;
		n = syscall3(__NR_read, in, (long)filebuf, (long)want);
		if (n <= 0)
			break;
		if (write_all(fd, filebuf, (unsigned long)n) != n)
			break;		/* the client went away, or stopped reading */
		sent += (unsigned long)n;
	}
	syscall3(__NR_close, in, 0, 0);
	syscall3(__NR_unlink, (long)DIAG_BUNDLE_OUT, 0, 0);
}
