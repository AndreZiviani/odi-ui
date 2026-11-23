/*
 * SHA-256, HMAC-SHA256 and PBKDF2-HMAC-SHA256, for the credential file
 * (http.c): the file holds a salted, slow hash of the password, not the
 * password.
 *
 * Its own file with no include but this one, and nothing of the daemon in
 * it: no syscall, no buffer of buffers.h. That is what lets
 * scripts/sha256-test.sh build the same source with the host compiler and
 * run the published test vectors against it, which is the only test a hash
 * can have. Adds, shifts and xors only: nothing here can become a `mul`,
 * which the RLX5281 traps on.
 */

#ifndef CONFD_SHA256_H
#define CONFD_SHA256_H

#define SHA256_LEN 32

struct sha256 {
	unsigned int h[8];
	unsigned long len;       /* bytes taken so far */
	unsigned char buf[64];   /* the block being filled */
};

void sha256_init(struct sha256 *s);
void sha256_update(struct sha256 *s, const void *data, unsigned long n);
void sha256_final(struct sha256 *s, unsigned char out[SHA256_LEN]);

/* RFC 2104. */
void hmac_sha256(const void *key, unsigned long klen,
		 const void *msg, unsigned long mlen,
		 unsigned char out[SHA256_LEN]);

/*
 * RFC 8018 PBKDF2 with HMAC-SHA256, for one block of output (dkLen 32),
 * which is all the credential file stores. `iter` of 0 is taken as 1.
 */
void pbkdf2_sha256(const void *pass, unsigned long plen,
		   const void *salt, unsigned long slen,
		   unsigned long iter, unsigned char out[SHA256_LEN]);

#endif /* CONFD_SHA256_H */
