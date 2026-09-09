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
#define AUTH_PATH    "/etc/config/confd.auth"

/*
 * Sessions.
 *
 * HTTP Basic was replaced by a form login for one reason: with Basic the
 * browser caches the credential and replays it on every request, so a session
 * cookie beside it buys nothing — there is no logout and no expiry, only a
 * credential the browser will keep sending. A form login means the cookie is
 * the only thing carrying authority, which makes both possible.
 *
 * Tokens are random and looked up in a fixed table, so there is no crypto here
 * at all — no HMAC, no signing, nothing to get subtly wrong. The cost is that
 * sessions live in this process: restarting confd logs everyone out, which is
 * a feature rather than a bug on a box you administer over ssh.
 *
 * TTL is measured against /proc/uptime, not the wall clock. This device boots
 * at Jan 1 1970 and its clock is never set, so time-of-day is both wrong and
 * liable to jump if anything ever sets it — which would expire every session at
 * once, or none of them. Uptime only ever goes forward.
 */
#define SESSION_TTL   3600      /* seconds; one hour */
#define SESSION_SLOTS 8
#define TOKEN_HEX     32        /* 16 random bytes */

struct session {
	char tok[TOKEN_HEX + 1];
	long expires;               /* uptime seconds */
};

static struct session sessions[SESSION_SLOTS];

/* Static, not stack: this is a single-threaded serial server and these would
 * otherwise be tens of kilobytes of stack in one frame. */
static char req[4096];
static char schema[40960];
static char values[24576];
static char status[16384];
static char credbuf[256];
static char filebuf[65536];

/* --------------------------------------------------------------- session --- */

/* Monotonic seconds. /proc/uptime is "SECS.FRAC IDLE"; the integer part is all
 * this needs, and it cannot go backwards the way a settable clock can. */
static long now_s(void)
{
	char buf[64];
	long v = 0;
	unsigned long i = 0;

	if (read_file("/proc/uptime", buf, sizeof(buf)) <= 0)
		return -1;
	while (buf[i] >= '0' && buf[i] <= '9') {
		v = v * 10 + (buf[i] - '0');
		i++;
	}
	return v;
}

static int rand_token(char *out)
{
	static const char hexd[] = "0123456789abcdef";
	unsigned char raw[TOKEN_HEX / 2];
	long fd = syscall3(__NR_open, (long)"/dev/urandom", 0, 0);
	unsigned long got = 0, i;

	if (fd < 0)
		return 0;
	while (got < sizeof(raw)) {
		long n = syscall3(__NR_read, fd, (long)(raw + got), sizeof(raw) - got);

		if (n <= 0)
			break;
		got += (unsigned long)n;
	}
	syscall3(__NR_close, fd, 0, 0);
	/* Short of a full token is a failure, not something to pad: a partly
	 * random session id is a guessable one. */
	if (got != sizeof(raw))
		return 0;

	for (i = 0; i < sizeof(raw); i++) {
		out[i * 2]     = hexd[(raw[i] >> 4) & 0xf];
		out[i * 2 + 1] = hexd[raw[i] & 0xf];
	}
	out[TOKEN_HEX] = 0;
	return 1;
}

/* Compare without an early exit, so timing does not leak a token prefix. */
static int tok_eq(const char *a, const char *b)
{
	unsigned long i;
	int diff = 0;

	for (i = 0; i < TOKEN_HEX; i++) {
		if (!a[i] || !b[i])
			return 0;
		diff |= (a[i] ^ b[i]);
	}
	return diff == 0;
}

static const char *session_new(void)
{
	long now = now_s();
	unsigned long i, slot = 0;
	long oldest = 0;

	/* Prefer a free or expired slot; otherwise evict the one closest to
	 * expiry, so a busy box cannot be locked out by stale sessions. */
	for (i = 0; i < SESSION_SLOTS; i++) {
		if (!sessions[i].tok[0] || sessions[i].expires <= now) {
			slot = i;
			goto take;
		}
		if (!oldest || sessions[i].expires < oldest) {
			oldest = sessions[i].expires;
			slot = i;
		}
	}
take:
	if (!rand_token(sessions[slot].tok)) {
		sessions[slot].tok[0] = 0;
		return 0;
	}
	sessions[slot].expires = now + SESSION_TTL;
	return sessions[slot].tok;
}

