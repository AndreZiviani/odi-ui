/* SHA-256 (FIPS 180-4), HMAC (RFC 2104), PBKDF2 (RFC 8018). See sha256.h. */

#include "sha256.h"

_Static_assert(sizeof(unsigned int) == 4, "the hash words are 32 bits");

static const unsigned int K[64] = {
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
	0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
	0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
	0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
	0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
	0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

#define ROR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))

/*
 * One block. `w` is the block as sixteen big-endian words and is used up:
 * the message schedule is kept in those sixteen words, rolling, where the
 * textbook form keeps all sixty-four on the stack.
 */
static void compress(unsigned int *h, unsigned int *w)
{
	unsigned int a = h[0], b = h[1], c = h[2], d = h[3];
	unsigned int e = h[4], f = h[5], g = h[6], hh = h[7];
	unsigned int i;

	for (i = 0; i < 64; i++) {
		unsigned int t1, t2;

		if (i >= 16) {
			unsigned int s0 = w[(i + 1) & 15], s1 = w[(i + 14) & 15];

			w[i & 15] += (ROR(s0, 7) ^ ROR(s0, 18) ^ (s0 >> 3)) +
				     w[(i + 9) & 15] +
				     (ROR(s1, 17) ^ ROR(s1, 19) ^ (s1 >> 10));
		}
		t1 = hh + (ROR(e, 6) ^ ROR(e, 11) ^ ROR(e, 25)) +
		     (g ^ (e & (f ^ g))) + K[i] + w[i & 15];
		t2 = (ROR(a, 2) ^ ROR(a, 13) ^ ROR(a, 22)) +
		     ((a & b) | (c & (a | b)));
		hh = g;
		g = f;
		f = e;
		e = d + t1;
		d = c;
		c = b;
		b = a;
		a = t1 + t2;
	}
	h[0] += a;
	h[1] += b;
	h[2] += c;
	h[3] += d;
	h[4] += e;
	h[5] += f;
	h[6] += g;
	h[7] += hh;
}

static void block(struct sha256 *s)
{
	unsigned int w[16], i;

	for (i = 0; i < 16; i++)
		w[i] = (unsigned int)s->buf[4 * i] << 24 |
		       (unsigned int)s->buf[4 * i + 1] << 16 |
		       (unsigned int)s->buf[4 * i + 2] << 8 |
		       (unsigned int)s->buf[4 * i + 3];
	compress(s->h, w);
}

void sha256_init(struct sha256 *s)
{
	static const unsigned int iv[8] = {
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
		0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
	};
	unsigned int i;

	for (i = 0; i < 8; i++)
		s->h[i] = iv[i];
	s->len = 0;
}

void sha256_update(struct sha256 *s, const void *data, unsigned long n)
{
	const unsigned char *p = data;

	while (n--) {
		s->buf[s->len++ & 63] = *p++;
		if (!(s->len & 63))
			block(s);
	}
}

void sha256_final(struct sha256 *s, unsigned char out[SHA256_LEN])
{
	/* In bits. A message of 512 MB or more is not hashed here, so the
	 * high word of the 64-bit length is zero. */
	unsigned long bits = s->len << 3;
	unsigned char tail[8];
	unsigned int i;

	sha256_update(s, "\x80", 1);
	while ((s->len & 63) != 56)
		sha256_update(s, "", 1);
	for (i = 0; i < 4; i++) {
		tail[i] = 0;
		tail[4 + i] = (unsigned char)(bits >> (24 - 8 * i));
	}
	sha256_update(s, tail, 8);
	for (i = 0; i < SHA256_LEN; i++)
		out[i] = (unsigned char)(s->h[i >> 2] >> (24 - 8 * (i & 3)));
}

/*
 * The two hashes of HMAC, each with its first block (the key xor the pad)
 * already taken. PBKDF2 runs HMAC with one key thousands of times, and
 * starting from these halves the work of every round.
 */
struct hmac {
	struct sha256 in, out;
};

static void hmac_key(struct hmac *m, const void *key, unsigned long klen)
{
	unsigned char k[64], pad[64];
	unsigned int i;

	for (i = 0; i < 64; i++)
		k[i] = 0;
	if (klen > 64) {
		sha256_init(&m->in);
		sha256_update(&m->in, key, klen);
		sha256_final(&m->in, k);
	} else {
		for (i = 0; i < klen; i++)
			k[i] = ((const unsigned char *)key)[i];
	}
	sha256_init(&m->in);
	for (i = 0; i < 64; i++)
		pad[i] = k[i] ^ 0x36;
	sha256_update(&m->in, pad, 64);
	sha256_init(&m->out);
	for (i = 0; i < 64; i++)
		pad[i] = k[i] ^ 0x5c;
	sha256_update(&m->out, pad, 64);
	/* The key is the password. */
	for (i = 0; i < 64; i++)
		((volatile unsigned char *)k)[i] = ((volatile unsigned char *)pad)[i] = 0;
}

/* Finish the inner hash and run the outer one over it. Uses `m` up. */
static void hmac_final(struct hmac *m, unsigned char out[SHA256_LEN])
{
	sha256_final(&m->in, out);
	sha256_update(&m->out, out, SHA256_LEN);
	sha256_final(&m->out, out);
}

static void hmac_wipe(struct hmac *m)
{
	unsigned long i;

	for (i = 0; i < sizeof(*m); i++)
		((volatile unsigned char *)m)[i] = 0;
}

void hmac_sha256(const void *key, unsigned long klen,
		 const void *msg, unsigned long mlen,
		 unsigned char out[SHA256_LEN])
{
	struct hmac m;

	hmac_key(&m, key, klen);
	sha256_update(&m.in, msg, mlen);
	hmac_final(&m, out);
	hmac_wipe(&m);
}

/*
 * One HMAC of a 32-byte message, in words: the inner and the outer hash are
 * each a single block from the keyed state, the 32 bytes followed by the
 * padding of a 96-byte message. This is every round of PBKDF2 after the
 * first, and it is where a sign-in spends its time, so it skips the byte
 * buffer of sha256_update.
 */
static void hmac_round(const struct hmac *m, unsigned int *u)
{
	unsigned int w[16], st[8], i, pass;

	for (pass = 0; pass < 2; pass++) {
		const unsigned int *from = pass ? m->out.h : m->in.h;

		for (i = 0; i < 8; i++) {
			w[i] = u[i];
			w[8 + i] = 0;
			st[i] = from[i];
		}
		w[8] = 0x80000000u;
		w[15] = (64 + SHA256_LEN) * 8;
		compress(st, w);
		for (i = 0; i < 8; i++)
			u[i] = st[i];
	}
}

void pbkdf2_sha256(const void *pass, unsigned long plen,
		   const void *salt, unsigned long slen,
		   unsigned long iter, unsigned char out[SHA256_LEN])
{
	struct hmac key, first;
	unsigned int u[8], t[8];
	unsigned long i;

	hmac_key(&key, pass, plen);

	/* U1 = HMAC(pass, salt || INT(1)): the one round with a message of
	 * any length. `first` is a copy, member by member: a struct
	 * assignment would be a call to memcpy, which is not there. */
	for (i = 0; i < sizeof(first); i++)
		((unsigned char *)&first)[i] = ((const unsigned char *)&key)[i];
	sha256_update(&first.in, salt, slen);
	sha256_update(&first.in, "\0\0\0\1", 4);
	hmac_final(&first, out);
	for (i = 0; i < 8; i++)
		t[i] = u[i] = (unsigned int)out[4 * i] << 24 |
			      (unsigned int)out[4 * i + 1] << 16 |
			      (unsigned int)out[4 * i + 2] << 8 |
			      (unsigned int)out[4 * i + 3];

	for (i = 1; i < iter; i++) {
		unsigned int k;

		hmac_round(&key, u);
		for (k = 0; k < 8; k++)
			t[k] ^= u[k];
	}
	for (i = 0; i < SHA256_LEN; i++)
		out[i] = (unsigned char)(t[i >> 2] >> (24 - 8 * (i & 3)));

	hmac_wipe(&key);
	hmac_wipe(&first);
	for (i = 0; i < 8; i++)
		((volatile unsigned int *)u)[i] = ((volatile unsigned int *)t)[i] = 0;
}
