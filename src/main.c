/*
 * Process entry: bind, then serve one connection at a time, forever.
 *
 * Single-threaded and serial is a deliberate choice and it cuts both ways. It
 * makes the failed-auth delay a hard GLOBAL rate limit rather than a per
 * connection one -- an attacker cannot open more sockets to go faster -- and it
 * means one peer that connects and never sends would block everything, which is
 * what the receive timeout here is for.
 */

#include "confd.h"
#include "routes.h"
#include "firmware.h"

static unsigned long parse_u16(const char *s, unsigned long fallback)
{
	unsigned long v = 0, i;

	if (!s || !s[0])
		return fallback;
	for (i = 0; s[i]; i++) {
		if (s[i] < '0' || s[i] > '9')
			return fallback;
		v = v * 10 + (unsigned long)(s[i] - '0');
		if (v > 65535)
			return fallback;
	}
	return v ? v : fallback;
}

int main(int argc, char **argv)
{
	unsigned long port = parse_u16(argc > 1 ? argv[1] : 0, DEFAULT_PORT);
	long one = 1;

	if (argc > 0 && argv[0])
		confd_exe = argv[0];

	/*
	 * Ignore SIGPIPE, or the first client to hang up mid-response kills the
	 * server. Writing to a socket whose peer has closed raises it, and the
	 * default action is to terminate — with no libc there is nothing
	 * installing a handler on our behalf.
	 *
	 * This is not theoretical and it is not rare: curl reads a response to
	 * the end, but a browser cancels requests, reloads mid-load and closes
	 * tabs constantly. Reproduced by asking for the 25 KB schema and closing
	 * the socket immediately — the daemon was gone before the next request.
	 * write_all already stops on a short write, so the EPIPE return is
	 * handled; it was only the signal that was fatal.
	 */
	sig_ignore(SIGPIPE);
	long fd, conn;
	unsigned char addr[16];
	unsigned long i;

	for (i = 0; i < sizeof(addr); i++)
		addr[i] = 0;
	/* sin_family is host order, sin_port network order — the same thing on
	 * this big-endian CPU, so there is no htons anywhere in this file. */
	addr[1] = AF_INET;
	addr[2] = (unsigned char)((port >> 8) & 0xff);
	addr[3] = (unsigned char)(port & 0xff);

	fd = syscall3(__NR_socket, AF_INET, SOCK_STREAM, 0);
	if (fd < 0) {
		put("socket() failed\n");
		return 1;
	}
	__syscall6(__NR_setsockopt, fd, SOL_SOCKET, SO_REUSEADDR,
		   (long)&one, sizeof(one), 0);
	if (syscall3(__NR_bind, fd, (long)addr, sizeof(addr)) < 0) {
		put("bind() failed -- port already in use?\n");
		return 1;
	}
	if (syscall3(__NR_listen, fd, BACKLOG, 0) < 0) {
		put("listen() failed\n");
		return 1;
	}

	for (;;) {
		/* struct timeval: seconds, microseconds — two longs here. */
		long tv[2];

		conn = syscall3(__NR_accept, fd, 0, 0);
		if (conn < 0) {
			/*
			 * Back off instead of retrying flat out. A transient
			 * EINTR costs a second; a sticky one -- EMFILE from a
			 * descriptor leak, or ENOBUFS under memory pressure --
			 * would otherwise spin this loop at full speed on a
			 * ~300 BogoMIPS core, starving omci_app and the
			 * exporter. Nothing logs it and nothing exits, so the
			 * only symptom would be a stick that goes slow and
			 * stays slow.
			 */
			sleep_s(1);
			continue;
		}

		/*
		 * Bound how long one client can hold the server.
		 *
		 * This is single-threaded and serial, which the auth path uses
		 * deliberately as a global rate limit -- but it also means a
		 * peer that connects and never sends blocks every other request
		 * for as long as it likes. A port scanner holding a socket
		 * open, or a client whose network drops between connect and
		 * send, took the config UI down with no error and no log.
		 *
		 * The send timeout matters for the same reason in the other
		 * direction: a client that stops reading mid-response would
		 * otherwise block the write.
		 */
		tv[0] = 15;
		tv[1] = 0;
		__syscall6(__NR_setsockopt, conn, SOL_SOCKET, SO_RCVTIMEO,
			   (long)tv, sizeof(tv), 0);
		__syscall6(__NR_setsockopt, conn, SOL_SOCKET, SO_SNDTIMEO,
			   (long)tv, sizeof(tv), 0);

		serve((int)conn);
		syscall3(__NR_close, conn, 0, 0);
	}
}
