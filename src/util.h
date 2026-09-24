/*
 * Small helpers confd needs and the syscall layer does not provide: writing to
 * an fd, reading a whole file, decoding base64, and emitting JSON.
 *
 * Freestanding: no libc, so everything here is hand-rolled and bounded. That is
 * cheaper than it sounds because every value this daemon emits arrives as text
 * from `flash` or `diag` and leaves as text — nothing is parsed into a number
 * and formatted back, so there is no snprintf-shaped hole to fill.
 */

#ifndef ODI_UTIL_H
#define ODI_UTIL_H

#include "syscall.h"

/* str_len, put_fd and read_file come from syscall.h. */
#define slen str_len

static inline int seq(const char *a, const char *b)
{
	unsigned long i = 0;

	while (a[i] && a[i] == b[i])
		i++;
	return a[i] == b[i];
}

/* Copy at most cap - 1 bytes and terminate. */
static inline void str_copy(char *dst, const char *src, unsigned long cap)
{
	unsigned long i = 0;

	while (src[i] && i + 1 < cap) {
		dst[i] = src[i];
		i++;
	}
	dst[i] = 0;
}

/* Whether a path can be opened for reading: the one existence test a
 * freestanding daemon with no stat wrapper needs. */
static inline int file_exists(const char *path)
{
	long fd = syscall3(__NR_open, (long)path, O_RDONLY, 0);

	if (fd < 0)
		return 0;
	syscall3(__NR_close, fd, 0, 0);
	return 1;
}

/* Whether `s` starts with `p`. */
static inline int spre(const char *s, const char *p)
{
	unsigned long i = 0;

	while (p[i]) {
		if (s[i] != p[i])
			return 0;
		i++;
	}
	return 1;
}

/*
 * One hex digit, or -1. Shared because two unrelated callers need it: decoding
 * a %XX escape out of a form body, and checking that a value the schema calls
 * hex really is.
 */
static inline int hexval(char c)
{
	if (c >= '0' && c <= '9') return c - '0';
	if (c >= 'a' && c <= 'f') return c - 'a' + 10;
	if (c >= 'A' && c <= 'F') return c - 'A' + 10;
	return -1;
}

/* -1 for a non-base64 byte, so a malformed header fails rather than decodes. */
static inline int b64val(char c)
{
	if (c >= 'A' && c <= 'Z') return c - 'A';
	if (c >= 'a' && c <= 'z') return c - 'a' + 26;
	if (c >= '0' && c <= '9') return c - '0' + 52;
	if (c == '+') return 62;
	if (c == '/') return 63;
	return -1;
}

/* Decode base64 into dst. Returns length, or -1 on any invalid byte. */
static inline long b64decode(const char *src, unsigned long len, char *dst, unsigned long cap)
{
	unsigned long i = 0, n = 0;
	unsigned long acc = 0;
	int bits = 0;

	for (i = 0; i < len; i++) {
		int v;

		if (src[i] == '=')
			break;
		v = b64val(src[i]);
		if (v < 0)
			return -1;
		acc = (acc << 6) | (unsigned long)v;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			if (n + 1 >= cap)
				return -1;
			dst[n++] = (char)((acc >> bits) & 0xff);
		}
	}
	dst[n] = 0;
	return (long)n;
}

/*
 * Emit a JSON string body, escaped. Values come from device config and can
 * contain anything, so this is what keeps a stray quote or control byte from
 * producing a response the browser cannot parse.
 */
static inline void put_json_str(int fd, const char *s, unsigned long len)
{
	static const char hexd[] = "0123456789abcdef";
	unsigned long i;

	for (i = 0; i < len; i++) {
		unsigned char c = (unsigned char)s[i];

		if (c == '"' || c == '\\') {
			char esc[2];

			esc[0] = '\\';
			esc[1] = (char)c;
			write_all(fd, esc, 2);
		} else if (c < 0x20 || c == 0x7f) {
			char u[6];

			u[0] = '\\'; u[1] = 'u'; u[2] = '0'; u[3] = '0';
			u[4] = hexd[(c >> 4) & 0xf];
			u[5] = hexd[c & 0xf];
			write_all(fd, u, 6);
		} else {
			write_all(fd, (const char *)&c, 1);
		}
	}
}

static inline void put_json_cstr(int fd, const char *s)
{
	put_json_str(fd, s, slen(s));
}

/* Sleep whole seconds. struct timespec is two longs on this 32-bit target. */
static inline void sleep_s(long secs)
{
	long ts[2];

	ts[0] = secs;
	ts[1] = 0;
	syscall3(__NR_nanosleep, (long)ts, 0, 0);
}

#endif /* ODI_UTIL_H */
