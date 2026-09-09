/* The definitions for buffers.h. See there for why they live together. */

#include "buffers.h"

char req[16384];
char schema[40960];
char meta[16384];
char cons[16384];
char values[24576];
char status[16384];
char authbuf[256];
char hdrbuf[512];
char credbuf[256];
char filebuf[65536];
