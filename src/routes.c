/*
 * Request dispatch, and the one route long enough to live beside it.
 */

#include "confd.h"
#include "buffers.h"
#include "http.h"
#include "mib.h"
#include "firmware.h"
#include "status.h"
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
		else if (!value[0])
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
	put_fd(conn, "}");
}

void serve(int conn)
{
	char *path, *method, *body;
	long n;

	n = read_request(conn, req, sizeof(req));
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
		if (cross && !seq(method, "GET")) {
			respond(conn, "403 Forbidden", "text/plain", 0);
			put_fd(conn, "cross-site request refused\n");
			return;
		}
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
			 * silently doing nothing while reporting success. */
			if ((seq(action, "try") || seq(action, "commit")) &&
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
				run_script_to_buf("/bin/sh", rb, script, out, sizeof(out));
				return;
			}
			respond(conn, "400 Bad Request", "application/json", 0);
			put_fd(conn, "{\"error\":\"unknown action\"}");
			return;
		}
	}

	if (seq(path, "/api/apply") && seq(method, "POST")) {
		respond(conn, "200 OK", "application/json", 0);
		put_fd(conn, apply_omci() ? "{\"applied\":true}"
					  : "{\"applied\":false,\"error\":\"omci_app did not come back\"}");
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

	if (seq(path, "/api/status")) {
		respond(conn, "200 OK", "application/json", 0);
		emit_status_json(conn);
		return;
	}

	if (!serve_asset(conn, path)) {
		respond(conn, "404 Not Found", "text/plain", 0);
		put_fd(conn, "not found\n");
	}
}
