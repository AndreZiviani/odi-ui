/*
 * confd — a web configuration UI for the ODI DFP-34X-2C2 (Realtek RTL9601D).
 *
 * Runs alongside the vendor's boa on its own port. It does not replace boa and
 * does not try to: boa's UI is 88 handlers compiled into the boa binary with no
 * CGI seam to hook, so the only way to extend it is to not use it.
 *
 * The design that makes this small: serve a static page and a JSON API, and let
 * the browser render. The device's configuration is ~184 MIB keys plus a couple
 * of indexed tables, described by a schema file rather than by C, so adding a
 * key is a data change and not a new handler.
 *
 * Phase 1 is READ ONLY. There is deliberately no write path in this binary yet.
 *
 * Values are emitted as the literal text `flash` printed. Nothing is parsed to
 * a number and formatted back, which is why a freestanding build with no libc
 * costs nothing here.
 */

#include "util.h"

#define DEFAULT_PORT 8080
#define BACKLOG      8

#define FLASH_PATH "/etc/scripts/flash"
#define DIAG_PATH  "/bin/diag"

/* The image ships these; /etc/config wins so the UI can be iterated without a
 * reflash, exactly as the exporter binary can. */
#define WEB_DIR      "/etc/confd/"
#define WEB_DIR_OVR  "/etc/config/confd/"
#define SCHEMA_PATH     "/etc/confd/keys.tsv"
#define SCHEMA_PATH_OVR "/etc/config/confd/keys.tsv"
#define META_PATH       "/etc/confd/meta.tsv"
#define META_PATH_OVR   "/etc/config/confd/meta.tsv"
#define CONS_PATH       "/etc/confd/consumers.tsv"
#define CONS_PATH_OVR   "/etc/config/confd/consumers.tsv"
#define AUTH_PATH    "/etc/config/confd.auth"

/* Static, not stack: this is a single-threaded serial server and these would
 * otherwise be tens of kilobytes of stack in one frame. */
static char req[4096];
static char schema[40960];
static char values[24576];
static char status[16384];
static char authbuf[256];
static char hdrbuf[512];
static char credbuf[256];
static char filebuf[65536];

/* ------------------------------------------------------------------ HTTP --- */

static void respond(int fd, const char *status_line, const char *ctype,
		    const char *extra)
{
	put_fd(fd, "HTTP/1.0 ");
	put_fd(fd, status_line);
	put_fd(fd, "\r\nContent-Type: ");
	put_fd(fd, ctype);
	put_fd(fd, "\r\nCache-Control: no-store\r\nConnection: close\r\n");
	if (extra)
		put_fd(fd, extra);
	put_fd(fd, "\r\n");
}

/*
 * Extract the request path. Returns a pointer into req, NUL-terminated in
 * place. A request line that does not look like "METHOD path HTTP/x" yields 0
 * rather than a guess.
 */
static char *request_path(char *r, char **method)
{
	unsigned long i = 0, s;

	*method = r;
	while (r[i] && r[i] != ' ' && r[i] != '\r' && r[i] != '\n')
		i++;
	if (r[i] != ' ')
		return 0;
	r[i++] = 0;

	s = i;
	while (r[i] && r[i] != ' ' && r[i] != '\r' && r[i] != '\n')
		i++;
	if (r[i] != ' ')
		return 0;
	r[i] = 0;
	return r + s;
}

/*
 * Copy a header's value into `out`. Case-insensitive on the name.
 *
 * Non-destructive, deliberately. The obvious implementation NUL-terminates the
 * value in place, and that quietly breaks any request with a body:
 * Content-Length is typically the last header, so terminating it overwrites the
 * CR of the CRLFCRLF that marks where the body starts, and the body then
 * appears to be empty. Harmless while every route is a GET; fatal the moment
 * the write path starts POSTing. Parsers that edit their input are how that
 * keeps happening — see also the note in serve() about request_path().
 */
