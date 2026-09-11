/*
 * The HTTP layer: reading a request safely, deciding whether to answer it, and
 * the two ways bytes leave -- a response header and a static file.
 *
 * Everything here treats the request as hostile input, and the ordering rule in
 * http.h is not optional: request_path edits its input in place, so header_copy
 * and request_body must run BEFORE it, never after.
 */

#include "confd.h"
#include "buffers.h"
#include "http.h"

/* ------------------------------------------------------------------ HTTP --- */

void respond(int fd, const char *status_line, const char *ctype,
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
char *request_path(char *r, char **method)
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

char *request_body(char *r)
{
	unsigned long i;

	for (i = 0; r[i]; i++)
		if (r[i] == '\r' && r[i+1] == '\n' && r[i+2] == '\r' && r[i+3] == '\n')
			return r + i + 4;
	return r + slen(r);
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
int header_copy(const char *r, const char *name, char *out, unsigned long cap)
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
 * Read a whole request: the headers, then exactly Content-Length bytes of body.
 *
 * One read() is not a request. TCP is a byte stream, and a browser routinely
 * puts the headers in one segment and the body in the next -- so a POST arrived
 * with an empty body and handle_write answered {"results":[],"apply":"none"},
 * reporting no error and writing nothing.
 *
 * The truncation case was worse. A body larger than req[] was cut mid-value,
 * url_decode accepted the fragment, write_key wrote it, and the read-back then
 * compared the fragment against ITSELF and reported ok:true. Every guard in the
 * write path was satisfied by a value the user never typed. A request that does
 * not fit is therefore refused outright, not trimmed.
 *
 * Returns the byte count, -1 if the peer gave up mid-request, -2 if it does not
 * fit.
 */
long read_request(int conn, char *buf, unsigned long cap)
{
	unsigned long got = 0, hdr = 0, want = 0;
	int have_hdr = 0;

	for (;;) {
		long n;
		unsigned long i;

		if (have_hdr && got >= hdr + want)
			return (long)got;
		if (got + 1 >= cap)
			return REQ_TOO_LARGE;

		n = syscall3(__NR_read, conn, (long)(buf + got), cap - got - 1);
		if (n <= 0)
			return REQ_INCOMPLETE;
		got += (unsigned long)n;
		buf[got] = 0;

		if (have_hdr)
			continue;

		for (i = 0; i + 3 < got; i++) {
			if (buf[i] == '\r' && buf[i + 1] == '\n' &&
			    buf[i + 2] == '\r' && buf[i + 3] == '\n') {
				have_hdr = 1;
				hdr = i + 4;
				break;
			}
		}
		if (!have_hdr)
			continue;

		/* A GET has no Content-Length and wants nothing more. An absent
		 * or unparsable header is treated as zero rather than guessed
		 * at: a body we were not told the length of is one we cannot
		 * know we have all of. */
		if (header_copy(buf, "content-length", hdrbuf, sizeof(hdrbuf))) {
			unsigned long v = 0, k;

			for (k = 0; hdrbuf[k]; k++) {
				if (hdrbuf[k] < '0' || hdrbuf[k] > '9') {
					v = 0;
					break;
				}
				v = v * 10 + (unsigned long)(hdrbuf[k] - '0');
				if (v > cap)
					return REQ_TOO_LARGE;
			}
			want = v;
		}
		/* Reject an oversized body before reading it rather than after. */
		if (hdr + want + 1 > cap)
			return REQ_TOO_LARGE;
	}
}

/*
 * Reject a cross-site write.
 *
 * HTTP Basic has no session and no token: the browser replays the credential on
 * every request to this host, including one triggered by a page on some other
 * site. Without this, any page the operator visits can POST to /api/firmware
 * with action=reboot, or to /api/config with _confirm=identity. A urlencoded
 * form POST is a CORS-simple request, so there is no preflight to stop it, and
 * the attacker not being able to READ the reply does not matter -- every one of
 * those routes is a write.
 *
 * The test is Origin-when-present. Every current browser sends Origin on a
 * cross-origin POST, form submissions included, so the attack is blocked; curl
 * and the repo's own scripts send none and keep working. That asymmetry is the
 * point -- a check that demanded a header would break every non-browser client
 * for no gain, since an attacker who can set arbitrary headers is not doing CSRF
 * in the first place.
 */
int same_origin(const char *r)
{
	char origin[256], host[128];
	const char *o = origin;

	if (!header_copy(r, "origin", origin, sizeof(origin)))
		return 1;                  /* not a browser-initiated write */
	if (!header_copy(r, "host", host, sizeof(host)))
		return 0;

	if (spre(o, "http://"))
		o += 7;
	else if (spre(o, "https://"))
		o += 8;
	else
		return 0;                  /* "null", or something exotic */

	return seq(o, host);
}

/*
 * Load the expected credential into credbuf.
 *
 * /etc/config/confd.auth when it has content, DEFAULT_AUTH otherwise. Returns
 * its length; sets *is_default when the fallback was used.
 *
 * A file that exists but is empty counts as absent. That is not pedantry: the
 * obvious way to clear a password is to truncate the file, and treating the
 * result as "no credential accepted" would lock the operator out of the device
 * they were trying to change the password on.
 */
static long load_credential(int *is_default)
{
	long want = read_file(AUTH_PATH, credbuf, sizeof(credbuf));
	unsigned long k;

	if (want > 0) {
		/* trim trailing newline/CR so an editor-written file works */
		while (want > 0 && (credbuf[want - 1] == '\n' || credbuf[want - 1] == '\r'))
			credbuf[--want] = 0;
	}
	if (want > 0) {
		if (is_default)
			*is_default = 0;
		return want;
	}

	for (k = 0; DEFAULT_AUTH[k] && k + 1 < sizeof(credbuf); k++)
		credbuf[k] = DEFAULT_AUTH[k];
	credbuf[k] = 0;
	if (is_default)
		*is_default = 1;
	return (long)k;
}

/*
 * Whether the credential in force IS the built-in default.
 *
 * Deliberately not "is the file missing": a file containing admin:admin leaves
 * you on the default password while making the warning go away, which is the
 * worst of both. The question the page needs answered is "is this stick on the
 * credential everybody knows", and that is this.
 */
int auth_is_default(void)
{
	long want = load_credential(0);
	unsigned long i;

	for (i = 0; DEFAULT_AUTH[i]; i++)
		if ((long)i >= want || credbuf[i] != DEFAULT_AUTH[i])
			return 0;
	return want == (long)i;
}

/*
 * Write a new credential file.
 *
 * Constrained, not sanitised: a value that does not fit the file format is
 * refused rather than rewritten into one that does. The file is one line of
 * `user:password`, so the username cannot contain a colon and neither half can
 * contain a newline -- a credential mangled on the way in is one nobody can
 * log in with afterwards, on a device where "afterwards" may mean a site visit.
 */
int set_credential(const char *user, const char *pass, const char **why)
{
	unsigned long u = 0, p = 0, n = 0;

	for (u = 0; user[u]; u++) {
		if (user[u] == ':') {
			*why = "the username cannot contain a colon";
			return 0;
		}
		if (user[u] < 0x21 || user[u] > 0x7e) {
			*why = "the username must be printable, with no spaces";
			return 0;
		}
	}
	if (!u || u > 64) {
		*why = "the username must be 1 to 64 characters";
		return 0;
	}

	for (p = 0; pass[p]; p++) {
		if (pass[p] < 0x20 || pass[p] > 0x7e) {
			*why = "the password must be printable ASCII";
			return 0;
		}
	}
	if (p < 4 || p > 128) {
		*why = "the password must be 4 to 128 characters";
		return 0;
	}
	if (u + 1 + p + 1 > sizeof(credbuf)) {
		*why = "too long";
		return 0;
	}

	for (n = 0; n < u; n++)
		credbuf[n] = user[n];
	credbuf[n++] = ':';
	for (p = 0; pass[p]; p++)
		credbuf[n++] = pass[p];
	credbuf[n] = 0;

	/* 0600: the file sits in /etc/config next to the device identity, and
	 * this daemon is not the only thing that can read that directory. */
	if (write_file(AUTH_PATH, credbuf, n, 0600) < 0) {
		*why = "could not write /etc/config/confd.auth";
		return 0;
	}
	*why = 0;
	return 1;
}

/*
 * HTTP Basic, against user:password in /etc/config/confd.auth -- or against
 * DEFAULT_AUTH when that file has never been written. See confd.h for why the
 * fallback exists rather than a refusal, and note that it is a fallback to a
 * WEAKER credential, not to none: every request is still checked, the
 * comparison is still constant-time, and a failure still costs a second.
 */
int authorised(const char *r)
{
	long n, want;
	unsigned long i = 0;
	int diff = 0;

	want = load_credential(0);
	if (want <= 0)
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

/*
 * Decode one application/x-www-form-urlencoded token, stopping at `stop`.
 * Returns the index just past what it consumed, or 0 on a malformed escape —
 * rejected rather than passed through, so a mangled field cannot quietly become
 * a different one.
 */
unsigned long url_decode(const char *in, unsigned long i, char stop,
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
int form_get(const char *body, const char *want, char *out, unsigned long cap)
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

/* Serve a static file, preferring the /etc/config override. */
void serve_static(int fd, const char *name, const char *ctype)
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
 * Every asset, in one list. Adding a module to the UI is a line here and a file
 * in web/ -- and scripts/check-assets.py asserts those two agree, because a
 * file with no row is dead weight on a jffs2 partition that is already half
 * spent, and a row with no file is a 404 nobody notices until the page is
 * blank.
 */
const struct web_asset web_assets[] = {
	{ "/",              "index.html",  "text/html; charset=utf-8" },
	{ "/index.html",    "index.html",  "text/html; charset=utf-8" },
	{ "/style.css",     "style.css",   "text/css" },
	{ "/app.js",        "app.js",      "application/javascript" },
	{ "/dom.js",        "dom.js",      "application/javascript" },
	{ "/state.js",      "state.js",    "application/javascript" },
	{ "/status.js",     "status.js",   "application/javascript" },
	{ "/flow.js",       "flow.js",     "application/javascript" },
	{ "/validate.js",   "validate.js", "application/javascript" },
	{ "/config.js",     "config.js",   "application/javascript" },
	{ "/save.js",       "save.js",     "application/javascript" },
	{ "/firmware.js",   "firmware.js", "application/javascript" },
	{ "/omci.js",       "omci.js",     "application/javascript" },
	{ "/services.js",   "services.js", "application/javascript" },
	{ "/mebrowser.js",  "mebrowser.js", "application/javascript" },
	{ "/restore.js",    "restore.js",  "application/javascript" },
	{ "/l2.js",         "l2.js",       "application/javascript" },
	{ "/tools.js",      "tools.js",    "application/javascript" },
	{ 0, 0, 0 },
};

int serve_asset(int fd, const char *path)
{
	unsigned long i;

	for (i = 0; web_assets[i].url; i++) {
		if (!seq(path, web_assets[i].url))
			continue;
		/* The table's own literal, never the request. */
		serve_static(fd, web_assets[i].file, web_assets[i].ctype);
		return 1;
	}
	return 0;
}