static int session_valid(const char *tok)
{
	long now = now_s();
	unsigned long i;

	if (!tok || !tok[0])
		return 0;
	for (i = 0; i < SESSION_SLOTS; i++) {
		if (!sessions[i].tok[0])
			continue;
		if (sessions[i].expires <= now) {
			sessions[i].tok[0] = 0;      /* reap on sight */
			continue;
		}
		if (tok_eq(sessions[i].tok, tok))
			return 1;
	}
	return 0;
}

static void session_kill(const char *tok)
{
	unsigned long i;

	if (!tok)
		return;
	for (i = 0; i < SESSION_SLOTS; i++)
		if (sessions[i].tok[0] && tok_eq(sessions[i].tok, tok))
			sessions[i].tok[0] = 0;
}

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
 * Non-destructive, deliberately. An earlier version NUL-terminated the value in
 * place, which quietly broke every login: Content-Length is the last header, so
 * terminating it overwrote the CR of the CRLFCRLF that marks the start of the
 * body, request_body() then found no body, and a correct password was reported
 * as wrong. Parsers that edit their input are how that keeps happening — see
 * also the note on request_path().
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

/* --------------------------------------------------------------- session --- *//* --------------------------------------------------------------- session --- */

/* Monotonic seconds. /proc/uptime is "SECS.FRAC IDLE"; the integer part is all
 * this needs, and it cannot go backwards the way a settable clock can. */
static long now_s(void)
{
	char buf[64];
	long v = 0;
	unsigned long i = 0;

	if (read_file("/proc/uptime", buf, sizeof(buf)) <= 0)
		return -1;
	while (buf[i] >= '0' && buf[i] <= '9') {
		v = v * 10 + (buf[i] - '0');
		i++;
	}
	return v;
}

static int rand_token(char *out)
{
	static const char hexd[] = "0123456789abcdef";
	unsigned char raw[TOKEN_HEX / 2];
	long fd = syscall3(__NR_open, (long)"/dev/urandom", 0, 0);
	unsigned long got = 0, i;

	if (fd < 0)
		return 0;
	while (got < sizeof(raw)) {
		long n = syscall3(__NR_read, fd, (long)(raw + got), sizeof(raw) - got);

		if (n <= 0)
			break;
		got += (unsigned long)n;
	}
	syscall3(__NR_close, fd, 0, 0);
	/* Short of a full token is a failure, not something to pad: a partly
	 * random session id is a guessable one. */
	if (got != sizeof(raw))
		return 0;

	for (i = 0; i < sizeof(raw); i++) {
		out[i * 2]     = hexd[(raw[i] >> 4) & 0xf];
		out[i * 2 + 1] = hexd[raw[i] & 0xf];
	}
	out[TOKEN_HEX] = 0;
	return 1;
}

/* Compare without an early exit, so timing does not leak a token prefix. */
static int tok_eq(const char *a, const char *b)
{
	unsigned long i;
	int diff = 0;

	for (i = 0; i < TOKEN_HEX; i++) {
		if (!a[i] || !b[i])
			return 0;
		diff |= (a[i] ^ b[i]);
	}
	return diff == 0;
}

static const char *session_new(void)
{
	long now = now_s();
	unsigned long i, slot = 0;
	long oldest = 0;

	/* Prefer a free or expired slot; otherwise evict the one closest to
	 * expiry, so a busy box cannot be locked out by stale sessions. */
	for (i = 0; i < SESSION_SLOTS; i++) {
		if (!sessions[i].tok[0] || sessions[i].expires <= now) {
			slot = i;
			goto take;
		}
		if (!oldest || sessions[i].expires < oldest) {
			oldest = sessions[i].expires;
			slot = i;
		}
	}
take:
	if (!rand_token(sessions[slot].tok)) {
		sessions[slot].tok[0] = 0;
		return 0;
	}
	sessions[slot].expires = now + SESSION_TTL;
	return sessions[slot].tok;
}

