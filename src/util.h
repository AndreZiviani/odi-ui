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

static int seq(const char *a, const char *b)
{
	unsigned long i = 0;

	while (a[i] && a[i] == b[i])
		i++;
	return a[i] == b[i];
}

/* Whether `s` starts with `p`. */
static int spre(const char *s, const char *p)
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
 * Emit a JSON string body, escaped. Values come from device config and can
 * contain anything, so this is what keeps a stray quote or control byte from
 * producing a response the browser cannot parse.
 */
static void put_json_str(int fd, const char *s, unsigned long len)
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

static void put_json_cstr(int fd, const char *s)
{
	put_json_str(fd, s, slen(s));
}

/* Sleep whole seconds. struct timespec is two longs on this 32-bit target. */
static void sleep_s(long secs)
{
	long ts[2];

	ts[0] = secs;
	ts[1] = 0;
	syscall3(__NR_nanosleep, (long)ts, 0, 0);
}

#endif /* ODI_UTIL_H */
