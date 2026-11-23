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
#include "sha256.h"

/* ------------------------------------------------------------------ HTTP --- */

/*
 * HTTP/1.1, with Connection: close on every answer, so the body ends where the
 * connection does and no Content-Length is needed. Keep-alive is not offered:
 * this server is serial, and a browser holding an idle connection open would
 * block every other request for as long as it kept it.
 */
static void respond_head(int fd, const char *status_line, const char *ctype,
			 const char *cache, const char *extra)
{
	put_fd(fd, "HTTP/1.1 ");
	put_fd(fd, status_line);
	put_fd(fd, "\r\nContent-Type: ");
	put_fd(fd, ctype);
	put_fd(fd, "\r\nCache-Control: ");
	put_fd(fd, cache);
	put_fd(fd, "\r\nConnection: close\r\n");
	/*
	 * What a browser is told about this page, on every response. The page
	 * must never be framed (a framed copy is a button an attacker can place
	 * under the operator pointer: reboot, add an ssh key), never sniffed
	 * into something else, and never leaks its address in a Referer.
	 * No `default-src`: index.html has one inline script (the theme, which
	 * has to run before first paint) and a script-src policy would block it.
	 */
	put_fd(fd, "X-Content-Type-Options: nosniff\r\n"
		   "X-Frame-Options: DENY\r\n"
		   "Referrer-Policy: no-referrer\r\n"
		   "Content-Security-Policy: frame-ancestors 'none'; base-uri 'none'; "
		   "form-action 'self'; object-src 'none'\r\n");
	if (extra)
		put_fd(fd, extra);
	put_fd(fd, "\r\n");
}

void respond(int fd, const char *status_line, const char *ctype,
		    const char *extra)
{
	respond_head(fd, status_line, ctype, "no-store", extra);
}

/*
 * Revalidation for what changes only with the image: the web assets and the
 * files behind /api/schema, meta, consumers and the like. The browser keeps
 * them and asks again on every load (no-cache), and an unchanged one costs a
 * 304 with no body. Measured on the stick, those bodies were most of the bytes
 * a page load sent.
 *
 * The tag is FNV-1a over the confd build and the bytes the answer is made
 * from, not a file date: the jffs2 and squashfs dates on the stick say nothing,
 * and a bind-mounted test file must not look unchanged. `private` keeps it out
 * of any shared cache. What the device holds (values, status) stays no-store.
 *
 * inm is copied at the top of serve(): by the time a route answers,
 * request_path has cut the headers short.
 */
static char inm[24];

void note_cache_request(const char *r)
{
	header_copy(r, "if-none-match", inm, sizeof(inm));
}

unsigned long etag_add(unsigned long h, const char *b, unsigned long len)
{
	unsigned long i;

	for (i = 0; i < len; i++)
		h = ((h ^ (unsigned char)b[i]) * 16777619UL) & 0xffffffffUL;
	return h;
}

unsigned long etag_start(void)
{
	static const char build[] = BUILD_ID;

	return etag_add(2166136261UL, build, sizeof(build) - 1);
}

int respond_tagged(int fd, const char *ctype, unsigned long h)
{
	static const char hexd[] = "0123456789abcdef";
	char tag[11], hdr[32];
	unsigned long i, n = 0;

	tag[0] = '"';
	for (i = 0; i < 8; i++)
		tag[1 + i] = hexd[(h >> (28 - 4 * i)) & 0xf];
	tag[9] = '"';
	tag[10] = 0;

	for (i = 0; "ETag: "[i]; i++)
		hdr[n++] = "ETag: "[i];
	for (i = 0; tag[i]; i++)
		hdr[n++] = tag[i];
	hdr[n++] = '\r';
	hdr[n++] = '\n';
	hdr[n] = 0;

	if (seq(inm, tag)) {
		respond_head(fd, "304 Not Modified", ctype, "private, no-cache", hdr);
		return 1;
	}
	respond_head(fd, "200 OK", ctype, "private, no-cache", hdr);
	return 0;
}