static int header_copy(const char *r, const char *name, char *out, unsigned long cap)
{
	unsigned long i = 0, n = slen(name);

	out[0] = 0;
	for (;;) {
		unsigned long k = 0;

		while (r[i] && r[i] != '\n')
			i++;
		if (!r[i])
			return 0;
		i++;
		if (!r[i] || r[i] == '\r' || r[i] == '\n')
			return 0;              /* end of headers */

		while (k < n) {
			char a = r[i + k], b = name[k];

			if (a >= 'A' && a <= 'Z')
				a = (char)(a - 'A' + 'a');
			if (b >= 'A' && b <= 'Z')
				b = (char)(b - 'A' + 'a');
			if (a != b)
				break;
			k++;
		}
		if (k == n && r[i + k] == ':') {
			unsigned long v = i + k + 1, o = 0;

			while (r[v] == ' ')
				v++;
			while (r[v] && r[v] != '\r' && r[v] != '\n' && o + 1 < cap)
				out[o++] = r[v++];
			out[o] = 0;
			return o > 0;
		}
	}
}

/*
 * HTTP Basic, against user:password in /etc/config/confd.auth.
 *
 * If the file is missing or empty the daemon refuses every request rather than
 * running open. An unauthenticated config UI on the LAN is a worse outcome than
 * no config UI, and "it stopped working" is a far better failure than "it let
 * anyone in".
 */
static int authorised(const char *r)
{
	long n, want;
	unsigned long i = 0;
	int diff = 0;

	want = read_file(AUTH_PATH, credbuf, sizeof(credbuf));
	if (want <= 0)
		return 0;
	/* trim trailing newline/CR so an editor-written file works */
	while (want > 0 && (credbuf[want - 1] == '\n' || credbuf[want - 1] == '\r'))
		credbuf[--want] = 0;
	if (want == 0)
		return 0;

	if (!header_copy(r, "authorization", hdrbuf, sizeof(hdrbuf)))
		return 0;
	if (!spre(hdrbuf, "Basic "))
		return 0;

	n = b64decode(hdrbuf + 6, slen(hdrbuf + 6), authbuf, sizeof(authbuf));
	if (n < 0)
		return 0;

	/* Compare every byte regardless, so timing does not leak the prefix.
	 * A length mismatch is folded in rather than returned early. */
	if (n != want)
		diff = 1;
	for (i = 0; i < (unsigned long)want && i + 1 < sizeof(authbuf); i++)
		diff |= (authbuf[i] ^ credbuf[i]);
	return diff == 0;
}

/* ------------------------------------------------------------ form input --- */

static int hexval(char c)
{
	if (c >= '0' && c <= '9') return c - '0';
	if (c >= 'a' && c <= 'f') return c - 'a' + 10;
	if (c >= 'A' && c <= 'F') return c - 'A' + 10;
	return -1;
}

/*
 * Decode one application/x-www-form-urlencoded token, stopping at `stop`.
 * Returns the index just past what it consumed, or 0 on a malformed escape —
 * rejected rather than passed through, so a mangled field cannot quietly become
 * a different one.
 */
static unsigned long url_decode(const char *in, unsigned long i, char stop,
				char *out, unsigned long cap)
{
	unsigned long o = 0;

	while (in[i] && in[i] != stop && in[i] != '&') {
		char c = in[i];

		if (c == '+') {
			c = ' ';
			i++;
		} else if (c == '%') {
			int hi = hexval(in[i + 1]), lo = hexval(in[i + 2]);

			if (hi < 0 || lo < 0)
				return 0;
			c = (char)((hi << 4) | lo);
			i += 3;
		} else {
			i++;
		}
		if (o + 1 < cap)
			out[o++] = c;
	}
	out[o] = 0;
	return i;
}

/* One named field out of a urlencoded body. */
static int form_get(const char *body, const char *want, char *out, unsigned long cap)
{
	char name[64];
	unsigned long i = 0;

	out[0] = 0;
	while (body[i]) {
		unsigned long k = url_decode(body, i, '=', name, sizeof(name));

		if (!k)
			return 0;
		i = k;
		if (body[i] == '=')
			i++;
		i = url_decode(body, i, 0, out, cap);
		if (!i)
			return 0;
		if (seq(name, want))
			return 1;
		if (body[i] == '&')
			i++;
	}
	out[0] = 0;
	return 0;
}

