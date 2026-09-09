/*
 * The daemon's static buffers, declared in one place.
 *
 * Static, not stack: this is a single-threaded serial server and these would
 * otherwise be tens of kilobytes of stack in one frame. Keeping them together
 * is what makes the RAM budget legible -- roughly 166 KB of BSS, on a device
 * with about 1.5 MB free -- rather than something you have to add up across
 * six files.
 *
 * They are shared rather than per-module because they genuinely are: `schema`
 * is read both by the route that serves it and by the write path, and `values`
 * by both /api/values and /api/defaults. Scattering them would not make them
 * private, only harder to count.
 */

#ifndef CONFD_BUFFERS_H
#define CONFD_BUFFERS_H

/*
 * req holds a whole request, headers and body together. 4096 was not enough: a
 * save of a dozen keys with long values overran it, and the overrun did not
 * announce itself -- the body was simply truncated mid-value and written. It is
 * sized so that a realistic save fits with room to spare, and read_request
 * answers 413 rather than trimming anything that still does not.
 */
extern char req[16384];
extern char schema[40960];
extern char meta[16384];
extern char cons[16384];
extern char values[24576];
extern char status[16384];
extern char authbuf[256];
extern char hdrbuf[512];
extern char credbuf[256];
extern char filebuf[65536];

#endif /* CONFD_BUFFERS_H */
