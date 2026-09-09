/*
 * The HTTP layer: reading a request safely, deciding whether to answer it, and
 * the two ways bytes leave -- a response header and a static file.
 *
 * Everything here treats the request as hostile input. Two of these functions
 * have already cost real debugging by editing their input in place, so the
 * rule is stated once: request_path NUL-terminates the method and the path
 * where they sit, which stops any later header scan dead. Call header_copy and
 * request_body BEFORE request_path, never after.
 */

#ifndef CONFD_HTTP_H
#define CONFD_HTTP_H

#define REQ_INCOMPLETE (-1)
#define REQ_TOO_LARGE  (-2)

void respond(int fd, const char *status_line, const char *ctype,
	     const char *extra);
char *request_path(char *r, char **method);
char *request_body(char *r);
int header_copy(const char *r, const char *name, char *out, unsigned long cap);
long read_request(int conn, char *buf, unsigned long cap);
int same_origin(const char *r);
int authorised(const char *r);
unsigned long url_decode(const char *in, unsigned long i, char stop,
			 char *out, unsigned long cap);
int form_get(const char *body, const char *want, char *out, unsigned long cap);
void serve_static(int fd, const char *name, const char *ctype);

#endif /* CONFD_HTTP_H */