/* --------------------------------------------------------------- validate --- */

/*
 * Type-level validation, server side.
 *
 * The browser also checks ranges and option lists from meta.tsv, but that is a
 * convenience: anything reachable over HTTP has to be validated here too, since
 * a request need not come from the page.
 */
static int type_ok(const char *type, const char *v)
{
	unsigned long i, dots = 0, digits = 0;

	if (seq(type, "int")) {
		if (!v[0])
			return 0;
		for (i = 0; v[i]; i++)
			if (v[i] < '0' || v[i] > '9')
				return 0;
		return 1;
	}
	if (seq(type, "ipv4")) {
		for (i = 0; v[i]; i++) {
			if (v[i] == '.') {
				if (!digits || digits > 3)
					return 0;
				digits = 0;
				dots++;
			} else if (v[i] >= '0' && v[i] <= '9') {
				digits++;
			} else {
				return 0;
			}
		}
		return dots == 3 && digits && digits <= 3;
	}
	if (seq(type, "mac") || seq(type, "hex32") || seq(type, "hexascii")) {
		unsigned long want = seq(type, "mac") ? 12 : (seq(type, "hex32") ? 32 : 0);

		for (i = 0; v[i]; i++)
			if (hexval(v[i]) < 0)
				return 0;
		if (i % 2)
			return 0;                  /* hex is whole bytes */
		return want ? (i == want) : 1;
	}
	return 1;                                  /* string: anything */
}

/* ----------------------------------------------------------------- write --- */

/*
 * Never writable, whatever the schema says.
 *
 * A wrong SerDes mode takes out telnet, ssh, this UI and the exporter
 * simultaneously, because every one of them arrives over that link. What is
 * left is a serial console behind soldered UART pads. The schema marks these
 * too; this list exists so that a bad schema edit cannot be the only thing
 * standing between a typo and a bricked stick.
 */
static int refused_key(const char *k)
{
	return seq(k, "LAN_SDS_MODE") || seq(k, "LAN_SPEED_MODE") ||
	       seq(k, "FIBER_MODE");
}

/* Look a key up in the schema, copying its `writable` and `apply` columns. */
static int schema_lookup(const char *buf, const char *name,
			 char *type, unsigned long tcap,
			 char *writable, unsigned long wcap,
			 char *apply, unsigned long acap)
{
	unsigned long i = 0;

	type[0] = 0;
	writable[0] = 0;
	apply[0] = 0;
	while (buf[i]) {
		unsigned long ls = i, le = i, p, c, fs;

		while (buf[le] && buf[le] != '\n')
			le++;
		if (buf[ls] == '#' || ls == le)
			goto next;

		/* column 0 is the name */
		p = ls;
		while (p < le && buf[p] != '\t')
			p++;
		{
			unsigned long n = 0;

			while (name[n] && ls + n < p && name[n] == buf[ls + n])
				n++;
			if (name[n] || ls + n != p)
				goto next;
		}
		/* columns 5 (apply) and 6 (writable) */
		for (c = 1; c <= 6 && p < le; c++) {
			p++;
			fs = p;
			while (p < le && buf[p] != '\t')
				p++;
			if (c == 4) {
				unsigned long n = 0;

				while (fs + n < p && n + 1 < tcap)
					type[n] = buf[fs + n], n++;
				type[n] = 0;
			} else if (c == 5) {
				unsigned long n = 0;

				while (fs + n < p && n + 1 < acap)
					apply[n] = buf[fs + n], n++;
				apply[n] = 0;
			} else if (c == 6) {
				unsigned long n = 0;

				while (fs + n < p && n + 1 < wcap)
					writable[n] = buf[fs + n], n++;
				writable[n] = 0;
			}
		}
		return 1;
next:
		i = (buf[le] == '\n') ? le + 1 : le;
	}
	return 0;
}

