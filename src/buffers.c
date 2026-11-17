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
char filebuf[65536];

_Static_assert(META_CAP + CONS_CAP <= sizeof(filebuf),
	       "the write path's tables must fit in filebuf");
