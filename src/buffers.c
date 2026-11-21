/* The definitions for buffers.h. See there for why they live together. */

#include "buffers.h"

char req[16384];
char schema[40960];
char sett[16384];
char values[65536];
char status[16384];
char omci[32768];
char authbuf[256];
char hdrbuf[512];
char credbuf[256];
char credseen[256];
char filebuf[65536];

_Static_assert(META_CAP + CONS_CAP <= sizeof(filebuf),
	       "the write path's tables must fit in filebuf");

/*
 * -ftrivial-auto-var-init=zero (Makefile) clears a large local with a call
 * to memset, whatever -ffreestanding and -fno-builtin say, so it has to
 * exist. Here because this file is the one without code of its own. used:
 * the calls appear only at code generation, after LTO would have dropped a
 * function nothing called. Built with -fno-tree-loop-distribute-patterns,
 * without which gcc recognises this loop as a memset and calls itself.
 */
void *memset(void *dst, int c, unsigned long n) __attribute__((used));
void *memset(void *dst, int c, unsigned long n)
{
	unsigned char *d = dst;

	while (n--)
		*d++ = (unsigned char)c;
	return dst;
}