/*
 * Write one key and read it back.
 *
 * `flash set` is used rather than driving xmlconfig directly because it also
 * decides whether the value belongs in the CS or the HS file, which is not
 * something to reimplement. Exactly three arguments matter: with more, flash
 * treats them as a list to hex-encode and concatenate. Values reach execve as
 * one argv element with no shell in between, so a space or a quote in a value
 * is data rather than syntax.
 *
 * The read-back is the point. `flash set` cannot clear a key at all — its set
 * branch is guarded by [ "$3" != "" ], so an empty value falls through to the
 * usage text and exits 1 while looking like it worked.
 */
static int write_key(const char *name, const char *value, char *out, unsigned long cap)
{
	char *argv[5];
	char buf[512];
	unsigned long i = 0, vs;

	argv[0] = "flash";
	argv[1] = "set";
	argv[2] = (char *)name;
	argv[3] = (char *)value;
	argv[4] = 0;

	if (run_to_buf(FLASH_PATH, argv, buf, sizeof(buf)) <= 0)
		return 0;

	/* flash echoes "KEY=value" from its own xmlconfig -g when it is done. */
	while (buf[i] && buf[i] != '=')
		i++;
	if (!buf[i])
		return 0;
	vs = ++i;
	while (buf[i] && buf[i] != '\n' && buf[i] != '\r')
		i++;
	{
		unsigned long n = 0;

		while (vs + n < i && n + 1 < cap)
			out[n] = buf[vs + n], n++;
		out[n] = 0;
	}
	return seq(out, value);
}

/*
 * Restart the OMCI stack so a change takes effect without a reboot.
 *
 * PATH is not optional: omci_app shells out to `flash` itself and inherits it,
 * and without /etc/scripts it reads a zero MAC and exits with
 * "GPON mac_check fail", taking the ONU off the line. runomci.sh also calls
 * runigmp.sh, which noisily fails to re-insmod a loaded module and to start a
 * second igmpd; neither is an error worth reporting.
 */
static int apply_omci(void)
{
	static char *const argv[] = { "sh", 0 };
	static const char script[] =
		"PATH=$PATH:/etc/scripts\n"
		"kill $(pidof omci_app) 2>/dev/null\n"
		"i=0; while [ $i -lt 15 ] && pidof omci_app >/dev/null 2>&1; do sleep 1; i=$((i+1)); done\n"
		"trap '' HUP\n"
		"( /etc/runomci.sh >/dev/null 2>&1 & )\n"
		"sleep 3\n"
		"pidof omci_app >/dev/null 2>&1 && echo APPLIED || echo FAILED\n";
	char buf[256];
	unsigned long i;

	if (run_script_to_buf("/bin/sh", argv, script, buf, sizeof(buf)) <= 0)
		return 0;
	for (i = 0; buf[i]; i++)
		if (spre(buf + i, "APPLIED"))
			return 1;
	return 0;
}

/* -------------------------------------------------------------- firmware --- */

/*
 * Boot selection.
 *
 * U-Boot keeps a one-shot trial slot, and using it is the difference between an
 * experiment and a site visit. Setting sw_tryactive boots a partition ONCE with
 * the watchdog armed; if the image does not come up, the next boot returns to
 * whatever sw_commit names, unattended. A trial that boots fine still reverts on
 * the following reboot, so keeping an image is a separate deliberate act.
 *
 * The obvious-looking alternative — writing sw_commit straight away — makes an
 * unproven image permanent before it has booted even once, and is what every
 * runbook for this device used to say.
 *
 * sw_active is U-Boot's own record of what it last booted. It is written by the
 * bootloader on every boot and is never set here.
 */
