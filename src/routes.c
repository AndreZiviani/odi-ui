/*
 * Request dispatch, and the one route long enough to live beside it.
 */

#include "confd.h"
#include "buffers.h"
#include "http.h"
#include "mib.h"
#include "firmware.h"
#include "status.h"
#include "omci.h"
#include "routes.h"

/*
 * POST /api/config — write keys, one report line each.
 *
 * Nothing is applied implicitly. The response says which apply class the
 * changes need and the caller decides, because on this device a config write
 * does nothing until omci_app is restarted or the stick reboots, and pretending
 * otherwise is how you end up reading a stale command line and drawing the
 * wrong conclusion.
 */
static void handle_write(int conn, const char *body)
{
	char name[128], value[512], got[512], addr[160];
	char type[32], writable[32], apply[32];
	unsigned long i = 0;
	int first = 1, confirm = 0;
	int any_omci = 0, any_reboot = 0, any_untraced = 0;
	int need_net = 0, any_stock = 0, need_syslog = 0, need_ntp = 0;

	if (read_file(SCHEMA_PATH_OVR, schema, sizeof(schema)) <= 0 &&
	    read_file(SCHEMA_PATH, schema, sizeof(schema)) <= 0) {
		respond(conn, "500 Internal Server Error", "application/json", 0);
		put_fd(conn, "{\"error\":\"no schema\"}");
		return;
	}

	/* meta.tsv carries the ranges and option lists; consumers.tsv carries
	 * the apply class derived from which binaries read the key. Both are
	 * optional -- a device without them validates by type alone and reports
	 * every write as untraced, which is the honest degraded answer. */
	if (read_file(META_PATH_OVR, meta, sizeof(meta)) <= 0 &&
	    read_file(META_PATH, meta, sizeof(meta)) <= 0)
		meta[0] = 0;
	if (read_file(CONS_PATH_OVR, cons, sizeof(cons)) <= 0 &&
	    read_file(CONS_PATH, cons, sizeof(cons)) <= 0)
		cons[0] = 0;
	/* settings.tsv, when the image has one, is the authority on what a
	 * write costs HERE: consumers.tsv was derived from the stock firmware,
	 * whose readers this image does not run. */
	if (read_file(SETT_PATH_OVR, sett, sizeof(sett)) <= 0 &&
	    read_file(SETT_PATH, sett, sizeof(sett)) <= 0)
		sett[0] = 0;

	/* Identity keys need saying so explicitly. Losing GPON_SN or MAC_KEY
	 * means the OLT stops authenticating the ONU, which is not something to
	 * do by mis-clicking. */
	{
		char c[16];
		unsigned long j = 0;

		while (body[j]) {
			unsigned long k = url_decode(body, j, '=', name, sizeof(name));

			if (!k)
				break;
			j = k;
			if (body[j] == '=')
				j++;
			j = url_decode(body, j, 0, c, sizeof(c));
			if (!j)
				break;
			if (seq(name, "_confirm") && seq(c, "identity"))
				confirm = 1;
			if (body[j] == '&')
				j++;
		}
	}

	respond(conn, "200 OK", "application/json", 0);
	put_fd(conn, "{\"results\":[");

	while (body[i]) {
		unsigned long k = url_decode(body, i, '=', name, sizeof(name));
		const char *err = 0;

		if (!k)
			break;
		i = k;
		if (body[i] == '=')
			i++;
		i = url_decode(body, i, 0, value, sizeof(value));
		if (!i)
			break;

		if (seq(name, "_confirm"))
			goto next;

		if (refused_key(name))
			err = "refused: a wrong SerDes mode costs every management path";
		else if (!schema_lookup(schema, name, addr, sizeof(addr),
					type, sizeof(type),
					writable, sizeof(writable), apply, sizeof(apply)))
			err = "not in the schema";
		/* An allowlist, not a denylist. "never" was the only value
		 * refused, so an empty or misspelt column -- from a short row,
		 * or a hand edit of the device's own keys.tsv -- read as
		 * writable. Only the two values that mean writable are. */
		else if (!seq(writable, "yes") && !seq(writable, "identity"))
			err = "not writable";
		else if (seq(writable, "identity") && !confirm)
			err = "identity key: resend with _confirm=identity";
		/* Only the odi-only hostport keys (SYSLOG_SERVER, NTP_SERVER)
		 * can be cleared: odi-oss flash keeps them in a plain file and
		 * an empty value removes the key. Stock keys live in the vendor
		 * XML, where an empty value is not a clear. */
		else if (!value[0] && !seq(type, "hostport"))
			err = "cannot be cleared: flash set refuses an empty value";
		else if (!type_ok(type, value))
			err = "not valid for its type";
		else
			meta_ok(name, value, &err);   /* sets err, or clears it */

		if (!first)
			put_fd(conn, ",");
		first = 0;
		put_fd(conn, "{\"name\":\"");
		put_json_cstr(conn, name);
		put_fd(conn, "\",");

		if (err) {
			put_fd(conn, "\"ok\":false,\"error\":\"");
			put_json_cstr(conn, err);
			put_fd(conn, "\"}");
			goto next;
		}

		if (write_key(addr, value, got, sizeof(got))) {
			put_fd(conn, "\"ok\":true,\"value\":\"");
			put_json_cstr(conn, got);
			put_fd(conn, "\"}");
			/*
			 * consumers.tsv is authoritative where it has a row --
			 * it is derived from which binaries actually read the
			 * key -- and the schema's own column is the fallback.
			 * The comment here used to say exactly that while the
			 * code read neither: it lumped everything that was not
			 * literally restart:omci into "reboot", so a key marked
			 * immediate still told the user to reboot, and the page
			 * could show "no reboot" in the table and demand one on
			 * save.
			 */
			{
				char derived[32];
				const char *a = apply;

				if (sett[0]) {
					/* Column 2 is the action. A key the
					 * table does not name is read by
					 * nothing on this image: it changes
					 * the stock slot, and costs nothing
					 * here. */
					if (!tsv_field(sett, name, 2, derived, sizeof(derived)))
						any_stock = 1;
					else if (seq(derived, "network"))
						need_net = 1;
					else if (seq(derived, "syslog"))
						need_syslog = 1;
					else if (seq(derived, "ntp"))
						need_ntp = 1;
					else if (seq(derived, "omci"))
						any_omci = 1;
					else if (seq(derived, "reboot"))
						any_reboot = 1;
				} else {
					if (tsv_field(cons, name, 1, derived, sizeof(derived)) &&
					    derived[0] && !seq(derived, "unknown"))
						a = derived;

					if (seq(a, "restart:omci"))
						any_omci = 1;
					else if (seq(a, "reboot"))
						any_reboot = 1;
					else if (seq(a, "immediate"))
						;              /* already in effect */
					else
						any_untraced = 1;
				}
			}
		} else {
			/* The write reported success and the value did not
			 * change. This is why every write is read back. */
			put_fd(conn, "\"ok\":false,\"error\":\"did not stick, device holds '");
			put_json_cstr(conn, got);
			put_fd(conn, "'\"}");
		}
next:
		if (body[i] == '&')
			i++;
	}

	/*
	 * The strongest class in the batch wins, and "untraced" is reported
	 * separately from "reboot". They need different words: one is "this key
	 * is known to need a reboot", the other is "nothing in the image was
	 * seen reading this key, so assume the worst" -- and 159 of the 184 keys
	 * are in the second group.
	 */
	put_fd(conn, "],\"apply\":\"");
	if (any_reboot || any_untraced)
		put_fd(conn, "reboot");
	else if (any_omci)
		put_fd(conn, "restart:omci");
	else
		put_fd(conn, "none");
	put_fd(conn, "\",\"untraced\":");
	put_fd(conn, (any_untraced && !any_reboot) ? "true" : "false");
	/*
	 * What applying the batch takes, one entry per action, for an image
	 * with a settings table: "network" (live, apply.sh network), "omci"
	 * (interrupts internet, apply.sh omci), "reboot". `stock` says some of
	 * the keys are read by nothing here. The page runs or offers each; this
	 * route applies nothing itself.
	 */
	put_fd(conn, ",\"needs\":[");
	{
		int first_need = 1;

		if (need_net) {
			put_fd(conn, "\"network\"");
			first_need = 0;
		}
		if (need_syslog) {
			put_fd(conn, first_need ? "\"syslog\"" : ",\"syslog\"");
			first_need = 0;
		}
		if (need_ntp) {
			put_fd(conn, first_need ? "\"ntp\"" : ",\"ntp\"");
			first_need = 0;
		}
		if (any_omci && sett[0]) {
			put_fd(conn, first_need ? "\"omci\"" : ",\"omci\"");
			first_need = 0;
		}
		if (any_reboot && sett[0])
			put_fd(conn, first_need ? "\"reboot\"" : ",\"reboot\"");
	}
	put_fd(conn, "],\"stock\":");
	put_fd(conn, any_stock ? "true" : "false");
	put_fd(conn, "}");
}