int respond_cached(int fd, const char *ctype, const char *body, unsigned long len)
{
	return respond_tagged(fd, ctype, etag_add(etag_start(), body, len));
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

/* Whether two characters are the same letter, whatever the case. */
static int lower_eq(char a, char b)
{
	if (a >= 'A' && a <= 'Z')
		a = (char)(a - 'A' + 'a');
	if (b >= 'A' && b <= 'Z')
		b = (char)(b - 'A' + 'a');
	return a == b;
}

/*
 * The next header named `name` (lower case, with its colon) at or after
 * offset i: the offset of what follows the colon, or 0 when there is none.
 * Start with i = 0; the request line is stepped over.
 *
 * Every occurrence, and by the name alone. header_copy answers for the
 * first one only and says "absent" for one with an empty value, which is
 * right for a header that is looked up and wrong for one whose presence
 * alone decides how the body is read.
 */
static unsigned long header_next(const char *r, unsigned long i, const char *name)
{
	for (;;) {
		unsigned long k = 0;

		while (r[i] && r[i] != '\n')
			i++;
		if (!r[i++] || !r[i] || r[i] == '\r' || r[i] == '\n')
			return 0;              /* end of headers */
		while (name[k] && lower_eq(r[i + k], name[k]))
			k++;
		if (!name[k])
			return i + k;
	}
}

/*
 * The declared length of the body: 1 and the value (0 with no Content-Length
 * at all), or 0 when the header is not a number.
 *
 * The value used to be read with header_copy, and anything that was not a
 * digit made it 0: `Content-Length: abc`, an empty value, `+5`, `5, 6`. The
 * request was then served as one with no body, and what the client sent as
 * the body was not read. For a write that is the failure read_request exists
 * to prevent, a POST answered as if it had said nothing. header_copy also
 * stops at the first header of that name, so of two that disagree the first
 * was believed and the second never seen; which of them the client meant is
 * not something to guess at (RFC 9112, 6.3). All of that is a 400 now.
 *
 * Accepted: one or more digits, with spaces or tabs around them, and then
 * the end of the line, CRLF or LF. A CR that is not followed by LF is not
 * the end of a line: what comes after it would have gone unread. A header
 * repeated with the same value is one value.
 *
 * A number above MAX_BODY is still a number: it is cut to MAX_BODY + 1 as
 * before, which no route accepts, and answered 413 rather than 400, since
 * the request was well formed and only too big. The digits after the cut
 * are still checked. Two headers are compared as the digits they are,
 * leading zeros aside, and not as the numbers after the cut: two lengths
 * that are both too large and are not the same disagree like any others.
 */
static int content_length(const char *r, unsigned long *out)
{
	unsigned long i = 0, v = 0, first = 0, flen = 0;

	*out = 0;
	while ((i = header_next(r, i, "content-length:")) != 0) {
		unsigned long one = 0, at, len, k;

		while (r[i] == ' ' || r[i] == '\t')
			i++;
		if (r[i] < '0' || r[i] > '9')
			return 0;
		while (r[i] == '0' && r[i + 1] >= '0' && r[i + 1] <= '9')
			i++;
		for (at = i; r[i] >= '0' && r[i] <= '9'; i++)
			if (one <= MAX_BODY)
				one = one * 10 + (unsigned long)(r[i] - '0');
		len = i - at;
		if (one > MAX_BODY)
			one = MAX_BODY + 1;
		while (r[i] == ' ' || r[i] == '\t')
			i++;
		if (r[i] == '\r')
			i++;
		if (r[i] != '\n')
			return 0;
		if (flen) {
			if (len != flen)
				return 0;
			for (k = 0; k < len; k++)
				if (r[first + k] != r[at + k])
					return 0;
		}
		first = at;
		flen = len;
		v = one;
	}
	*out = v;
	return 1;
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
 * Returns the byte count, or a REQ_* code: the peer gave up mid-request, the
 * headers do not fit, the length of the body is not stated in a way that can
 * be trusted, or the body is in a framing this server does not read.
 */
long read_request(int conn, char *buf, unsigned long cap,
		  unsigned long *body_have, unsigned long *body_want)
{
	unsigned long got = 0, hdr = 0, want = 0;
	unsigned long t0 = mono_ms();
	int have_hdr = 0;

	*body_have = 0;
	*body_want = 0;

	for (;;) {
		long n;
		unsigned long i;

		/*
		 * Stop as soon as the whole body is in, OR as soon as it is
		 * known it cannot be. The second case is what makes the upload
		 * route's size guard a real pre-body check: without it this
		 * went on filling the buffer first, so a request DECLARING
		 * 20 MB while sending sixteen bytes blocked here for the full
		 * socket timeout and the guard was never reached at all.
		 *
		 * It also means an oversized body on any other route is
		 * refused the moment the headers are read, rather than after
		 * 16 KB of it has been taken.
		 */
		if (have_hdr && (got >= hdr + want || hdr + want + 1 > cap)) {
			/*
			 * The body is the bytes Content-Length names and
			 * ends there, whatever else the read brought in. The
			 * routes parse the body as a string, so anything
			 * left after it was parsed with it: fields beyond
			 * the declared length, or a whole body under a
			 * length of 0, applied or not by how TCP had cut
			 * the segments.
			 */
			if (got > hdr + want) {
				got = hdr + want;
				buf[got] = 0;
			}
			*body_have = got - hdr;
			*body_want = want;
			return (long)got;
		}
		/* The HEADERS not fitting is still fatal: there is no route
		 * that wants a request line this daemon could not parse. */
		if (!have_hdr && got + 1 >= cap)
			return REQ_TOO_LARGE;

		/* The sum of the waits is bounded, not just each one: see
		 * REQUEST_DEADLINE_MS. */
		{
			long left = REQUEST_DEADLINE_MS - (long)(mono_ms() - t0);

			if (left <= 0 || !wait_readable(conn, left))
				return REQ_INCOMPLETE;
		}
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
		 * header is zero rather than guessed at: a body we were not told
		 * the length of is one we cannot know we have all of. One that
		 * is there and is not a number is refused, see content_length(). */
		if (!content_length(buf, &want))
			return REQ_BAD_LENGTH;
		/*
		 * A body sent with Transfer-Encoding is not read here: there
		 * is no chunk parser, and none is wanted for a page and a few
		 * scripts that all send Content-Length. Left alone, such a
		 * request was taken as one with no body, or, with a
		 * Content-Length beside it, the chunk framing was handed to
		 * the route as if it were the form. The header is refused
		 * whatever it names: 501 is what RFC 9112 6.1 asks for a
		 * transfer coding the server does not implement. By its
		 * name, anywhere in the headers: an empty first one must
		 * not hide a second that says chunked.
		 */
		if (header_next(buf, 0, "transfer-encoding:"))
			return REQ_UNSUPPORTED;
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
 * Whether `host` (a Host header, port allowed) is one a browser could only
 * have reached by addressing this stick on the LAN.
 *
 * DNS rebinding is a web page that answers a name it owns first with its own
 * server and then with the stick's address: the browser then treats the stick
 * as that page's own origin, so the Origin check above passes (Origin and
 * Host are both the attacker's name) and the page can read and write
 * everything. What it cannot do is make the browser send an IP literal or a
 * name it does not own as the Host, so the defence is to answer only those:
 *
 *   - an IP literal, v4 or bracketed v6;
 *   - a single label (no dot): `odi`, `localhost`, a search-domain name;
 *   - the suffixes that are private by convention and cannot be registered:
 *     .local .lan .localdomain .home.arpa .internal .localhost .home;
 *   - a name listed in /etc/config/confd.hosts, one per line, for a site that
 *     gives the stick a public-looking name in its own DNS.
 *
 * A trailing dot (`stick.`) is not a single label and is refused on purpose:
 * it is how a browser is told "this is already fully qualified".
 */
static int name_ends(const char *name, unsigned long n, const char *suffix)
{
	unsigned long sl = slen(suffix), k;

	if (n < sl)
		return 0;
	for (k = 0; k < sl; k++)
		if (!lower_eq(name[n - sl + k], suffix[k]))
			return 0;
	return 1;
}

static int host_listed(const char *name, unsigned long n)
{
	char list[1024];
	unsigned long i = 0;
	long got = read_file(HOSTS_PATH, list, sizeof(list));

	if (got <= 0)
		return 0;
	while (list[i]) {
		unsigned long ls = i, le = i, k = 0;

		while (list[le] && list[le] != '\n' && list[le] != '\r')
			le++;
		if (le - ls == n) {
			while (k < n && lower_eq(list[ls + k], name[k]))
				k++;
			if (k == n)
				return 1;
		}
		i = le;
		while (list[i] == '\n' || list[i] == '\r')
			i++;
	}
	return 0;
}

static int host_ok(const char *host)
{
	static const char *const suffix[] = { ".local", ".lan", ".localdomain",
		".home.arpa", ".internal", ".localhost", ".home", 0 };
	unsigned long n = 0, i;
	int dots = 0, alldigit = 1;

	if (host[0] == '[') {
		/* IPv6 literal: hex, colons and dots between the brackets. */
		for (i = 1; host[i] && host[i] != ']'; i++)
			if (hexval(host[i]) < 0 && host[i] != ':' && host[i] != '.')
				return 0;
		return host[i] == ']' && i > 2;
	}
	while (host[n] && host[n] != ':')
		n++;
	if (!n)
		return 0;
	for (i = 0; i < n; i++) {
		if (host[i] == '.')
			dots++;
		else if (host[i] < '0' || host[i] > '9')
			alldigit = 0;
	}
	if (alldigit && dots == 3)
		return 1;
	if (!dots)
		return 1;
	for (i = 0; suffix[i]; i++)
		if (name_ends(host, n, suffix[i]))
			return 1;
	return host_listed(host, n);
}

/*
 * The checks that apply to every request, authenticated or not, before the
 * credential is even looked at: 0 when the request is fine, else the reason
 * (a plain-text line for the 403).
 *
 * Sec-Fetch-Site is sent by every current browser and by nothing else. A
 * cross-site or same-site value means a page that is not this one caused the
 * request. The Origin check covers writes; this is what stops a GET from a
 * foreign page, such as the diagnostics bundle, which holds the only thread
 * for up to a minute.
 */
/* Offset of the request target in "METHOD target HTTP/x"; read only. */
static unsigned long path_off(const char *r)
{
	unsigned long i = 0;

	while (r[i] && r[i] != ' ' && r[i] != '\r' && r[i] != '\n')
		i++;
	return r[i] == ' ' ? i + 1 : i;
}

int request_target(const char *r, char *out, unsigned long cap)
{
	unsigned long i = path_off(r), o = 0;

	while (r[i] && r[i] != ' ' && r[i] != '?' && r[i] != '\r' && r[i] != '\n') {
		if (o + 1 >= cap) {
			out[0] = 0;
			return 0;
		}
		out[o++] = r[i++];
	}
	out[o] = 0;
	return o > 0;
}

/* See http.h. */
int header_present(const char *r, const char *name)
{
	return header_next(r, 0, name) != 0;
}

int header_has(const char *r, const char *name, const char *needle)
{
	char v[512];
	unsigned long i, k, n = slen(needle);

	if (!header_copy(r, name, v, sizeof(v)))
		return 0;
	for (i = 0; v[i]; i++) {
		for (k = 0; k < n && v[i + k] == needle[k]; k++)
			;
		if (k == n)
			return 1;
	}
	return 0;
}

const char *request_refusal(const char *r)
{
	char host[128], site[32], mode[16], dest[16];

	/*
	 * header_copy cuts a value that does not fit, and a cut Host can look
	 * like something else: 127 characters of one long label, or a prefix
	 * ending in ".lan", with the attacker's own domain after the cut. A
	 * Host that fills the buffer is refused, never judged by its prefix.
	 */
	if (header_copy(r, "host", host, sizeof(host)) &&
	    (slen(host) + 1 >= sizeof(host) || !host_ok(host)))
		return "this name is not one for this stick; open it by its IP address "
		       "or list the name in /etc/config/confd.hosts\n";
	if (header_copy(r, "sec-fetch-site", site, sizeof(site)) &&
	    (seq(site, "cross-site") || seq(site, "same-site"))) {
		/*
		 * A link followed from another page is a top-level navigation
		 * and is the operator acting: the UI itself offers one, to the
		 * stick new address after a move, and that is cross-site by
		 * definition. A fetch, an image, a script or a frame is not.
		 * Never for /api/: a followed link has no business there, and
		 * it is where the work and the data are.
		 */
		if (!spre(r + path_off(r), "/api/") &&
		    header_copy(r, "sec-fetch-mode", mode, sizeof(mode)) &&
		    header_copy(r, "sec-fetch-dest", dest, sizeof(dest)) &&
		    seq(mode, "navigate") && seq(dest, "document"))
			return 0;
		return "cross-site request refused\n";
	}
	return 0;
}

/* ----------------------------------------------------------- credential --- */

/*
 * The credential file holds one line, in one of two forms:
 *
 *   user:$pbkdf2-sha256$<iterations>$<salt>$<hash>     what confd writes
 *   user:password                                      what a person writes
 *
 * <iterations> is decimal, 1 to PBKDF2_ITER_MAX; <salt> is 16 bytes and
 * <hash> 32 bytes, both in hex; the hash is PBKDF2-HMAC-SHA256 of the
 * password with that salt and count. The username is not hashed: it is not
 * the secret, and password_matches() needs it.
 *
 * Why a hash: the file was the password, readable by everything that reads
 * /etc/config (a backup of the partition, a support bundle before its
 * scrub, any process on the stick), and people use a password in more than
 * one place. Why PBKDF2: it is SHA-256 in a loop, about 3 KB of code and a
 * few hundred bytes of stack. scrypt and argon2 are better because they
 * need memory, megabytes of it, on a stick with under 2 MB free.
 *
 * Why the second form stays, for good: docs/DESIGN.md tells the operator to
 * write the file by hand over ssh, with printf, and a stick updated from a
 * release that stored the password as typed has such a file. Refusing it
 * is a lockout at a remote site. A file in that form is replaced by the
 * hashed one at the first sign-in that proves the password, see migrate().
 *
 * A password that itself begins with $pbkdf2-sha256$ cannot be written by
 * hand in the second form. set_credential() stores any password hashed, so
 * the page has no such limit.
 */
#define HASH_TAG "$pbkdf2-sha256$"
#define SALT_LEN 16
/* What a new line starts with after `user:`. The count is pasted in as
 * text, which is why PBKDF2_ITER is a plain decimal number. */
#define HASH_STR_(x) #x
#define HASH_STR(x) HASH_STR_(x)
#define HASH_HEAD HASH_TAG HASH_STR(PBKDF2_ITER) "$"
/*
 * The longest line, typed or hashed, that is read and that is written: one
 * number for both. read_file leaves a byte for the NUL and cannot tell a
 * file that fills the rest from a longer one, so the most that is known to
 * be whole is two bytes short of the buffer. A line confd wrote and could
 * not read back is a stick nobody signs in to: a username of 136 characters
 * typed into the file made a hashed line of exactly 255 bytes.
 */
#define CRED_MAX (sizeof(credbuf) - 2)
/* A hashed line without its username. */
#define HASH_ROOM (1 + sizeof(HASH_HEAD) - 1 + 2 * SALT_LEN + 1 + 2 * SHA256_LEN)
_Static_assert(64 + HASH_ROOM <= CRED_MAX,
	       "the longest username set_credential takes must hash to a line that is read");
_Static_assert(PBKDF2_ITER >= 1 && PBKDF2_ITER <= PBKDF2_ITER_MAX,
	       "a line confd writes must be one confd reads");

struct cred {
	unsigned long ulen;      /* the username is line[0..ulen); the line
				  * length when it has no colon */
	unsigned long iter;      /* 0: user:password as typed */
	unsigned char salt[SALT_LEN];
	unsigned char hash[SHA256_LEN];
};

/* The line in credbuf, taken apart by load_credential(). */
static struct cred cred;

static int hex_bytes(const char *in, unsigned char *out, unsigned long n)
{
	unsigned long k;

	for (k = 0; k < n; k++) {
		int hi = hexval(in[2 * k]), lo = hi < 0 ? -1 : hexval(in[2 * k + 1]);

		if (lo < 0)
			return 0;
		out[k] = (unsigned char)((hi << 4) | lo);
	}
	return 1;
}

/*
 * Take a credential line apart. 0 when it cannot be used.
 *
 * A line that starts like a hash and is not a whole one is refused, not
 * read as the second form: read that way, the text in the file would be the
 * password, and whoever has seen the file could sign in with it. Not the
 * default credential either, for the reason load_credential() gives for a
 * file it cannot read. So is a count of 0 or above PBKDF2_ITER_MAX: the
 * daemon is one thread, and a count with three more digits would hold every
 * request for minutes each time a password is tried.
 */
static int cred_parse(const char *line, unsigned long n, struct cred *c)
{
	unsigned long i = 0, v = 0;
	const char *p;

	c->iter = 0;
	while (i < n && line[i] != ':')
		i++;
	c->ulen = i;
	if (i == n || !spre(line + i + 1, HASH_TAG))
		return 1;
	p = line + i + sizeof(HASH_TAG);
	for (i = 0; i < 7 && p[i] >= '0' && p[i] <= '9'; i++)
		v = v * 10 + (unsigned long)(p[i] - '0');
	if (v < 1 || v > PBKDF2_ITER_MAX || p[i] != '$')
		return 0;
	p += i + 1;
	if (!hex_bytes(p, c->salt, SALT_LEN) || p[2 * SALT_LEN] != '$' ||
	    !hex_bytes(p + 2 * SALT_LEN + 1, c->hash, SHA256_LEN) ||
	    p + 2 * SALT_LEN + 1 + 2 * SHA256_LEN != line + n)
		return 0;
	c->iter = v;
	return 1;
}

/*
 * What has been worked out about the line in credbuf, kept while that line
 * stays the same.
 *
 * PBKDF2 is slow on purpose, and HTTP Basic sends the password with every
 * request: tools/config-backup.sh and anything else driving the API with
 * curl would pay that cost per request, on a server with one thread. So the
 * first time a password is proven against the hash, a tag of what was
 * presented is kept: HMAC-SHA256 of "user:password" under a key read from
 * /dev/urandom at that moment. A later request is checked against the tag,
 * four hash blocks, not thousands.
 *
 * The trade: the tag is a fast hash of the password, which is what the file
 * no longer is. It is in RAM only, never on flash, in a bundle or in a
 * backup, and its key dies with the process, so a tag read from one boot
 * says nothing at the next. Reading it takes reading the memory of this
 * process, and that already holds the password itself, in the request
 * buffer, each time one arrives over plain HTTP.
 *
 * It is kept for one line: load_credential() compares the line it read with
 * the one this was worked out for and drops all of it on any difference.
 * The content, not the inode, size and date: jffs2 dates are whole seconds,
 * and a file written twice in one second with a password of the same length
 * would keep the old password in force. The read is the one every request
 * has always made. What is kept to compare with is the tag of the line
 * under the same key, not the line: a file as typed is the password, and a
 * copy of it would stay in RAM after the file had become a hash.
 *
 * While the tag is there, a credential that does not match it is refused
 * without running PBKDF2: one line has one password, and it is the one the
 * tag was made from. A wrong guess still costs the second it always did.
 * That rule needs "one password" to be true of the bytes, which HMAC alone
 * does not give, see has_ctl().
 */
static struct {
	int have_line;           /* `line` is the tag of a line */
	int have_tag;
	int stay;                /* migrate() failed for this line: not again */
	unsigned char line[SHA256_LEN];
	unsigned char tag[SHA256_LEN];
} known = { 0, 0, 0, { 0 }, { 0 } };

static void known_reset(void)
{
	unsigned long k;

	for (k = 0; k < SHA256_LEN; k++)
		((volatile unsigned char *)known.tag)[k] = 0;
	known.have_line = known.have_tag = known.stay = 0;
}

/* n random bytes, n at most 32. 0 when /dev/urandom does not give them. */
static int random_bytes(unsigned char *out, unsigned long n)
{
	char raw[33];
	unsigned long k;

	if (read_file(RANDOM_PATH, raw, n + 1) != (long)n)
		return 0;
	for (k = 0; k < n; k++) {
		out[k] = (unsigned char)raw[k];
		((volatile char *)raw)[k] = 0;
	}
	return 1;
}

/*
 * The tag of a presented credential. 0 with no key: nothing is remembered
 * then, and every check runs PBKDF2. Slow, and still right.
 */
static int boot_tag(const char *p, unsigned long n, unsigned char *tag)
{
	static unsigned char key[SHA256_LEN];
	static int have_key;

	if (!have_key && !random_bytes(key, sizeof(key)))
		return 0;
	have_key = 1;
	hmac_sha256(key, sizeof(key), p, n, tag);
	return 1;
}

/*
 * Whether p[0..n) holds a control character (below 0x20, or 0x7f).
 *
 * HMAC pads a short key with zero bytes, so PBKDF2 gives one result for
 * "secret" and for "secret" followed by a NUL: two spellings of one
 * password. A Basic header can carry the second. Proven first, it was the
 * spelling the tag remembered, and the password without the NUL was then
 * refused until the file changed. So nothing with a control character in it is checked
 * against a hash, remembered, or hashed into the file. set_credential()
 * has never taken one, so no password stored from the page has any.
 *
 * (A key longer than a block is replaced by its hash, so a password of more
 * than 64 bytes has a second spelling too, 32 bytes that only somebody who
 * knows the password can work out. That is PBKDF2, and is left alone.)
 */
static int has_ctl(const char *p, unsigned long n)
{
	unsigned long k;
	int ctl = 0;

	for (k = 0; k < n; k++)
		ctl |= (unsigned char)p[k] < 0x20 || p[k] == 0x7f;
	return ctl;
}

/* A buffer that held a password, or a line that may be one, after use. */
static void wipe(char *buf, unsigned long n)
{
	unsigned long k;

	for (k = 0; k < n; k++)
		((volatile char *)buf)[k] = 0;
}

/*
 * Every PBKDF2 of this file goes through here. KDF_COUNT_PATH is defined
 * only for build/confd-kdfcount, which scripts/smoke.sh runs to count them:
 * "this request does not run the slow hash" cannot be seen from outside in
 * any other way than by timing it. Never in the binary that is released.
 */
static void kdf(const char *pass, unsigned long plen, const unsigned char *salt,
		unsigned long iter, unsigned char *out)
{
#ifdef KDF_COUNT_PATH
	long fd = syscall3(__NR_open, (long)KDF_COUNT_PATH, O_WRONLY | O_CREAT | 0x0008 /* O_APPEND */, 0600);

	if (fd >= 0) {
		syscall3(__NR_write, fd, (long)"x", 1);
		syscall3(__NR_close, fd, 0, 0);
	}
#endif
	pbkdf2_sha256(pass, plen, salt, SALT_LEN, iter, out);
}

/* Every byte compared whatever the first difference is. */
static int bytes_differ(const unsigned char *a, const unsigned char *b, unsigned long n)
{
	unsigned long k;
	int diff = 0;

	for (k = 0; k < n; k++)
		diff |= a[k] ^ b[k];
	return diff;
}

/*
 * Load the expected credential into credbuf.
 *
 * /etc/config/confd.auth when it has content, DEFAULT_AUTH otherwise. Returns
 * its length; sets *is_default when the fallback was used.
 *
 * On a safe-mode boot of odi-oss that opens the default credential
 * (safemode_login() below, SM_DEFAULT) the file is not read at all: the
 * recovery boot accepts the default credential, in memory only, so a
 * forgotten password can be replaced. The file is left alone, and a
 * password saved meanwhile is written to it and in force from the next
 * boot. A safe-mode boot that keeps the saved credential (login=stored) is
 * a normal boot here, with one exception: when the config partition is why
 * it is a safe-mode boot, a file that is absent or empty does not fall
 * back to the default, and every login is refused (SM_STRICT).
 *
 * A file that exists but is empty counts as absent. That is not pedantry: the
 * obvious way to clear a password is to truncate the file, and treating the
 * result as "no credential accepted" would lock the operator out of the device
 * they were trying to change the password on.
 *
 * Only absent or empty falls back. A file that is there but cannot be read
 * (an I/O error on the flash, no file descriptor left under load, a
 * directory in its place) answers -1, and every login is refused until it
 * reads again: falling back there would put the password everybody knows
 * in force on a stick whose owner set another one. Safe mode is the way in
 * if it never reads again. A line that is a damaged hash is such a file,
 * see cred_parse().
 */
/* ENOENT: 2 on MIPS o32 as everywhere (the low errno numbers are shared). */
#define ENOENT_ 2

/*
 * What the safe-mode flag of this boot says about the web login.
 *
 * The flag is key=value lines. odi-oss writes login=default when the boot
 * that entered the safe mode followed a power cycle (a person at the
 * stick), and login=stored when the stick entered it by itself (watchdog
 * resets, a config partition that would not mount): nobody asked for the
 * password everybody knows then, so the saved one stays in force.
 *
 *   SM_NONE     no flag: not a safe-mode boot.
 *   SM_DEFAULT  the default credential is open: a login=default line, or
 *               no login= field at all in a flag that was read whole. The
 *               second is an image whose safe-mode.sh predates the line and
 *               opens the default on every safe-mode boot; confd and the
 *               image are released apart, and read the other way round a
 *               new confd on such an image would close the one way back
 *               from a lost password.
 *   SM_STORED   the saved credential stays in force, as on any boot: a
 *               login=stored line, or a login= value this confd does not
 *               know.
 *   SM_STRICT   the saved credential or nothing. Either the flag says
 *               login=stored with cause=config: the config partition could
 *               not be used, so a confd.auth that is not there is a
 *               partition that is not mounted, not an owner who never set a
 *               password, and falling back to the default would open the
 *               stick to whoever reaches the port with nobody at it. One
 *               power cycle is the way in (login=default). Or the flag
 *               could not be judged: a read error, a read that filled
 *               the buffer, which may have cut the line that matters, or a
 *               NUL byte in what was read, which would end the text before
 *               the lines behind it. An image that writes the flag in one
 *               rename never shows half of one, so this is damage, and
 *               damage opens nothing.
 *
 * A line may end in CR LF: one CR is dropped, no more. login=stored
 * anywhere wins over login=default, whichever comes last.
 */
enum { SM_NONE, SM_DEFAULT, SM_STORED, SM_STRICT };

static int safemode_login(void)
{
	char flag[1024];
	long got = read_file(SAFEMODE_FLAG, flag, sizeof(flag));
	const char *p = flag;
	unsigned long n0;
	int field = 0, stored = 0, config = 0;

	if (got == -ENOENT_)
		return SM_NONE;
	if (got < 0 || (unsigned long)got >= sizeof(flag) - 1)
		return SM_STRICT;
	for (n0 = 0; n0 < (unsigned long)got; n0++)
		if (!flag[n0])
			return SM_STRICT;
	while (*p) {
		const char *e = p;
		unsigned long n;

		while (*e && *e != '\n')
			e++;
		n = (unsigned long)(e - p);
		if (n && p[n - 1] == '\r')
			n--;
		if (spre(p, "login=")) {
			field = 1;
			if (!(n == 13 && spre(p, "login=default")))
				stored = 1;
		} else if (n == 12 && spre(p, "cause=config")) {
			config = 1;
		}
		p = *e ? e + 1 : e;
	}
	if (!field)
		return SM_DEFAULT;
	if (!stored)
		return SM_DEFAULT;
	return config ? SM_STRICT : SM_STORED;
}

/*
 * The same decision by name, for /api/hostlink: none, default, stored or
 * strict. The page says which passwords apply from this, not from a
 * reading of the flag of its own, so the bar and the login cannot disagree.
 */
const char *safemode_login_name(void)
{
	switch (safemode_login()) {
	case SM_NONE:    return "none";
	case SM_DEFAULT: return "default";
	case SM_STORED:  return "stored";
	default:         return "strict";
	}
}

/*
 * Read the credential file into buf[cap], without the line end: its
 * length, 0 when it is not there or is empty, -1 when it cannot be used.
 *
 * read_file stops one byte short of the buffer without saying so, so a
 * line that fills it may have been cut. Checked against, a cut line is a
 * credential nobody set: the first 255 bytes of it signed in, and migrate()
 * would then have stored the hash of that prefix as the password. The
 * longest line the page can make is 183 bytes, so a file longer than
 * CRED_MAX is refused whole, like one that cannot be read.
 */
static long read_cred_file(char *buf, unsigned long cap)
{
	long got = read_file(AUTH_PATH, buf, cap);

	if (got == -ENOENT_)
		return 0;
	if (got < 0 || (unsigned long)got > CRED_MAX || (unsigned long)got + 2 > cap)
		return -1;
	/* trim trailing newline/CR so an editor-written file works */
	while (got > 0 && (buf[got - 1] == '\n' || buf[got - 1] == '\r'))
		buf[--got] = 0;
	return got;
}

static long load_credential(int *is_default)
{
	unsigned char id[SHA256_LEN];
	int sm = safemode_login();
	long want = sm == SM_DEFAULT ? 0 : read_cred_file(credbuf, sizeof(credbuf));
	unsigned long k;

	/* Absent or empty falls back to the default, except where the safe
	 * mode says a missing file is a missing partition (SM_STRICT). */
	if (!want && sm == SM_STRICT)
		return -1;
	if (is_default)
		*is_default = want == 0;
	if (want < 0)
		return -1;
	if (!want) {
		for (k = 0; DEFAULT_AUTH[k] && k + 1 < sizeof(credbuf); k++)
			credbuf[k] = DEFAULT_AUTH[k];
		credbuf[k] = 0;
		want = (long)k;
	}

	/* Another line than the one `known` is about: forget it. With no
	 * key there is no telling, and nothing is kept from one call to the
	 * next. */
	if (!boot_tag(credbuf, (unsigned long)want, id)) {
		known_reset();
	} else if (!known.have_line || bytes_differ(id, known.line, SHA256_LEN)) {
		known_reset();
		for (k = 0; k < SHA256_LEN; k++)
			known.line[k] = id[k];
		known.have_line = 1;
	}
	if (!cred_parse(credbuf, (unsigned long)want, &cred))
		return -1;
	return want;
}

/*
 * Whether p[0..n), a "user:password", is what the hash in `c` was made
 * from; `line` is where the username of `c` is. Constant time over the
 * hash, and PBKDF2 runs whether or not the username was right, so the time
 * taken does not say which half was wrong.
 */
static int hash_matches(const struct cred *c, const char *line,
			const char *p, unsigned long n)
{
	unsigned char dk[SHA256_LEN];
	unsigned long k, at = n > c->ulen ? c->ulen + 1 : n;
	int diff = n <= c->ulen || p[c->ulen] != ':';

	for (k = 0; k < c->ulen; k++)
		diff |= line[k] ^ (k < n ? p[k] : 0);
	kdf(p + at, n - at, c->salt, c->iter, dk);
	diff |= bytes_differ(dk, c->hash, SHA256_LEN);
	for (k = 0; k < SHA256_LEN; k++)
		((volatile unsigned char *)dk)[k] = 0;
	return diff == 0;
}

/*
 * The line that stores user and pass hashed, into out[cap]: its length, or
 * 0 when there is no salt to be had or the line would be longer than
 * CRED_MAX, which only a username typed into the file can make it. No salt
 * is no hash: one made with a salt that can be guessed is one table for
 * every stick.
 */
static unsigned long hash_line(char *out, unsigned long cap,
			       const char *user, unsigned long ulen,
			       const char *pass, unsigned long plen)
{
	static const char hex[] = "0123456789abcdef";
	unsigned char salt[SALT_LEN], dk[SHA256_LEN];
	unsigned long n = 0, k;

	if (ulen + HASH_ROOM > CRED_MAX || ulen + HASH_ROOM + 1 > cap ||
	    !random_bytes(salt, SALT_LEN))
		return 0;
	kdf(pass, plen, salt, PBKDF2_ITER, dk);

	for (k = 0; k < ulen; k++)
		out[n++] = user[k];
	out[n++] = ':';
	for (k = 0; HASH_HEAD[k]; k++)
		out[n++] = HASH_HEAD[k];
	for (k = 0; k < SALT_LEN; k++) {
		out[n++] = hex[salt[k] >> 4];
		out[n++] = hex[salt[k] & 15];
	}
	out[n++] = '$';
	for (k = 0; k < SHA256_LEN; k++) {
		out[n++] = hex[dk[k] >> 4];
		out[n++] = hex[dk[k] & 15];
		((volatile unsigned char *)dk)[k] = 0;
	}
	out[n] = 0;
	return n;
}

/*
 * Whether this boot is, or may be, a firmware trial that has not been
 * committed: the image runs once and the next reset goes back to the other
 * slot (firmware.h). odi-oss records it in SLOT_STATE_FILE.
 *
 * It matters to migrate() because the other slot may hold a confd from
 * before the hash. That one reads the file as the password as typed: after
 * a trial that is not kept, the password would no longer sign in and the
 * text of the hashed line would. So the file is left as it is until the
 * image is committed; the commit route has slot-state.sh write the file
 * again, and the next sign-in then makes the hash.
 *
 * "Committed" needs evidence: the file read whole, with exactly one
 * `uncommitted=` line, and that line `uncommitted=0`. An empty value is
 * slot-state.sh not having been able to read the environment. No file is
 * not evidence either on an image that has slot-state.sh: the trial is in
 * the U-Boot environment whether or not the script has run yet at this
 * boot, or ran and failed. The script is not run from here to find out: it
 * takes up to SLOT_STATE_TIMEOUT_MS, a sign-in is not the place to wait for
 * it, and nothing is lost by the file staying as typed a while longer.
 *
 * With neither the file nor the script this is an image without the
 * mechanism (a stock-based one), where there is nothing to wait for.
 */
static int trial_uncommitted(void)
{
	static const char key[] = "uncommitted=";
	char st[1024];
	long got = read_file(SLOT_STATE_FILE, st, sizeof(st));
	unsigned long i = 0;
	int lines = 0, committed = 0;

	if (got == -ENOENT_)
		return file_exists(SLOT_STATE_SCRIPT);
	/* Unreadable, empty, cut by the buffer, or cut before a line end. */
	if (got <= 0 || (unsigned long)got + 1 >= sizeof(st) || st[got - 1] != '\n' ||
	    (unsigned long)got != slen(st))
		return 1;
	while (st[i]) {
		if (spre(st + i, key)) {
			lines++;
			committed = st[i + sizeof(key) - 1] == '0' &&
				    st[i + sizeof(key)] == '\n';
		}
		while (st[i] != '\n')
			i++;
		i++;
	}
	return !(lines == 1 && committed);
}

/*
 * Replace a file that holds the password as typed with the hashed form.
 * Called with the "user:password" that has just been proven against it, at
 * a sign-in: that is the one moment the password is here to be hashed.
 * `want` is the length of the line in credbuf.
 *
 * One write to flash for the life of the file, atomic like any other save
 * of it, 0600. A stick that cannot be written (a full partition, no
 * /dev/urandom for the salt) keeps the file it has, which keeps working;
 * `stay` stops the attempt from being made again on every request while
 * the line is the same.
 *
 * Never on a safe-mode boot or for the built-in default: the caller passes
 * only a line that was read from the file, and neither of those is. Not
 * during a firmware trial, see trial_uncommitted(). Not for a password with
 * a control character, see has_ctl(): it keeps signing in as typed.
 */
static void migrate(const char *p, unsigned long n, long want)
{
	static const char tmp[] = AUTH_PATH ".new";
	char line[sizeof(credbuf)], cur[sizeof(credbuf)];
	unsigned long len;
	long fd;
	int staged;

	/* Before `stay`: this is asked again at every sign-in of a trial,
	 * so that the first one after the commit makes the hash. */
	if (known.stay || trial_uncommitted())
		return;
	/* A recovery boot does not write the credential file by itself,
	 * whatever it lets sign in. Today the file is not in force on any
	 * such boot and the caller never comes here; asked again all the
	 * same, so that it stays true when a safe-mode boot keeps the saved
	 * credential. */
	if (file_exists(SAFEMODE_FLAG))
		return;
	known.stay = 1;
	/* No colon: not a line this could have written, leave it. */
	if (cred.ulen >= n || has_ctl(p, n))
		return;
	len = hash_line(line, sizeof(line), p, cred.ulen,
			p + cred.ulen + 1, n - cred.ulen - 1);
	if (!len)
		return;

	/*
	 * write_file_atomic in three steps, because of what has to happen
	 * between the second and the third: the new file written and synced
	 * under its temporary name, the old one read once more, the rename.
	 *
	 * PBKDF2 took a few hundred milliseconds and the write and fsync to
	 * jffs2 take their time too, and the file may have been written by
	 * hand meanwhile, over ssh: the rename would put the hash of a
	 * password that has just been replaced over the new one. So the
	 * file must still be the line that was proven, read as late as it
	 * can be. What is left is the time between that read and the rename,
	 * two system calls; closing that too would take a lock that
	 * everything writing the file by hand would have to know of.
	 */
	syscall3(__NR_unlink, (long)tmp, 0, 0);
	fd = syscall3(__NR_open, (long)tmp, O_WRONLY | O_CREAT | O_EXCL, 0600);
	if (fd < 0)
		return;
	staged = write_all((int)fd, line, len) == (long)len &&
		 syscall3(__NR_fsync, fd, 0, 0) >= 0 &&
		 syscall3(__NR_chmod, (long)tmp, 0600, 0) >= 0;
	syscall3(__NR_close, fd, 0, 0);
	if (staged && read_cred_file(cur, sizeof(cur)) == want &&
	    !bytes_differ((const unsigned char *)cur, (const unsigned char *)credbuf,
			  (unsigned long)want) &&
	    syscall3(__NR_rename, (long)tmp, (long)AUTH_PATH, 0) >= 0) {
		/* The new line is known as well as the old one was: the same
		 * password proves it, so the next request starts from the
		 * tag and not from PBKDF2 again. */
		known.have_line = boot_tag(line, len, known.line);
		known.have_tag = boot_tag(p, n, known.tag);
	} else {
		syscall3(__NR_unlink, (long)tmp, 0, 0);
	}
	wipe(cur, sizeof(cur));
}

/*
 * How long after a wrong password that cost a PBKDF2 the next check that
 * would cost one is held back: four times what that one took, between
 * COLD_KDF_MIN_MS and COLD_KDF_MAX_MS.
 *
 * Until a password has been proven there is no tag, and telling a wrong
 * password from the right one takes PBKDF2 each time. The second a failure
 * costs is a sleep, which the stick does not notice; PBKDF2 is the one CPU
 * at full load, taken from omcid. Whoever can reach the port could keep it
 * there by guessing, without ever being right. With this, guessing gets a
 * fifth of the CPU at the default count.
 *
 * Held back, not refused: the check sleeps out what is left of the time
 * and then runs. Refusing would be cheaper still, but it refuses the right
 * password with the wrong ones, and one client that keeps guessing would
 * keep everybody else from ever signing in. Sleeping is what a failure has
 * always cost here, in a daemon with one thread: a valid sign-in waits its
 * turn behind the guesses, as it did, and succeeds when it is served. The
 * upper bound keeps that wait from growing with a count near
 * PBKDF2_ITER_MAX, where the share of the CPU is then larger instead.
 *
 * Once a password is proven the tag decides and none of this runs. Not for
 * a script that signs in with the right password on a stick with no
 * /dev/urandom: there is no tag there, and it pays PBKDF2 per request.
 */
#ifndef COLD_KDF_MIN_MS
#define COLD_KDF_MIN_MS 1000
#endif
#define COLD_KDF_MAX_MS 5000
_Static_assert(COLD_KDF_MIN_MS <= COLD_KDF_MAX_MS, "the bounds of one wait");

static void sleep_ms(unsigned long ms)
{
	long ts[2];

	ts[0] = (long)(ms / 1000);
	ts[1] = (long)(ms % 1000) * 1000000L;
	syscall3(__NR_nanosleep, (long)ts, 0, 0);
}

/*
 * Whether p[0..n), a "user:password", is the credential load_credential()
 * has just put in credbuf, of length `want`. `from_file` is 0 for the
 * built-in default. The one comparison behind the sign-in form, HTTP Basic
 * and password_matches(): constant time, a length mismatch folded in rather
 * than returned early.
 */
static int credential_ok(const char *p, unsigned long n, long want, int from_file)
{
	static unsigned long cold_at, cold_wait;
	unsigned char tag[SHA256_LEN];
	unsigned long k, t0;
	int ok;

	if (want <= 0)
		return 0;
	if (!cred.iter) {
		int diff = n != (unsigned long)want;

		for (k = 0; k < (unsigned long)want; k++)
			diff |= credbuf[k] ^ (k < n ? p[k] : 0);
		if (diff)
			return 0;
		if (from_file)
			migrate(p, n, want);
		return 1;
	}
	if (has_ctl(p, n))
		return 0;
	if (known.have_tag)
		return boot_tag(p, n, tag) && !bytes_differ(tag, known.tag, SHA256_LEN);

	t0 = mono_ms();
	/* t0 of 0 is no clock: then nothing waits on its account. */
	if (cold_wait && t0 && t0 - cold_at < cold_wait) {
		sleep_ms(cold_wait - (t0 - cold_at));
		t0 = mono_ms();
	}
	ok = hash_matches(&cred, credbuf, p, n);
	if (ok) {
		known.have_tag = boot_tag(p, n, known.tag);
		cold_wait = 0;
	} else {
		cold_at = mono_ms();
		cold_wait = 4 * (cold_at - t0);
		if (cold_wait < COLD_KDF_MIN_MS)
			cold_wait = COLD_KDF_MIN_MS;
		if (cold_wait > COLD_KDF_MAX_MS)
			cold_wait = COLD_KDF_MAX_MS;
		if (!t0 || !cold_at)
			cold_wait = 0;
	}
	return ok;
}

/*
 * load_credential() and credential_ok() for one presented "user:password",
 * with the line wiped from credbuf afterwards: a file as typed is the
 * password, and it need not stay in RAM between requests.
 */
static int check_credential(const char *p, unsigned long n)
{
	int def = 0, ok;
	long want = load_credential(&def);

	ok = credential_ok(p, n, want, !def);
	wipe(credbuf, sizeof(credbuf));
	return ok;
}

/*
 * Which credential is in force, for every caller that asks: the banner and
 * the page through auth_is_default(), the VoIP secrets, the SSH keys and the
 * backup. One check, so the page and the routes cannot disagree.
 *
 *    1  a credential somebody set: confd.auth has content, admin:admin
 *       included, as typed or as a hash. What is in the file is not
 *       judged, only that it is there.
 *    0  the built-in default: no file or an empty one, or a safe-mode boot
 *       that opens the default, which does not read the file.
 *   -1  the file is there and cannot be read. A browser signed in before the
 *       read started failing still has its session, so this is not taken for
 *       a credential of the owner.
 */
int auth_state(void)
{
	int def = 0;
	long want = load_credential(&def);

	wipe(credbuf, sizeof(credbuf));
	if (want < 0)
		return -1;
	return def ? 0 : 1;
}

int auth_is_default(void)
{
	return auth_state() == 0;
}

/*
 * For the routes that only a credential somebody set may use: adding an SSH
 * key, the backup and the VoIP secrets. Answers the refusal and returns 1
 * unless auth_state() is 1; `json` picks the body the route speaks.
 */
int refuse_unless_set(int fd, int json)
{
	switch (auth_state()) {
	case 1:
		return 0;
	case 0:
		respond(fd, "403 Forbidden", json ? "application/json" : "text/plain", 0);
		put_fd(fd, json ? "{\"ok\":false,\"error\":\"" : "");
		put_fd(fd, "refused: the built-in admin:admin is in force (no password was set, or this is "
			   "a safe-mode boot). Set a password under System, Access, or reboot out of the "
			   "safe mode.");
		break;
	default:
		respond(fd, "503 Service Unavailable", json ? "application/json" : "text/plain", 0);
		put_fd(fd, json ? "{\"ok\":false,\"error\":\"" : "");
		put_fd(fd, "refused: the password file cannot be read, so it is not known whether a "
			   "password was set");
		break;
	}
	put_fd(fd, json ? "\"}" : "\n");
	return 1;
}

/*
 * Set once a password is saved on a safe-mode boot that opens the default
 * (SM_DEFAULT). That boot keeps the default in force until the reboot
 * whatever is saved, so auth_state() stays
 * 0, and this is what lets the page open again after the save (firmware
 * upload has to be reachable there). The routes that refuse the default keep
 * refusing for the whole boot. On a normal boot the saved file is what
 * counts and this is not needed. RAM only: a restart of confd asks again,
 * and saving the same password again answers at once.
 */
static int saved_now;

int auth_saved(void)
{
	return saved_now;
}

/*
 * Write a new credential file.
 *
 * Constrained, not sanitised: a value that does not fit the file format is
 * refused rather than rewritten into one that does. The file is one line of
 * `user:` and the hash of the password, so the username cannot contain a
 * colon and neither half can contain a newline -- a credential mangled on the
 * way in is one nobody can log in with afterwards, on a device where
 * "afterwards" may mean a site visit. The password rules are the ones the
 * file had while it held the password itself, kept so that a password the
 * page takes is also one that can be written by hand.
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
	if (u + 1 + p + 1 > sizeof(authbuf)) {
		*why = "too long";
		return 0;
	}

	/*
	 * The same credential saved again is not written again: a button
	 * pressed twice, or a page that resends, costs the flash nothing. The
	 * file is compared as it is on flash, not with load_credential(), which
	 * answers the default on a safe-mode boot that opens it. A new salt
	 * makes every hash of one password different, so "the same" is "the
	 * stored hash is of this password", which costs one PBKDF2. A file
	 * with other modes than 0600 is written, so a save still makes it
	 * private, and so is one that holds this password as typed: a save
	 * stores the hash.
	 */
	{
		char cur[sizeof(credbuf)];
		struct cred c;
		/* A file too long to be read whole is not "the same". */
		long have = read_cred_file(cur, sizeof(cur));
		unsigned long k;
		int same = 0;

		if (have > 0 && file_mode(AUTH_PATH) == 0600 &&
		    cred_parse(cur, (unsigned long)have, &c) && c.iter) {
			for (n = 0; n < u; n++)
				authbuf[n] = user[n];
			authbuf[n++] = ':';
			for (k = 0; k < p; k++)
				authbuf[n++] = pass[k];
			same = hash_matches(&c, cur, authbuf, n);
			wipe(authbuf, sizeof(authbuf));
		}
		wipe(cur, sizeof(cur));
		if (same) {
			if (safemode_login() == SM_DEFAULT)
				saved_now = 1;
			*why = 0;
			return 1;
		}
	}

	n = hash_line(credbuf, sizeof(credbuf), user, u, pass, p);
	if (!n) {
		*why = "could not hash the password: no random bytes from " RANDOM_PATH;
		return 0;
	}
	/* 0600: the file sits in /etc/config next to the device identity, and
	 * this daemon is not the only thing that can read that directory. */
	if (write_file_atomic(AUTH_PATH, credbuf, n, 0600) < 0) {
		*why = "could not write /etc/config/confd.auth";
		return 0;
	}
	if (safemode_login() == SM_DEFAULT)
		saved_now = 1;
	*why = 0;
	return 1;
}

/*
 * Whether `pass` is the password half of the credential in force. For the
 * routes that make the caller repeat it before showing a secret: the Basic
 * header the browser replays is not proof that the person at the keyboard
 * knows it. The username half is not asked again: it is taken from the
 * line, and the two go through the comparison every sign-in does.
 */
int password_matches(const char *pass)
{
	int def = 0, ok = 0;
	long want = load_credential(&def);
	unsigned long plen = slen(pass), n = 0, k;

	/* No colon in the line: there is no password half. Too long for
	 * the buffer is too long to be the credential. */
	if (want > 0 && cred.ulen < (unsigned long)want &&
	    cred.ulen + 1 + plen + 1 <= sizeof(authbuf)) {
		for (k = 0; k <= cred.ulen; k++)
			authbuf[n++] = credbuf[k];
		for (k = 0; k < plen; k++)
			authbuf[n++] = pass[k];
		authbuf[n] = 0;
		ok = credential_ok(authbuf, n, want, !def);
	}
	wipe(authbuf, sizeof(authbuf));
	wipe(credbuf, sizeof(credbuf));
	return ok;
}

/*
 * HTTP Basic, against the credential in /etc/config/confd.auth -- or against
 * DEFAULT_AUTH when that file has never been written. See confd.h for why the
 * fallback exists rather than a refusal, and note that it is a fallback to a
 * WEAKER credential, not to none: every request is still checked, the
 * comparison is still constant-time, and a failure still costs a second.
 *
 * hdrbuf and authbuf hold the password on the way, in base64 and decoded,
 * and are wiped whichever way this returns; a header that does not decode
 * has left part of it in authbuf.
 */
static int basic_ok(const char *r)
{
	long n = -1;
	int ok = 0;

	if (header_copy(r, "authorization", hdrbuf, sizeof(hdrbuf)) && spre(hdrbuf, "Basic "))
		n = b64decode(hdrbuf + 6, slen(hdrbuf + 6), authbuf, sizeof(authbuf));
	if (n >= 0)
		ok = check_credential(authbuf, (unsigned long)n);
	wipe(hdrbuf, sizeof(hdrbuf));
	wipe(authbuf, sizeof(authbuf));
	return ok;
}

/*
 * Whether `user` and `pass` are the credential in force, for the sign-in
 * form. The same comparison as basic_ok, over "user:pass".
 */
int credential_matches(const char *user, const char *pass)
{
	unsigned long u = slen(user), p = slen(pass), n = 0, k;
	int ok;

	/* Too long for the buffer is too long to be the credential. */
	if (u + 1 + p + 1 > sizeof(authbuf))
		return 0;
	for (k = 0; k < u; k++)
		authbuf[n++] = user[k];
	authbuf[n++] = ':';
	for (k = 0; k < p; k++)
		authbuf[n++] = pass[k];
	authbuf[n] = 0;
	ok = check_credential(authbuf, n);
	wipe(authbuf, sizeof(authbuf));
	return ok;
}

/* ------------------------------------------------------------- sessions --- */

/*
 * A browser signs in once, on /login, and is handed a random token in an
 * HttpOnly, SameSite=Strict cookie; every request after that is checked
 * against this table. The token never holds the password, so the password
 * crosses the network once per sign-in instead of with every request, as it
 * does under Basic. Sign out deletes the row, which ends the session for
 * certain: Basic could only ask the browser to forget, and Chromium shows its
 * own password dialog when asked.
 *
 * RAM only. A restart signs everyone out, which costs one sign-in and saves
 * writing tokens to a flash partition every other process can read.
 */
struct session {
	char tok[33];          /* 32 hex digits; empty when the row is free */
	unsigned long born;    /* mono_s() at sign-in */
	unsigned long used;    /* mono_s() at the last request */
	/*
	 * Which row was used last, from a counter. Not `used`: whole seconds
	 * tie for every sign-in made in the same second, and a tie dropped the
	 * session that had just signed in.
	 */
	unsigned long order;
};

static unsigned long session_tick;

static struct session sessions[SESSION_SLOTS];
/* The row the request being served signed in with, -1 for none. */
static int cur_session = -1;

/* Seconds on the monotonic clock, 0 when it cannot be read. */
static unsigned long mono_s(void)
{
	long ts[2];

	if (syscall3(__NR_clock_gettime, CLOCK_MONOTONIC, (long)ts, 0) < 0)
		return 0;
	return (unsigned long)ts[0];
}

static void session_clear(int i)
{
	unsigned long k;

	for (k = 0; k < sizeof(sessions[i].tok); k++)
		((volatile char *)sessions[i].tok)[k] = 0;
	sessions[i].born = sessions[i].used = sessions[i].order = 0;
}

/* Drop the rows that have run out. */
static void session_expire(unsigned long now)
{
	int i;

	for (i = 0; i < SESSION_SLOTS; i++)
		if (sessions[i].tok[0] &&
		    (now - sessions[i].used > SESSION_IDLE_S ||
		     now - sessions[i].born > SESSION_MAX_S))
			session_clear(i);
}

/*
 * The token in the request's session cookie, copied into out[33]. 0 when
 * there is none, or when it is not exactly 32 hex digits.
 */
static int cookie_token(const char *r, char *out)
{
	char c[1024];
	unsigned long i = 0, n = slen(SESSION_COOKIE), k;

	out[0] = 0;
	if (!header_copy(r, "cookie", c, sizeof(c)))
		return 0;
	while (c[i]) {
		while (c[i] == ' ' || c[i] == ';')
			i++;
		for (k = 0; k < n && c[i + k] == SESSION_COOKIE[k]; k++)
			;
		if (k == n && c[i + n] == '=') {
			i += n + 1;
			for (k = 0; k < 32 && hexval(c[i + k]) >= 0; k++)
				out[k] = c[i + k];
			out[k] = 0;
			if (k == 32 && (!c[i + k] || c[i + k] == ';' || c[i + k] == ' '))
				return 1;
			out[0] = 0;
			return 0;
		}
		while (c[i] && c[i] != ';')
			i++;
	}
	return 0;
}

/*
 * The row whose token the request carries, -1 for none. Every live row is
 * compared in full, so the time taken does not say which row came close.
 */
static int session_find(const char *r)
{
	char tok[33];
	unsigned long now = mono_s(), k;
	int i, hit = -1;

	if (!now || !cookie_token(r, tok))
		return -1;
	session_expire(now);
	for (i = 0; i < SESSION_SLOTS; i++) {
		int diff = 0;

		if (!sessions[i].tok[0])
			continue;
		for (k = 0; k < 32; k++)
			diff |= sessions[i].tok[k] ^ tok[k];
		if (!diff)
			hit = i;
	}
	if (hit >= 0) {
		sessions[hit].used = now;
		sessions[hit].order = ++session_tick;
	}
	return hit;
}

/*
 * Start a session and copy its token into tok[33]. 0 when no random bytes or
 * no clock could be had: no session is better than a guessable one.
 */
int session_start(char *tok)
{
	static const char hex[] = "0123456789abcdef";
	char raw[17];
	unsigned long now = mono_s(), k;
	int i, slot = -1;

	tok[0] = 0;
	if (!now || read_file(RANDOM_PATH, raw, sizeof(raw)) != 16)
		return 0;
	session_expire(now);
	for (i = 0; i < SESSION_SLOTS; i++) {
		if (!sessions[i].tok[0]) {
			slot = i;
			break;
		}
		if (slot < 0 || sessions[i].order < sessions[slot].order)
			slot = i;
	}
	for (k = 0; k < 16; k++) {
		sessions[slot].tok[2 * k] = hex[(raw[k] >> 4) & 15];
		sessions[slot].tok[2 * k + 1] = hex[raw[k] & 15];
		((volatile char *)raw)[k] = 0;
	}
	sessions[slot].tok[32] = 0;
	sessions[slot].born = sessions[slot].used = now;
	sessions[slot].order = ++session_tick;
	str_copy(tok, sessions[slot].tok, 33);
	return 1;
}

/*
 * Whether the request carries a live session cookie, and nothing else. For
 * the routes that answer without a credential and only want to know this:
 * authorised() goes on to HTTP Basic when there is no cookie, and Basic may
 * run PBKDF2. On a route with no failure cost that was the slow hash for
 * anyone who asked, as often as they asked.
 */
int session_live(const char *r)
{
	return session_find(r) >= 0;
}

/* End the session the request being served signed in with, if any. */
void session_end_current(const char *r)
{
	int i = session_find(r);

	if (i >= 0)
		session_clear(i);
}

/*
 * End every session but the one the request being served signed in with:
 * after a password change, a browser that signed in with the old password is
 * not signed in any more. The browser that made the change stays signed in.
 */
void session_end_others(void)
{
	int i;

	for (i = 0; i < SESSION_SLOTS; i++)
		if (i != cur_session)
			session_clear(i);
}

/*
 * Whether the request is signed in: AUTH_SESSION for a live session cookie,
 * AUTH_BASIC for a correct HTTP Basic header (curl and scripts), 0 otherwise.
 * The cookie is looked at first and, when it is good, Basic is not looked at.
 */
int authorised(const char *r)
{
	cur_session = session_find(r);
	if (cur_session >= 0)
		return AUTH_SESSION;
	return basic_ok(r) ? AUTH_BASIC : 0;
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
			/* %00 would end the C string here: the text validated,
			 * written and read back would be the part before it,
			 * reported as the value that was sent. */
			if (!c) {
				out[0] = 0;
				return 0;
			}
			i += 3;
		} else {
			i++;
		}
		/*
		 * A token that does not fit is refused like a bad escape, not
		 * cut. Cut, it was validated, written and read back against
		 * itself, and the page was told a value it never typed was
		 * saved (the same failure read_request describes for a whole
		 * body, here for one field).
		 */
		if (o + 1 >= cap) {
			out[0] = 0;
			return 0;
		}
		out[o++] = c;
	}
	out[o] = 0;
	return i;
}

/* Step over one token without decoding it: the index of its end. For the
 * fields of a form body that the caller is not asking about, so that a long
 * value it does not want cannot fail the one it does. */
unsigned long url_skip(const char *in, unsigned long i)
{
	while (in[i] && in[i] != '&')
		i++;
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
		if (seq(name, want)) {
			/* Too long or badly encoded: no value, not a prefix. */
			i = url_decode(body, i, 0, out, cap);
			if (!i) {
				out[0] = 0;
				return 0;
			}
			return 1;
		}
		i = url_skip(body, i);
		if (body[i] == '&')
			i++;
	}
	out[0] = 0;
	return 0;
}