static void emit_firmware_json(int fd)
{
	static char *const argv[] = { "nv", "getenv", 0 };
	char buf[4096];
	char ver[128];
	unsigned long i = 0;
	int first = 1;

	respond(fd, "200 OK", "application/json", 0);
	put_fd(fd, "{\"running\":\"");
	if (read_file("/etc/version", ver, sizeof(ver)) > 0) {
		unsigned long n = 0;

		while (ver[n] && ver[n] != '\n' && ver[n] != ' ')
			n++;
		put_json_str(fd, ver, n);
	}
	put_fd(fd, "\",\"mem\":\"");
	{
		/* Total RAM, so the upload note can state the real figure rather
		 * than a number baked into the page. */
		char mi[256];
		unsigned long k;

		if (read_file("/proc/meminfo", mi, sizeof(mi)) > 0) {
			for (k = 0; mi[k]; k++) {
				if (!spre(mi + k, "MemTotal:"))
					continue;
				k += 9;
				while (mi[k] == ' ')
					k++;
				{
					unsigned long e = k;

					while (mi[e] && mi[e] != ' ' && mi[e] != '\n')
						e++;
					/* kB -> MB, integer, good enough for a note */
					{
						unsigned long v = 0, q;

						for (q = k; q < e; q++)
							v = v * 10 + (unsigned long)(mi[q] - '0');
						v /= 1024;
						{
							char num[8];
							unsigned long n = 0;

							if (!v)
								num[n++] = '0';
							while (v) {
								num[n++] = (char)('0' + v % 10);
								v /= 10;
							}
							while (n)
								write_all(fd, &num[--n], 1);
						}
					}
				}
				break;
			}
		}
	}
	put_fd(fd, " MB\",\"env\":{");

	if (run_to_buf("/bin/nv", argv, buf, sizeof(buf)) > 0) {
		while (buf[i]) {
			unsigned long ls = i, le = i, eq;

			while (buf[le] && buf[le] != '\n')
				le++;
			if (!spre(buf + ls, "sw_"))
				goto next;
			eq = ls;
			while (eq < le && buf[eq] != '=')
				eq++;
			if (eq == le)
				goto next;
			if (!first)
				put_fd(fd, ",");
			first = 0;
			put_fd(fd, "\"");
			put_json_str(fd, buf + ls, eq - ls);
			put_fd(fd, "\":\"");
			put_json_str(fd, buf + eq + 1, le - eq - 1);
			put_fd(fd, "\"");
next:
			i = (buf[le] == '\n') ? le + 1 : le;
		}
	}
	put_fd(fd, "}}");
}

static int nv_set(const char *key, const char *value)
{
	char *argv[5];
	char buf[256];

	argv[0] = "nv";
	argv[1] = "setenv";
	argv[2] = (char *)key;
	argv[3] = (char *)value;
	argv[4] = 0;
	return run_to_buf("/bin/nv", argv, buf, sizeof(buf)) >= 0;
}

/* ---------------------------------------------------------------- routes --- */

/*
 * `flash all cs` and `flash all hs` — two forks for every value on the device.
 * Reading them key by key would be 184 forks at ~30 ms each, which is a five
 * second page load; the cost of a fork here is the process, not the work.
 */
static long load_values(void)
{
	static char *const cs[] = { "flash", "all", "cs", 0 };
	static char *const hs[] = { "flash", "all", "hs", 0 };
	long a, b;

	a = run_to_buf(FLASH_PATH, cs, values, sizeof(values));
	if (a <= 0)
		return -1;
	b = run_to_buf(FLASH_PATH, hs, values + a, sizeof(values) - (unsigned long)a);
	return b < 0 ? a : a + b;
}

/*
 * Emit {"NAME":"value",...} from `flash all` XML.
 *
 * Table rows are keyed as TBL[index].Field so they are addressable and match
 * what gen-schema.py writes, since the browser joins the two by name.
 */
