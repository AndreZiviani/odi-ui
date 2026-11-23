/*
 * src/sha256.c on the host, for scripts/sha256-test.sh: the hash of a file,
 * the HMAC of a file under a key file, PBKDF2 of a password file with a salt
 * file. Files, not arguments, so a test vector may hold any byte.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../src/sha256.h"

static unsigned char a[1 << 20], b[1 << 20];

static unsigned long slurp(const char *path, unsigned char *buf)
{
	FILE *f = fopen(path, "rb");
	unsigned long n;

	if (!f) {
		perror(path);
		exit(2);
	}
	n = fread(buf, 1, 1 << 20, f);
	fclose(f);
	return n;
}

int main(int argc, char **argv)
{
	unsigned char out[SHA256_LEN];
	unsigned long n, m;
	int i;

	if (argc == 3 && !strcmp(argv[1], "sha256")) {
		struct sha256 s;
		unsigned long k;

		/* In uneven pieces, so a block boundary inside an update and
		 * one between two updates are both walked. */
		n = slurp(argv[2], a);
		sha256_init(&s);
		for (k = 0; k < n; k += 97)
			sha256_update(&s, a + k, n - k < 97 ? n - k : 97);
		sha256_final(&s, out);
	} else if (argc == 4 && !strcmp(argv[1], "hmac")) {
		n = slurp(argv[2], a);
		m = slurp(argv[3], b);
		hmac_sha256(a, n, b, m, out);
	} else if (argc == 5 && !strcmp(argv[1], "pbkdf2")) {
		n = slurp(argv[2], a);
		m = slurp(argv[3], b);
		pbkdf2_sha256(a, n, b, m, strtoul(argv[4], 0, 10), out);
	} else {
		fprintf(stderr, "usage: sha256 FILE | hmac KEY MSG | pbkdf2 PASS SALT ITER\n");
		return 2;
	}
	for (i = 0; i < SHA256_LEN; i++)
		printf("%02x", out[i]);
	printf("\n");
	return 0;
}
