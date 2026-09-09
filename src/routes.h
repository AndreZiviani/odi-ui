/*
 * Request dispatch: one function, called once per accepted connection.
 *
 * The ordering inside it is load-bearing and commented there -- authenticate
 * before parsing, take the body before the request line, and refuse a
 * cross-site write before doing anything with it.
 */

#ifndef CONFD_ROUTES_H
#define CONFD_ROUTES_H

void serve(int conn);

#endif /* CONFD_ROUTES_H */