static void emit_values_json(int fd, const char *buf)
{
	unsigned long i = 0;
	int first = 1;
	char table[64];
	char index[8];

	table[0] = 0;
	index[0] = 0;

	put_fd(fd, "{");
	while (buf[i]) {
		unsigned long ls = i, le = i;

		while (buf[le] && buf[le] != '\n')
			le++;

		if (spre(buf + ls, " <Dir Name=\"") || spre(buf + ls, "<Dir Name=\"")) {
			unsigned long p = ls, n = 0;

			while (p < le && buf[p] != '"')
				p++;
			p++;
			while (p < le && buf[p] != '"' && n + 1 < sizeof(table))
				table[n++] = buf[p++];
			table[n] = 0;
			index[0] = 0;
			if (seq(table, "MIB_TABLE") || seq(table, "HW_MIB_TABLE"))
				table[0] = 0;
			/* <!--index=N--> on the same line */
			for (p = ls; p + 8 < le; p++) {
				if (spre(buf + p, "index=")) {
					unsigned long m = 0;

					p += 6;
					while (p < le && buf[p] >= '0' && buf[p] <= '9' &&
					       m + 1 < sizeof(index))
						index[m++] = buf[p++];
					index[m] = 0;
					break;
				}
			}
			goto next;
		}

		if (spre(buf + ls, "  <Value Name=\"") || spre(buf + ls, " <Value Name=\"") ||
		    spre(buf + ls, "<Value Name=\"")) {
			unsigned long p = ls, ks, ke, vs, ve;

			while (p < le && buf[p] != '"')
				p++;
			ks = ++p;
			while (p < le && buf[p] != '"')
				p++;
			ke = p;
			p++;
			while (p < le && buf[p] != '"')
				p++;
			vs = ++p;
			while (p < le && buf[p] != '"')
				p++;
			ve = p;
			if (ke <= ks || ve < vs)
				goto next;

			if (!first)
				put_fd(fd, ",");
			first = 0;
			put_fd(fd, "\"");
			if (table[0] && index[0]) {
				put_json_cstr(fd, table);
				put_fd(fd, "[");
				put_json_cstr(fd, index);
				put_fd(fd, "].");
			}
			put_json_str(fd, buf + ks, ke - ks);
			put_fd(fd, "\":\"");
			put_json_str(fd, buf + vs, ve - vs);
			put_fd(fd, "\"");
		}
next:
		i = (buf[le] == '\n') ? le + 1 : le;
	}
	put_fd(fd, "}");
}

/*
 * A TSV as JSON rows, given the column names. Comment lines and the header are
 * skipped, so the files stay readable and self-documenting on disk.
 */
static void emit_tsv_json(int fd, const char *buf, const char **col, unsigned long ncol)
{
	unsigned long i = 0;
	int first = 1;

	put_fd(fd, "[");
	while (buf[i]) {
		unsigned long ls = i, le = i, p, c;

		while (buf[le] && buf[le] != '\n')
			le++;

		if (buf[ls] == '#' || ls == le || spre(buf + ls, "name\t"))
			goto next;   /* comment, blank line, or the header */

		if (!first)
			put_fd(fd, ",");
		first = 0;
		put_fd(fd, "{");
		p = ls;
		for (c = 0; c < ncol; c++) {
			unsigned long fs = p;

			while (p < le && buf[p] != '\t')
				p++;
			if (c)
				put_fd(fd, ",");
			put_fd(fd, "\"");
			put_fd(fd, col[c]);
			put_fd(fd, "\":\"");
			put_json_str(fd, buf + fs, p - fs);
			put_fd(fd, "\"");
			if (p < le)
				p++;
		}
		put_fd(fd, "}");
next:
		i = (buf[le] == '\n') ? le + 1 : le;
	}
	put_fd(fd, "]");
}

/*
 * Device status, in one diag invocation. diag costs ~32 ms to start and almost
 * nothing to run, so every question goes in on stdin at once; see
 * sfp-exporter's notes on the same trick.
 */
static void emit_status_json(int fd)
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