/* Whether a urlencoded body names a field at all, whatever it holds. For a
 * field whose absence means something: form_get answers 0 for a value that is
 * too long or badly encoded as well. */
int form_has(const char *body, const char *want)
{
	char name[64];
	unsigned long i = 0;

	while (body[i]) {
		unsigned long k = url_decode(body, i, '=', name, sizeof(name));

		if (!k)
			return 0;
		if (seq(name, want))
			return 1;
		i = url_skip(body, k);
		if (body[i] == '&')
			i++;
	}
	return 0;
}

/* Whether every field name of a urlencoded body decodes. form_get and
 * form_has stop at a name that does not (too long, a bad escape) and answer
 * "absent" for every field after it, which is not the same: a route whose
 * default acts on its own checks this first. */
int form_valid(const char *body)
{
	char name[64];
	unsigned long i = 0;

	while (body[i]) {
		unsigned long k = url_decode(body, i, '=', name, sizeof(name));

		if (!k)
			return 0;
		i = url_skip(body, k);
		if (body[i] == '&')
			i++;
	}
	return 1;
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
	/* read_file stops one byte short of the buffer without an error, so a
	 * file that filled it may have been cut. Served, it would be a 200 with
	 * a valid ETag for a stylesheet that ends mid-rule or a module that does
	 * not parse. A file of 65,535 bytes fits the buffer but cannot be told
	 * from a cut one, so 65,534 is the most served. scripts/check-assets.py
	 * keeps web/ to that. */
	_Static_assert(sizeof(filebuf) == 65536, "the 500 below names the limit");
	if ((unsigned long)got + 1 >= sizeof(filebuf)) {
		respond(fd, "500 Internal Server Error", "text/plain", 0);
		put_fd(fd, "asset not served: confd serves files of at most 65,534 bytes\n");
		return;
	}
	if (respond_cached(fd, ctype, filebuf, (unsigned long)got))
		return;
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
	{ "/login",         "login.html",  "text/html; charset=utf-8" },
	{ "/login.js",      "login.js",    "application/javascript" },
	{ "/style.css",     "style.css",   "text/css" },
	{ "/app.js",        "app.js",      "application/javascript" },
	{ "/dom.js",        "dom.js",      "application/javascript" },
	{ "/state.js",      "state.js",    "application/javascript" },
	{ "/status.js",     "status.js",   "application/javascript" },
	{ "/flow.js",       "flow.js",     "application/javascript" },
	{ "/overview.js",   "overview.js", "application/javascript" },
	{ "/validate.js",   "validate.js", "application/javascript" },
	{ "/config.js",     "config.js",   "application/javascript" },
	{ "/expert.js",     "expert.js",   "application/javascript" },
	{ "/lanroutes.js",  "lanroutes.js", "application/javascript" },
	{ "/save.js",       "save.js",     "application/javascript" },
	{ "/firmware.js",   "firmware.js", "application/javascript" },
	{ "/omci.js",       "omci.js",     "application/javascript" },
	{ "/services.js",   "services.js", "application/javascript" },
	{ "/mebrowser.js",  "mebrowser.js", "application/javascript" },
	{ "/topology.js",   "topology.js", "application/javascript" },
	{ "/phone.js",      "phone.js",     "application/javascript" },
	{ "/restore.js",    "restore.js",  "application/javascript" },
	{ "/crypto.js",     "crypto.js",   "application/javascript" },
	{ "/l2.js",         "l2.js",       "application/javascript" },
	{ "/tools.js",      "tools.js",    "application/javascript" },
	{ "/hostlink.js",   "hostlink.js", "application/javascript" },
	{ "/netaddr.js",    "netaddr.js",  "application/javascript" },
	{ "/wizard.js",     "wizard.js",   "application/javascript" },
	{ "/linkcheck.js",  "linkcheck.js", "application/javascript" },
	{ "/updates.js",    "updates.js",  "application/javascript" },
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