static int session_valid(const char *tok)
{
	long now = now_s();
	unsigned long i;

	if (!tok || !tok[0])
		return 0;
	for (i = 0; i < SESSION_SLOTS; i++) {
		if (!sessions[i].tok[0])
			continue;
		if (sessions[i].expires <= now) {
			sessions[i].tok[0] = 0;      /* reap on sight */
			continue;
		}
		if (tok_eq(sessions[i].tok, tok))
			return 1;
	}
	return 0;
}

static void session_kill(const char *tok)
{
	unsigned long i;

	if (!tok)
		return;
	for (i = 0; i < SESSION_SLOTS; i++)
		if (sessions[i].tok[0] && tok_eq(sessions[i].tok, tok))
			sessions[i].tok[0] = 0;
}

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

/* Value of a header, NUL-terminated in place, or 0. Case-insensitive name. */
static char *header(char *r, const char *name)
{
	unsigned long i = 0, n = slen(name);

	for (;;) {
		unsigned long k = 0;

		/* advance to the start of the next line */
		while (r[i] && r[i] != '\n')
			i++;
		if (!r[i])
			return 0;
		i++;
		if (!r[i])
			return 0;

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
			unsigned long v = i + k + 1, e;

			while (r[v] == ' ')
				v++;
			e = v;
			while (r[e] && r[e] != '\r' && r[e] != '\n')
				e++;
			r[e] = 0;
			return r + v;
		}
	}
}

/* The session token from the Cookie header, or 0 if there is not one. */
static int cookie_token(const char *r, char *out, unsigned long cap)
{
	char c[512];
	unsigned long i = 0, n;

	out[0] = 0;
	if (!header_copy(r, "cookie", c, sizeof(c)))
		return 0;
	for (;;) {
		while (c[i] == ' ' || c[i] == ';')
			i++;
		if (!c[i])
			return 0;
		if (spre(c + i, "sid=")) {
			i += 4;
			n = 0;
			while (c[i] && c[i] != ';' && c[i] != ' ' && n + 1 < cap)
				out[n++] = c[i++];
			out[n] = 0;
			return n > 0;
		}
		while (c[i] && c[i] != ';')
			i++;
	}
}

static int hexval(char c)
{
	if (c >= '0' && c <= '9') return c - '0';
	if (c >= 'a' && c <= 'f') return c - 'a' + 10;
	if (c >= 'A' && c <= 'F') return c - 'A' + 10;
	return -1;
}

/* One field out of an application/x-www-form-urlencoded body. */
static int form_field(const char *body, const char *name, char *out, unsigned long cap)
{
	unsigned long i = 0, n = slen(name), o = 0;

	out[0] = 0;
	for (;;) {
		if (spre(body + i, name) && body[i + n] == '=') {
			i += n + 1;
			while (body[i] && body[i] != '&' && o + 1 < cap) {
				char ch = body[i];

				if (ch == '+') {
					ch = ' ';
					i++;
				} else if (ch == '%' && body[i + 1] && body[i + 2]) {
					int va = hexval(body[i + 1]);
					int vb = hexval(body[i + 2]);

					/* A malformed escape is rejected outright
					 * rather than passed through as a literal
					 * '%', so a mangled field cannot silently
					 * become a different one. */
					if (va < 0 || vb < 0)
						return 0;
					ch = (char)((va << 4) | vb);
					i += 3;
				} else {
					i++;
				}
				out[o++] = ch;
			}
			out[o] = 0;
			return o > 0;
		}
		while (body[i] && body[i] != '&')
			i++;
		if (!body[i])
			return 0;
		i++;
	}
}