/* Serve a static file, preferring the /etc/config override. */
static void serve_static(int fd, const char *name, const char *ctype)
{
	char path[128];
	unsigned long n = 0, k;
	long got;

	for (k = 0; WEB_DIR_OVR[k] && n + 1 < sizeof(path); k++)
		path[n++] = WEB_DIR_OVR[k];
	for (k = 0; name[k] && n + 1 < sizeof(path); k++)
		path[n++] = name[k];
	path[n] = 0;

	got = read_file(path, filebuf, sizeof(filebuf));
	if (got <= 0) {
		n = 0;
		for (k = 0; WEB_DIR[k] && n + 1 < sizeof(path); k++)
			path[n++] = WEB_DIR[k];
		for (k = 0; name[k] && n + 1 < sizeof(path); k++)
			path[n++] = name[k];
		path[n] = 0;
		got = read_file(path, filebuf, sizeof(filebuf));
	}
	if (got <= 0) {
		respond(fd, "404 Not Found", "text/plain", 0);
		put_fd(fd, "not found\n");
		return;
	}
	respond(fd, "200 OK", ctype, 0);
	write_all(fd, filebuf, (unsigned long)got);
}

static char *request_body(char *r)
{
	unsigned long i;

	for (i = 0; r[i]; i++)
		if (r[i] == '\r' && r[i+1] == '\n' && r[i+2] == '\r' && r[i+3] == '\n')
			return r + i + 4;
	return r + slen(r);
}

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
	char name[128], value[512], got[512];
	char type[32], writable[32], apply[32];
	unsigned long i = 0;
	int first = 1, confirm = 0, any_omci = 0, any_reboot = 0;

	if (read_file(SCHEMA_PATH_OVR, schema, sizeof(schema)) <= 0 &&
	    read_file(SCHEMA_PATH, schema, sizeof(schema)) <= 0) {
		respond(conn, "500 Internal Server Error", "application/json", 0);
		put_fd(conn, "{\"error\":\"no schema\"}");
		return;
	}

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
		else if (!schema_lookup(schema, name, type, sizeof(type),
					writable, sizeof(writable), apply, sizeof(apply)))
			err = "not in the schema";
		else if (seq(writable, "never"))
			err = "not writable";
		else if (seq(writable, "identity") && !confirm)
			err = "identity key: resend with _confirm=identity";
		else if (!value[0])
			err = "cannot be cleared: flash set refuses an empty value";
		else if (!type_ok(type, value))
			err = "not valid for its type";

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

		if (write_key(name, value, got, sizeof(got))) {
			put_fd(conn, "\"ok\":true,\"value\":\"");
			put_json_cstr(conn, got);
			put_fd(conn, "\"}");
			/* The schema's apply column is the fallback; the derived
			 * one in consumers.tsv is authoritative where present. */
			if (seq(apply, "restart:omci"))
				any_omci = 1;
			else
				any_reboot = 1;
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

	put_fd(conn, "],\"apply\":\"");
	put_fd(conn, any_reboot ? "reboot" : (any_omci ? "restart:omci" : "none"));
	put_fd(conn, "\"}");
}

static void serve(int conn)
{
	char *path, *method, *body;
	long n;

	n = syscall3(__NR_read, conn, (long)req, sizeof(req) - 1);
	if (n <= 0)
		return;
	req[n] = 0;

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
	 * stop the scan for the header/body boundary dead. */
	body = request_body(req);

	path = request_path(req, &method);
	if (!path) {
		respond(conn, "400 Bad Request", "text/plain", 0);
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

	if (seq(path, "/") || seq(path, "/index.html"))
		serve_static(conn, "index.html", "text/html; charset=utf-8");
	else if (seq(path, "/app.js"))
		serve_static(conn, "app.js", "application/javascript");
	else if (seq(path, "/style.css"))
		serve_static(conn, "style.css", "text/css");
	else {
		respond(conn, "404 Not Found", "text/plain", 0);
		put_fd(conn, "not found\n");
	}
}

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
		conn = syscall3(__NR_accept, fd, 0, 0);
		if (conn < 0)
			continue;
		serve((int)conn);
		syscall3(__NR_close, conn, 0, 0);
	}
}
