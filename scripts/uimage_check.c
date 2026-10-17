/* Host build of src/uimage.h: `uimage_check <file> <partition-bytes>` prints
 * "ok" when the file starts with a uImage U-Boot would accept (magic, header
 * CRC, data CRC) and "bad" otherwise. The data CRC is fed in 1000-byte pieces
 * so the incremental form is what is exercised. `uimage_check --crc <file>`
 * prints the CRC32 of the whole file, for comparison with zlib. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../src/uimage.h"

int main(int argc, char **argv)
{
	static unsigned char buf[1 << 22];
	unsigned long n, size, off;
	unsigned int crc = 0;
	int crcmode;
	FILE *f;

	if (argc < 3)
		return 2;
	crcmode = !strcmp(argv[1], "--crc");
	f = fopen(argv[crcmode ? 2 : 1], "rb");
	if (!f)
		return 2;
	n = fread(buf, 1, sizeof buf, f);
	fclose(f);
	if (crcmode) {
		for (off = 0; off < n; off += 1000)
			crc = uimage_crc32(crc, buf + off, n - off < 1000 ? n - off : 1000);
		printf("%08x\n", crc);
		return 0;
	}
	size = n >= UIMAGE_HDR_LEN ? uimage_header_ok(buf, strtoul(argv[2], 0, 0)) : 0;
	if (!size || UIMAGE_HDR_LEN + size > n) {
		puts("bad");
		return 0;
	}
	for (off = 0; off < size; off += 1000)
		crc = uimage_crc32(crc, buf + UIMAGE_HDR_LEN + off,
				   size - off < 1000 ? size - off : 1000);
	puts(crc == uimage_be32(buf + 24) ? "ok" : "bad");
	return 0;
}