void serve(int conn)
{
	char *path, *method, *body, *query;
	unsigned long body_have = 0, body_want = 0;
	long n;

	n = read_request(conn, req, sizeof(req), &body_have, &body_want);
	if (n == REQ_TOO_LARGE) {
		respond(conn, "413 Payload Too Large", "text/plain", 0);
		put_fd(conn, "request too large\n");
		return;
	}
	if (n <= 0)
		return;

	/* Authenticate BEFORE parsing, not after: request_path() NUL-terminates
	 * the method and the path in place, and the first of those NULs stops
	 * any later scan for a header dead. That cost an hour of a correct
	 * password being rejected. */
	if (!authorised(req)) {
		/*
		 * Sleep before answering a failed attempt. HTTP Basic has no
		 * session and no lockout, so without this the only limit on
		 * guessing is how fast the device can answer — measured at 319
		 * attempts/sec, which is plenty to walk a human-chosen password.
		 *
		 * This server is single-threaded and serial, which turns a
		 * modest delay into a hard global rate limit: the sleep blocks
		 * every other request too, so an attacker cannot open more
		 * connections to go faster. It costs a legitimate typo one
		 * second.
		 */
		sleep_s(1);
		respond(conn, "401 Unauthorized", "text/plain",
			"WWW-Authenticate: Basic realm=\"odi-ui\"\r\n");
		put_fd(conn, "authentication required\n");
		return;
	}

	/* Grab the body BEFORE parsing the request line: request_path()
	 * NUL-terminates the method in place and the first of those NULs would
	 * stop the scan for the header/body boundary dead. Same for the CSRF
	 * check, which reads the Origin and Host headers. */
	body = request_body(req);
	{
		int cross = !same_origin(req);

		path = request_path(req, &method);
		if (!path) {
			respond(conn, "400 Bad Request", "text/plain", 0);
			return;
		}
		/*
		 * Split the query off the path, once, here. Every route below
		 * compares the path with seq(), so before this a single `?`
		 * would have made `/api/status?x=1` a 404 -- and the read
		 * routes that take arguments need the query anyway. It is
		 * urlencoded exactly like a form body, so form_get reads it.
		 */
		query = "";
		{
			unsigned long q = 0;

			while (path[q] && path[q] != '?')
				q++;
			if (path[q] == '?') {
				path[q] = 0;
				query = path + q + 1;
			}
		}
		if (cross && !seq(method, "GET")) {
			respond(conn, "403 Forbidden", "text/plain", 0);
			put_fd(conn, "cross-site request refused\n");
			return;
		}
	}

	/*
	 * The firmware upload, and the only route that reads past the request
	 * buffer.
	 *
	 * It is placed here on purpose: after authentication and after the
	 * cross-site check, so nothing unauthenticated can make this device
	 * write 3 MB into the ramfs every other process shares. The body is
	 * streamed straight to a file in 64 KB pieces and is never held whole
	 * in memory -- which is what the Firmware tab used to say could not be
	 * done, and the reason it handed out an scp command instead.
	 *
	 * Raw bytes, not multipart. `fetch(url, {body: file})` sends the file
	 * as the body with no boundary to find, so there is no parser here to
	 * get wrong.
	 */
	if (seq(path, "/api/upload") && seq(method, "POST")) {
		long fd, wrote = 0;
		unsigned long left;

		if (!body_want || body_want > UPLOAD_MAX) {
			respond(conn, "413 Payload Too Large", "application/json", 0);
			put_fd(conn, "{\"ok\":false,\"error\":\"an image is a few MB; this was not\"}");
			return;
		}

		fd = syscall3(__NR_open, (long)UPLOAD_PATH,
			      O_WRONLY | O_CREAT | O_TRUNC, 0600);
		if (fd < 0) {
			respond(conn, "500 Internal Server Error", "application/json", 0);
			put_fd(conn, "{\"ok\":false,\"error\":\"could not open " UPLOAD_PATH "\"}");
			return;
		}

		/* What already arrived with the headers, then the rest. */
		if (body_have && write_all((int)fd, body, body_have) < 0)
			wrote = -1;
		else
			wrote = (long)body_have;

		left = body_want - body_have;
		while (wrote >= 0 && left) {
			unsigned long chunk = left < sizeof(filebuf) ? left : sizeof(filebuf);
			long got = syscall3(__NR_read, conn, (long)filebuf, (long)chunk);

			/* A peer that stops sending is bounded by SO_RCVTIMEO,
			 * so this cannot hang the server indefinitely. */
			if (got <= 0) { wrote = -1; break; }
			if (write_all((int)fd, filebuf, (unsigned long)got) < 0) {
				/* /tmp is ramfs and shared. A short write here
				 * is the filesystem filling up, and leaving a
				 * half-image behind would fill it further. */
				wrote = -1;
				break;
			}
			wrote += got;
			left -= (unsigned long)got;
		}
		syscall3(__NR_close, fd, 0, 0);

		if (wrote < 0 || (unsigned long)wrote != body_want) {
			syscall3(__NR_unlink, (long)UPLOAD_PATH, 0, 0);
			respond(conn, "500 Internal Server Error", "application/json", 0);
			put_fd(conn, "{\"ok\":false,\"error\":\"the upload did not complete; "
				     "the partial file has been removed\"}");
			return;
		}

		respond(conn, "200 OK", "application/json", 0);
		put_fd(conn, "{\"ok\":true,\"bytes\":");
		put_u32_fd(conn, (unsigned long)wrote);
		/* The device's own md5, so it can be compared with the one
		 * beside the image you built. fwu.sh checks the kernel and
		 * rootfs md5s from inside the tar before it erases anything,
		 * so this is about the transfer, not the contents. */
		{
			static char *const argv[] = { "md5sum", UPLOAD_PATH, 0 };
			char out[128];
			unsigned long i = 0;

			put_fd(conn, ",\"md5\":\"");
			if (run_to_buf(MD5SUM_PATH, argv, out, sizeof(out),
				       MD5SUM_TIMEOUT_MS) > 0) {
				while (out[i] && out[i] != ' ' && out[i] != '\n')
					i++;
				put_json_str(conn, out, i);
			}
			put_fd(conn, "\"}");
		}
		return;
	}

	/*
	 * Every other route wants its body whole. Before the upload existed
	 * read_request refused an oversized one itself; now it reports one, and
	 * this is where that becomes the same 413 it always was.
	 */
	if (body_want && body_have < body_want) {
		respond(conn, "413 Payload Too Large", "text/plain", 0);
		put_fd(conn, "request too large\n");
		return;
	}

	/*
	 * Sign out, as far as HTTP Basic allows.
	 *
	 * There is no session to end -- the browser holds the credential and
	 * replays it -- so the honest implementation is to answer 401 and let
	 * the browser drop what it cached for this realm. It is not a guarantee
	 * (the credential is cleared at the browser's discretion), which is why
	 * the page says close the tab.
	 *
	 * The button shipped before this route did, and posting to a route that
	 * does not exist fell through to the 405 handler: the whole UI was
	 * replaced by a plain-text error page with no way back but retyping the
	 * URL.
	 */
	if (seq(path, "/api/logout")) {
		respond(conn, "401 Unauthorized", "text/html",
			"WWW-Authenticate: Basic realm=\"odi-ui\"\r\n");
		put_fd(conn,
		       "<!doctype html><meta charset=utf-8>"
		       "<title>Signed out</title>"
		       "<body style=\"font:14px system-ui;padding:2rem\">"
		       "<h1>Signed out</h1>"
		       "<p>Close this tab to be sure the credential is gone. "
		       "<a href=\"/\">Sign in again</a>.</body>");
		return;
	}

	/*
	 * Set the config UI's own credential, creating the file if it is not
	 * there.
	 *
	 * This is the way out of the built-in default, and it has to be here
	 * rather than only in a runbook: the state it fixes is the state of
	 * every factory-reset stick, and telling an operator to go and find an
	 * ssh client that still speaks to a 2007 dropbear is how the default
	 * stays in place forever.
	 *
	 * The current credential is what authorises it -- serve() has already
	 * checked it, and a cross-origin POST is already refused -- so there is
	 * no second password prompt here. That is the same standard as every
	 * other write on this daemon, including the ones that change what the
	 * OLT authenticates against.
	 */
	/*
	 * SSH public keys for the device login.
	 *
	 * dropbear reads authorized_keys from the directory its -D names, and
	 * the image starts it with -D /etc/config/dropbear.d, beside the host
	 * key: the jffs2 partition, so a key survives a reflash the way the
	 * host key does. One line per key, OpenSSH format, as ssh-keygen prints
	 * it. GET lists them; POST with key=<line> appends one, POST with
	 * delete=<index> removes one. The check on a new key is shape only --
	 * type word, base64 blob, optional comment, one line -- because the
	 * one failure that matters is a pasted line that is not a key at all,
	 * and dropbear itself decides whether the blob decodes.
	 */
	if (seq(path, "/api/sshkeys")) {
		static char keys[4096];
		long n = read_file(SSHKEYS_PATH, keys, sizeof(keys) - 1);
		unsigned long i, ls, idx;

		if (n < 0)
			n = 0;
		keys[n] = 0;
		if (seq(method, "POST")) {
			char key[1024], del[8];

			if (form_get(body, "delete", del, sizeof(del)) && del[0]) {
				unsigned long want = 0, at = 0, out = 0;
				int found = 0;

				for (i = 0; del[i]; i++) {
					if (del[i] < '0' || del[i] > '9')
						break;
					want = want * 10 + (unsigned long)(del[i] - '0');
				}
				/* Rewrite in place without the wanted line. */
				for (ls = 0; ls < (unsigned long)n; ) {
					unsigned long le = ls;

					while (keys[le] && keys[le] != '\n')
						le++;
					if (keys[le] == '\n')
						le++;
					if (at == want) {
						found = 1;
					} else {
						unsigned long k;

						for (k = ls; k < le; k++)
							keys[out++] = keys[k];
					}
					at++;
					ls = le;
				}
				if (!found) {
					respond(conn, "404 Not Found", "application/json", 0);
					put_fd(conn, "{\"ok\":false,\"error\":\"no such key\"}");
					return;
				}
				if (write_file(SSHKEYS_PATH, keys, out, 0600) < 0) {
					respond(conn, "500 Internal Server Error", "application/json", 0);
					put_fd(conn, "{\"ok\":false,\"error\":\"could not write authorized_keys\"}");
					return;
				}
				respond(conn, "200 OK", "application/json", 0);
				put_fd(conn, "{\"ok\":true}");
				return;
			}
			if (!form_get(body, "key", key, sizeof(key)) || !key[0]) {
				respond(conn, "400 Bad Request", "application/json", 0);
				put_fd(conn, "{\"ok\":false,\"error\":\"key is required\"}");
				return;
			}
			/* Shape: <type> <base64> [comment], one line, printable. */
			{
				unsigned long t = 0, b, e;
				int ok;

				while (key[t] && key[t] != ' ')
					t++;
				ok = t > 4 && key[t] == ' ' &&
				     ((key[0] == 's' && key[1] == 's' && key[2] == 'h' && key[3] == '-') ||
				      (key[0] == 'e' && key[1] == 'c' && key[2] == 'd' && key[3] == 's' && key[4] == 'a') ||
				      (key[0] == 's' && key[1] == 'k' && key[2] == '-'));
				b = t + 1;
				e = b;
				while (ok && key[e] && key[e] != ' ') {
					char c = key[e];

					if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
					      (c >= '0' && c <= '9') || c == '+' || c == '/' || c == '='))
						ok = 0;
					e++;
				}
				if (e - b < 16)
					ok = 0;
				for (i = 0; ok && key[i]; i++)
					if (key[i] < 32 || key[i] > 126)
						ok = 0;
				if (!ok) {
					respond(conn, "400 Bad Request", "application/json", 0);
					put_fd(conn, "{\"ok\":false,\"error\":\"not an OpenSSH public key line (type, base64, optional comment)\"}");
					return;
				}
			}
			if ((unsigned long)n + str_len(key) + 2 > sizeof(keys) - 1) {
				respond(conn, "400 Bad Request", "application/json", 0);
				put_fd(conn, "{\"ok\":false,\"error\":\"authorized_keys is full\"}");
				return;
			}
			if (n && keys[n - 1] != '\n')
				keys[n++] = '\n';
			for (i = 0; key[i]; i++)
				keys[n++] = key[i];
			keys[n++] = '\n';
			{
				static char *const mk[] = { "mkdir", "-p", SSHKEYS_DIR, 0 };
				char junk[64];

				run_to_buf("/bin/mkdir", mk, junk, sizeof(junk),
					  MKDIR_TIMEOUT_MS);
			}
			if (write_file(SSHKEYS_PATH, keys, (unsigned long)n, 0600) < 0) {
				respond(conn, "500 Internal Server Error", "application/json", 0);
				put_fd(conn, "{\"ok\":false,\"error\":\"could not write authorized_keys\"}");
				return;
			}
			respond(conn, "200 OK", "application/json", 0);
			put_fd(conn, "{\"ok\":true}");
			return;
		}
		/* GET: one object per line, blank and comment lines skipped but
		 * counted, so the index the page sends back to delete is the line
		 * number in the file. */
		respond(conn, "200 OK", "application/json", 0);
		put_fd(conn, "{\"path\":\"" SSHKEYS_PATH "\",\"keys\":[");
		idx = 0;
		{
			int first = 1;

			for (ls = 0; ls < (unsigned long)n; idx++) {
				unsigned long le = ls;
				char saved;

				while (keys[le] && keys[le] != '\n')
					le++;
				saved = keys[le];
				keys[le] = 0;
				if (keys[ls] && keys[ls] != '#') {
					if (!first)
						put_fd(conn, ",");
					first = 0;
					put_fd(conn, "{\"i\":");
					put_u32_fd(conn, idx);
					put_fd(conn, ",\"line\":\"");
					put_json_cstr(conn, keys + ls);
					put_fd(conn, "\"}");
				}
				keys[le] = saved;
				ls = saved ? le + 1 : le;
			}
		}
		put_fd(conn, "]}");
		return;
	}

	if (seq(path, "/api/password") && seq(method, "POST")) {
		char user[96], pass[160];
		const char *why = 0;

		if (!form_get(body, "user", user, sizeof(user)) ||
		    !form_get(body, "password", pass, sizeof(pass))) {
			respond(conn, "400 Bad Request", "application/json", 0);
			put_fd(conn, "{\"ok\":false,\"error\":\"user and password are required\"}");
			return;
		}
		if (!set_credential(user, pass, &why)) {
			respond(conn, "400 Bad Request", "application/json", 0);
			put_fd(conn, "{\"ok\":false,\"error\":\"");
			put_json_cstr(conn, why ? why : "refused");
			put_fd(conn, "\"}");
			return;
		}
		respond(conn, "200 OK", "application/json", 0);
		/* The browser is still holding the OLD credential and will
		 * replay it on the next request, which now answers 401. Saying
		 * so is the difference between "it worked" and "it broke". */
		put_fd(conn, "{\"ok\":true,\"note\":\"saved -- sign out and back in with the new credential\"}");
		return;
	}

	/*
	 * Reset the service configuration to the image defaults.
	 *
	 * NOT flash_eraseall /dev/mtd3, which is the recipe every thread gives
	 * and the reason Anime4000/RTL960x#84 has people with dead sticks. That
	 * erases the whole config partition: both stores, the identity in the
	 * hs store, this daemon's own credential file, and any override binary
	 * living beside it.
	 *
	 * `flash default cs` is per-store, and cs only. On the stock firmware it
	 * is the vendor's reset of the whole service store; on odi-oss it merges
	 * /etc/config_default.xml (ten keys: the LOIDs, DEVICE_TYPE,
	 * DUAL_MGMT_MODE, the OMCI_CUSTOM masks) and leaves every other key as
	 * it was, because the store is shared with the stock slot. Either way it
	 * rewrites /var/config/lastgood.xml rather than erasing the partition,
	 * so files there -- confd.auth, an overridden confd or metricsd -- and
	 * the values that cannot be regenerated survive it.
	 *
	 * hs is deliberately not reachable. The reset people want is the
	 * service one; the one that ends sticks is the other.
	 */
	if (seq(path, "/api/reset") && seq(method, "POST")) {
		static char *const argv[] = { "flash", "default", "cs", 0 };
		char confirm[16];
		long got, code = -1;

		if (!form_get(body, "_confirm", confirm, sizeof(confirm)) ||
		    !seq(confirm, "reset")) {
			respond(conn, "400 Bad Request", "application/json", 0);
			put_fd(conn, "{\"ok\":false,\"error\":\"resend with _confirm=reset\"}");
			return;
		}

		got = run_to_buf_ex(FLASH_PATH, argv, status, sizeof(status), &code,
				   FLASH_TIMEOUT_MS);
		respond(conn, "200 OK", "application/json", 0);
		put_fd(conn, "{\"ok\":");
		put_fd(conn, (got >= 0 && code == 0) ? "true" : "false");
		/* The script's own words. It reports "Reset CS to default
		 * configuration success." and it can also report FATAL ERROR
		 * from its space check, and the caller should see which. */
		put_fd(conn, ",\"output\":\"");
		if (got > 0)
			put_json_cstr(conn, status);
		put_fd(conn, "\"}");
		return;
	}

	/*
	 * Ping, from the stick.
	 *
	 * Proving the line from the ONU rather than from behind your router is
	 * the one diagnostic the vendor UI has that this did not, and it
	 * answers a question nothing else here can: whether the stick itself
	 * reaches anything.
	 *
	 * IPv4 literals only, and that is not laziness. This server is
	 * single-threaded and serial, so whatever ping does, every other
	 * request waits for it -- and a hostname means a DNS lookup on a device
	 * that, in bridge mode, has no route to a resolver. That lookup does
	 * not fail fast, it hangs, and it would take the whole UI with it. A
	 * literal cannot.
	 *
	 * Even so this blocks for a few seconds: three packets at one per
	 * second, and nothing else is served meanwhile.
	 */
	if (seq(path, "/api/ping") && seq(method, "POST")) {
		char host[64];
		char *argv[6];
		unsigned long i, digits = 0, dots = 0;
		long got, code = -1;

		if (!form_get(body, "host", host, sizeof(host))) {
			respond(conn, "400 Bad Request", "application/json", 0);
			put_fd(conn, "{\"ok\":false,\"error\":\"host is required\"}");
			return;
		}
		for (i = 0; host[i]; i++) {
			if (host[i] >= '0' && host[i] <= '9') { digits++; continue; }
			if (host[i] == '.') { dots++; continue; }
			digits = 0;
			break;
		}
		if (!digits || dots != 3 || i > 15) {
			respond(conn, "400 Bad Request", "application/json", 0);
			put_fd(conn, "{\"ok\":false,\"error\":\"an IPv4 address, and only an IPv4 address\"}");
			return;
		}

		argv[0] = "ping";
		argv[1] = "-c";
		argv[2] = "3";
		argv[3] = host;
		argv[4] = 0;

		got = run_to_buf_ex(PING_PATH, argv, status, sizeof(status), &code,
				   PING_TIMEOUT_MS);
		respond(conn, "200 OK", "application/json", 0);
		put_fd(conn, "{\"ok\":");
		put_fd(conn, (got >= 0 && code == 0) ? "true" : "false");
		put_fd(conn, ",\"output\":\"");
		if (got > 0)
			put_json_cstr(conn, status);
		put_fd(conn, "\"");
		/*
		 * 127 is run_to_buf_ex's own "execve failed", not ping's. Worth
		 * separating: without this a missing /bin/ping reads as "no
		 * reply", which sends you to look at the network instead of at
		 * the image.
		 */
		if (code == 127)
			put_fd(conn, ",\"error\":\"no ping in this image\"");
		else if (got < 0)
			put_fd(conn, ",\"error\":\"could not run ping\"");
		put_fd(conn, "}");
		return;
	}

	if (seq(path, "/api/config") && seq(method, "POST")) {
		handle_write(conn, body);
		return;
	}

	if (seq(path, "/api/firmware")) {
		if (seq(method, "GET")) {
			emit_firmware_json(conn);
			return;
		}
		if (seq(method, "POST")) {
			char action[32], part[8];

			form_get(body, "action", action, sizeof(action));
			form_get(body, "partition", part, sizeof(part));

			/* Only ever 0 or 1. sw_tryactive == 2 is U-Boot's "no
			 * trial pending" state, and writing it here would mean
			 * silently doing nothing while reporting success.
			 *
			 * `write` belongs in this list and was missing from it,
			 * so a partition of 9 went through to fwu_starter.sh --
			 * which rejects it, but an argument this daemon has not
			 * checked is one it is trusting the next program to. */
			if ((seq(action, "try") || seq(action, "commit") ||
			     seq(action, "write")) &&
			    !(seq(part, "0") || seq(part, "1"))) {
				respond(conn, "400 Bad Request", "application/json", 0);
				put_fd(conn, "{\"error\":\"partition must be 0 or 1\"}");
				return;
			}

			if (seq(action, "try")) {
				respond(conn, "200 OK", "application/json", 0);
				put_fd(conn, nv_set("sw_tryactive", part)
					? "{\"ok\":true,\"note\":\"armed\"}"
					: "{\"ok\":false,\"error\":\"nv setenv failed\"}");
				return;
			}
			if (seq(action, "commit")) {
				respond(conn, "200 OK", "application/json", 0);
				put_fd(conn, nv_set("sw_commit", part)
					? "{\"ok\":true,\"note\":\"committed\"}"
					: "{\"ok\":false,\"error\":\"nv setenv failed\"}");
				return;
			}
			/*
			 * Write the uploaded image to a partition.
			 *
			 * fwu_starter.sh extracts fwu.sh and md5.txt from the
			 * tar, checks fwu.sh against its own md5, and only then
			 * runs it -- and fwu.sh verifies the kernel and rootfs
			 * md5s BEFORE erasing anything. So the integrity check
			 * that matters is already in the image; this route does
			 * not reimplement it.
			 *
			 * It blocks for about eighty seconds, and this server
			 * is serial, so nothing else is answered meanwhile.
			 * That is the honest behaviour for an operation you
			 * must not interrupt: a page that looked responsive
			 * during a flash would be inviting a second click.
			 */
			if (seq(action, "write")) {
				char *argv[4];
				long code = -1;

				argv[0] = "fwu_starter.sh";
				argv[1] = part;
				argv[2] = UPLOAD_PATH;
				argv[3] = 0;

				/* Refuse to write the partition that is
				 * running. fwu.sh would too, but finding that
				 * out after the erase has started is not the
				 * place to learn it. */
				{
					char act[8];

					if (nv_get("sw_active", act, sizeof(act)) &&
					    seq(act, part)) {
						respond(conn, "400 Bad Request", "application/json", 0);
						put_fd(conn, "{\"ok\":false,\"error\":\"that is the partition this stick is running\"}");
						return;
					}
				}

				if (run_to_buf_ex(FWU_STARTER, argv, status,
						  sizeof(status), &code,
						  FWU_TIMEOUT_MS) < 0) {
					respond(conn, "500 Internal Server Error", "application/json", 0);
					put_fd(conn, "{\"ok\":false,\"error\":\"could not run the updater\"}");
					return;
				}
				respond(conn, "200 OK", "application/json", 0);
				put_fd(conn, "{\"ok\":");
				put_fd(conn, code == 0 ? "true" : "false");
				put_fd(conn, ",\"output\":\"");
				put_json_cstr(conn, status);
				put_fd(conn, "\"}");
				return;
			}

			if (seq(action, "reboot")) {
				static char *const rb[] = { "sh", 0 };
				static const char script[] =
					"trap '' HUP\n"
					"( sleep 1; /sbin/reboot || /bin/reboot ) >/dev/null 2>&1 &\n";
				char out[64];

				/* Answer first, then reboot a second later: the
				 * reply cannot be delivered by a kernel that is
				 * already going down. */
				respond(conn, "200 OK", "application/json", 0);
				put_fd(conn, "{\"ok\":true,\"note\":\"rebooting\"}");
				run_script_to_buf("/bin/sh", rb, script, out, sizeof(out),
						 REBOOT_TIMEOUT_MS);
				return;
			}
			respond(conn, "400 Bad Request", "application/json", 0);
			put_fd(conn, "{\"error\":\"unknown action\"}");
			return;
		}
	}

	/*
	 * Apply saved settings, when the caller asks. `what` names the action
	 * the write response listed: network (live) or omci (interrupts the
	 * internet). The page asks for confirmation before omci; this route
	 * does not second-guess it, but it never runs one the caller did not
	 * name, and a save never triggers one by itself.
	 *
	 * The image's apply.sh does the work and says what it did. Without
	 * one, omci falls back to restarting the stock omci_app, the only apply
	 * a stock-based image has, and network is refused.
	 */
	if (seq(path, "/api/apply") && seq(method, "POST")) {
		char what[16];   /* "network", "omci", "syslog" or "ntp" */
		long code = -1, got;

		if (!form_get(body, "what", what, sizeof(what)) || !what[0])
			str_copy(what, "omci", sizeof(what));
		if (!seq(what, "omci") && !seq(what, "network") &&
		    !seq(what, "syslog") && !seq(what, "ntp")) {
			respond(conn, "400 Bad Request", "application/json", 0);
			put_fd(conn, "{\"ok\":false,\"error\":\"what must be network, omci, syslog or ntp\"}");
			return;
		}
		if (file_exists(APPLY_PATH)) {
			char *argv[3];

			argv[0] = "apply.sh";
			argv[1] = what;
			argv[2] = 0;
			got = run_to_buf_ex(APPLY_PATH, argv, status, sizeof(status), &code,
					   APPLY_TIMEOUT_MS);
			respond(conn, "200 OK", "application/json", 0);
			put_fd(conn, "{\"ok\":");
			put_fd(conn, (got >= 0 && code == 0) ? "true" : "false");
			put_fd(conn, ",\"applied\":");
			put_fd(conn, (got >= 0 && code == 0) ? "true" : "false");
			put_fd(conn, ",\"output\":\"");
			if (got > 0)
				put_json_cstr(conn, status);
			put_fd(conn, "\"}");
			return;
		}
		respond(conn, "200 OK", "application/json", 0);
		if (!seq(what, "omci")) {
			put_fd(conn, "{\"ok\":false,\"applied\":false,"
				     "\"error\":\"this image has no " APPLY_PATH "; reboot to apply\"}");
			return;
		}
		put_fd(conn, apply_omci() ? "{\"ok\":true,\"applied\":true}"
					  : "{\"ok\":false,\"applied\":false,\"error\":\"omci_app did not come back\"}");
		return;
	}

	/*
	 * Create or remove one switch file on the config partition, from the
	 * allowlist in confd.h. Only the name is compared; the path is built
	 * from the literal, never from the request.
	 */
	if (seq(path, "/api/switch") && seq(method, "POST")) {
		char name[48], on[4];
		static const char p_identity[] = SWITCH_DIR SWITCH_OMCI_IDENTITY;
		const char *target = 0;

		form_get(body, "name", name, sizeof(name));
		if (!form_get(body, "on", on, sizeof(on)) ||
		    !(seq(on, "0") || seq(on, "1"))) {
			respond(conn, "400 Bad Request", "application/json", 0);
			put_fd(conn, "{\"ok\":false,\"error\":\"on must be 0 or 1\"}");
			return;
		}
		if (seq(name, SWITCH_OMCI_IDENTITY))
			target = p_identity;
		if (!target) {
			respond(conn, "400 Bad Request", "application/json", 0);
			put_fd(conn, "{\"ok\":false,\"error\":\"not a switch this UI sets\"}");
			return;
		}
		if (seq(on, "1"))
			write_file(target, "", 0, 0644);
		else
			syscall3(__NR_unlink, (long)target, 0, 0);
		respond(conn, "200 OK", "application/json", 0);
		put_fd(conn, "{\"ok\":");
		put_fd(conn, file_exists(target) == seq(on, "1") ? "true" : "false");
		put_fd(conn, ",\"on\":");
		put_fd(conn, file_exists(target) ? "true" : "false");
		put_fd(conn, "}");
		return;
	}

	if (!seq(method, "GET")) {
		respond(conn, "405 Method Not Allowed", "text/plain",
			"Allow: GET, POST\r\n");
		return;
	}

	if (seq(path, "/api/schema")) {
		if (read_file(SCHEMA_PATH_OVR, schema, sizeof(schema)) <= 0 &&
		    read_file(SCHEMA_PATH, schema, sizeof(schema)) <= 0) {
			respond(conn, "500 Internal Server Error", "application/json", 0);
			put_fd(conn, "{\"error\":\"no schema\"}");
			return;
		}
		{
			static const char *col[] = { "name", "store", "address",
						     "section", "type", "apply",
						     "writable", "common" };

			respond(conn, "200 OK", "application/json", 0);
			emit_tsv_json(conn, schema, col, 8);
		}
		return;
	}

	if (seq(path, "/api/meta")) {
		static const char *col[] = { "name", "label", "help",
					     "options", "depends", "range" };

		/* Curated help, hand-written and merged with the schema by the
		 * browser. Absent is not an error: the UI degrades to bare key
		 * names rather than refusing to load. */
		if (read_file(META_PATH_OVR, schema, sizeof(schema)) <= 0 &&
		    read_file(META_PATH, schema, sizeof(schema)) <= 0) {
			respond(conn, "200 OK", "application/json", 0);
			put_fd(conn, "[]");
			return;
		}
		respond(conn, "200 OK", "application/json", 0);
		emit_tsv_json(conn, schema, col, 6);
		return;
	}

	if (seq(path, "/api/consumers")) {
		static const char *col[] = { "name", "apply", "readers" };

		/* Derived from the firmware by scripts/classify-apply.py: which
		 * programs read each key, and therefore what it costs to change
		 * one. Absent degrades to the schema's own apply column. */
		if (read_file(CONS_PATH_OVR, schema, sizeof(schema)) <= 0 &&
		    read_file(CONS_PATH, schema, sizeof(schema)) <= 0) {
			respond(conn, "200 OK", "application/json", 0);
			put_fd(conn, "[]");
			return;
		}
		respond(conn, "200 OK", "application/json", 0);
		emit_tsv_json(conn, schema, col, 3);
		return;
	}

	if (seq(path, "/api/defaults")) {
		/* Both files are small — ten values between them — so one buffer
		 * and the values parser already written cover it.
		 *
		 * Clear it FIRST. read_file returns without touching the buffer
		 * when open() fails, and `values` is the same buffer
		 * /api/values fills. A device missing both default files
		 * therefore served the previous /api/values response back as
		 * the image defaults, and the page labelled every key on it an
		 * image default -- the exact inversion of what it is for, and
		 * it suppressed the baseline "changed" labels too. */
		long n, m;

		values[0] = 0;
		n = read_file(DEFAULT_CS, values, sizeof(values));
		if (n < 0)
			n = 0;
		values[n] = 0;
		m = read_file(DEFAULT_HS, values + n, sizeof(values) - (unsigned long)n);
		if (m < 0)
			m = 0;
		values[n + m] = 0;
		respond(conn, "200 OK", "application/json", 0);
		emit_values_json(conn, values);
		return;
	}

	if (seq(path, "/api/settings")) {
		static const char *col[] = { "name", "apply", "action", "pair",
					     "reader", "note" };

		/* This image's own view of each key. Absent answers an empty
		 * list, and the page then offers every key as it used to. */
		if (read_file(SETT_PATH_OVR, sett, sizeof(sett)) <= 0 &&
		    read_file(SETT_PATH, sett, sizeof(sett)) <= 0) {
			respond(conn, "200 OK", "application/json", 0);
			put_fd(conn, "[]");
			return;
		}
		respond(conn, "200 OK", "application/json", 0);
		emit_tsv_json(conn, sett, col, 6);
		return;
	}

	if (seq(path, "/api/features")) {
		static const char *col[] = { "mask", "bit", "feature", "module" };

		/* The OMCI_CUSTOM_* bitmasks, decoded. Absent degrades to
		 * showing the raw value, which is what every other tool for
		 * this device does. */
		if (read_file(FEAT_PATH_OVR, schema, sizeof(schema)) <= 0 &&
		    read_file(FEAT_PATH, schema, sizeof(schema)) <= 0) {
			respond(conn, "200 OK", "application/json", 0);
			put_fd(conn, "[]");
			return;
		}
		respond(conn, "200 OK", "application/json", 0);
		emit_tsv_json(conn, schema, col, 4);
		return;
	}

	if (seq(path, "/api/baseline")) {
		static const char *col[] = { "name", "value" };

		if (read_file(BASE_PATH_OVR, schema, sizeof(schema)) <= 0 &&
		    read_file(BASE_PATH, schema, sizeof(schema)) <= 0) {
			respond(conn, "200 OK", "application/json", 0);
			put_fd(conn, "[]");
			return;
		}
		respond(conn, "200 OK", "application/json", 0);
		emit_tsv_json(conn, schema, col, 2);
		return;
	}

	if (seq(path, "/api/values")) {
		if (load_values() < 0) {
			respond(conn, "500 Internal Server Error", "application/json", 0);
			put_fd(conn, "{\"error\":\"flash failed\"}");
			return;
		}
		respond(conn, "200 OK", "application/json", 0);
		emit_values_json(conn, values);
		return;
	}

	/*
	 * The whole config store, as a file.
	 *
	 * This exists because of what it prevents. `flash_eraseall /dev/mtd3`
	 * is the standard factory-reset recipe for this device and it wipes the
	 * config partition -- which is also where ELAN_MAC_ADDR and MAC_KEY
	 * live. Without those the ONU never gets past O0, so the reset that was
	 * meant to fix a stick ends it. Anime4000/RTL960x#84 has people doing
	 * exactly that, including one who ran it across mtd3, mtd4 and mtd5 and
	 * lost the device entirely.
	 *
	 * So: a backup you can take in one click, BEFORE, containing the values
	 * you cannot regenerate. It is served as a download rather than shown,
	 * because a page you have to remember to copy out of is not a backup.
	 *
	 * It carries the identity keys in clear. That is the point of it, and
	 * it is why it needs the same credential as everything else.
	 */
	if (seq(path, "/api/backup")) {
		if (load_values() < 0) {
			respond(conn, "500 Internal Server Error", "text/plain", 0);
			put_fd(conn, "flash failed\n");
			return;
		}
		respond(conn, "200 OK", "text/plain; charset=utf-8",
			"Content-Disposition: attachment; filename=\"odi-config-backup.xml\"\r\n");
		put_fd(conn, "<!-- ODI DFP-34X-2C2 configuration backup.\n"
			     "     Both stores, exactly as `flash all cs` and `flash all hs` print them.\n"
			     "     Restore a key with:  flash set <NAME> <VALUE>\n"
			     "     The ones you cannot regenerate are GPON_SN, ELAN_MAC_ADDR and\n"
			     "     MAC_KEY: without them the ONU does not get past O0, and erasing\n"
			     "     /dev/mtd3 is what takes them away.\n"
			     "     confd build " BUILD_ID " -->\n");
		write_all(conn, values, slen(values));
		return;
	}

	if (seq(path, "/api/status")) {
		respond(conn, "200 OK", "application/json", 0);
		emit_status_json(conn);
		return;
	}

	/* The diagnostics bundle, redacted by the image script; see status.c. */
	if (seq(path, "/api/diag")) {
		emit_diag_bundle(conn);
		return;
	}

	if (seq(path, "/api/log")) {
		respond(conn, "200 OK", "application/json", 0);
		emit_log_json(conn);
		return;
	}

	if (seq(path, "/api/l2")) {
		respond(conn, "200 OK", "application/json", 0);
		emit_l2_json(conn);
		return;
	}

	/*
	 * The OMCI MIB: what the OLT provisioned, as opposed to what we asked
	 * for. Read-only, and allowlisted verb by verb inside -- see omci.c.
	 */
	if (seq(path, "/api/omci")) {
		emit_omci_json(conn, query);
		return;
	}

	if (!serve_asset(conn, path)) {
		respond(conn, "404 Not Found", "text/plain", 0);
		put_fd(conn, "not found\n");
	}
}