/*
 * Check submitted credentials against user:password in /etc/config/confd.auth.
 *
 * With no credential file the daemon refuses every login rather than running
 * open. An unauthenticated config UI on the LAN is a worse outcome than no
 * config UI, and "it stopped working" is a far better failure than "it let
 * anyone in".
 */
static int credentials_ok(const char *user, const char *pass)
{
	long want;
	unsigned long i, ul = slen(user), pl = slen(pass);
	int diff = 0;

    want = read_file(AUTH_PATH, credbuf, sizeof(credbuf));
	if (want <= 0)
		return 0;
	while (want > 0 && (credbuf[want - 1] == '\n' || credbuf[want - 1] == '\r'))
		credbuf[--want] = 0;
	if (want == 0)
		return 0;

	/* Rebuild "user:password" and compare the whole thing, so the split
	 * point cannot be moved by a colon in either field. */
	if (ul + 1 + pl != (unsigned long)want)
		diff = 1;
	for (i = 0; i < (unsigned long)want; i++) {
		char c;

		if (i < ul)
			c = user[i];
		else if (i == ul)
			c = ':';
		else if (i - ul - 1 < pl)
			c = pass[i - ul - 1];
		else
			c = 0;
		diff |= (c ^ credbuf[i]);
	}
	return diff == 0;
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

/* The schema TSV, as JSON rows. Comments and the header line are skipped. */
static void emit_schema_json(int fd, const char *buf)
{
	static const char *col[] = { "name", "store", "address", "section",
				     "type", "apply", "writable" };
	unsigned long i = 0;
	int first = 1;

	put_fd(fd, "[");
	while (buf[i]) {
		unsigned long ls = i, le = i, p, c;

		while (buf[le] && buf[le] != '\n')
			le++;

		if (buf[ls] == '#' || ls == le || spre(buf + ls, "name\t"))
			goto next;

		if (!first)
			put_fd(fd, ",");
		first = 0;
		put_fd(fd, "{");
		p = ls;
		for (c = 0; c < 7; c++) {
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

/*
 * Read a whole request, headers and body.
 *
 * One read is usually enough for a form POST, but "usually" is how a login
 * intermittently fails, so this keeps reading until Content-Length bytes of
 * body have arrived. Bounded by the buffer either way.
 */
static long read_request(int conn)
{
	long n, total = 0;
	char *body;
	long want;

	for (;;) {
		n = syscall3(__NR_read, conn, (long)(req + total),
			     (long)(sizeof(req) - 1 - (unsigned long)total));
		if (n <= 0)
			break;
		total += n;
		req[total] = 0;

		body = 0;
		{
			long i;

			for (i = 0; i + 3 < total; i++)
				if (req[i] == '\r' && req[i+1] == '\n' &&
				    req[i+2] == '\r' && req[i+3] == '\n') {
					body = req + i + 4;
					break;
				}
		}
		if (!body)
			continue;               /* headers not complete yet */

		{
			char cl[32];
			long have = total - (long)(body - req);
			unsigned long k;

			want = 0;
			if (header_copy(req, "content-length", cl, sizeof(cl)))
				for (k = 0; cl[k] >= '0' && cl[k] <= '9'; k++)
					want = want * 10 + (cl[k] - '0');
			if (have >= want)
				break;
		}
		if ((unsigned long)total + 1 >= sizeof(req))
			break;
	}
	return total;
}

static char *request_body(char *r)
{
	unsigned long i;

	for (i = 0; r[i]; i++)
		if (r[i] == '\r' && r[i+1] == '\n' && r[i+2] == '\r' && r[i+3] == '\n')
			return r + i + 4;
	return r + slen(r);
}

static void set_cookie(int conn, const char *tok, int clear)
{
	/* HttpOnly keeps it away from script, SameSite=Strict keeps another
	 * origin from riding it. No Secure flag: there is no TLS on this device,
	 * and setting it would simply stop the cookie working. */
	put_fd(conn, "Set-Cookie: sid=");
	put_fd(conn, clear ? "" : tok);
	put_fd(conn, "; Path=/; HttpOnly; SameSite=Strict; Max-Age=");
	put_fd(conn, clear ? "0" : "3600");
	put_fd(conn, "\r\n");
}

static void serve(int conn)
{
	char *path, *method, *body;
	char tok[TOKEN_HEX + 8];
	char user[64], pass[128];
	long n;
	int authed;

	n = read_request(conn);
	if (n <= 0)
		return;

	/* Cookie and body are read out BEFORE parsing the request line, because
	 * request_path() NUL-terminates the method in place and the first of
	 * those NULs stops any later header scan dead. */
	authed = cookie_token(req, tok, sizeof(tok)) && session_valid(tok);
	body = request_body(req);

	path = request_path(req, &method);
	if (!path) {
		respond(conn, "400 Bad Request", "text/plain", 0);
		return;
	}

	/* ---- login and logout, the only routes reachable unauthenticated --- */

	if (seq(path, "/api/login")) {
		if (!seq(method, "POST")) {
			respond(conn, "405 Method Not Allowed", "text/plain", "Allow: POST\r\n");
			return;
		}
		if (!form_field(body, "user", user, sizeof(user)) ||
		    !form_field(body, "pass", pass, sizeof(pass)) ||
		    !credentials_ok(user, pass)) {
			/* Delay before answering a bad login. Without it the only
			 * limit on guessing is how fast the device answers, which
			 * measured 319 attempts/sec. This server is single
			 * threaded and serial, so the sleep is a hard global rate
			 * limit rather than a per-connection one. */
			sleep_s(1);
			respond(conn, "303 See Other", "text/html", "Location: /?bad=1\r\n");
			return;
		}
		{
			const char *t = session_new();

			if (!t) {
				respond(conn, "500 Internal Server Error", "text/plain", 0);
				put_fd(conn, "could not allocate a session\n");
				return;
			}
			put_fd(conn, "HTTP/1.0 303 See Other\r\nLocation: /\r\n"
				     "Cache-Control: no-store\r\nConnection: close\r\n");
			set_cookie(conn, t, 0);
			put_fd(conn, "\r\n");
		}
		return;
	}

	if (seq(path, "/api/logout")) {
		session_kill(tok);
		put_fd(conn, "HTTP/1.0 303 See Other\r\nLocation: /\r\n"
			     "Cache-Control: no-store\r\nConnection: close\r\n");
		set_cookie(conn, "", 1);
		put_fd(conn, "\r\n");
		return;
	}

	/* Stylesheet is served unauthenticated so the login page is not naked.
	 * It carries nothing worth protecting. */
	if (seq(path, "/style.css")) {
		serve_static(conn, "style.css", "text/css");
		return;
	}

	if (!authed) {
		/* A browser navigating gets the login form; the API says 401 so
		 * the app can tell an expired session from a broken request. */
		if (spre(path, "/api/")) {
			respond(conn, "401 Unauthorized", "application/json", 0);
			put_fd(conn, "{\"error\":\"no session\"}");
		} else {
			serve_static(conn, "login.html", "text/html; charset=utf-8");
		}
		return;
	}

	/* ---- authenticated from here ------------------------------------- */

	/* Phase 1 is read only, so anything that is not a GET is refused here
	 * rather than in each route. */
	if (!seq(method, "GET")) {
		respond(conn, "405 Method Not Allowed", "text/plain", "Allow: GET\r\n");
		return;
	}

	if (seq(path, "/api/schema")) {
		if (read_file(SCHEMA_PATH_OVR, schema, sizeof(schema)) <= 0 &&
		    read_file(SCHEMA_PATH, schema, sizeof(schema)) <= 0) {
			respond(conn, "500 Internal Server Error", "application/json", 0);
			put_fd(conn, "{\"error\":\"no schema\"}");
			return;
		}
		respond(conn, "200 OK", "application/json", 0);
		emit_schema_json(conn, schema);
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
