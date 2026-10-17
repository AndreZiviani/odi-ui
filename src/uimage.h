/*
 * The U-Boot legacy image header, and the two checks U-Boot's own bootm makes
 * before it boots one: the magic and header CRC, then the data CRC.
 *
 * Pure functions, no syscalls, so test/uimage_check.c builds them for the host.
 * The header is 64 bytes, big-endian:
 *
 *    0 magic 0x27051956     4 header CRC (over the 64 bytes, this field zero)
 *    8 time                12 data size
 *   16 load address        20 entry point
 *   24 data CRC            28 os, arch, type, comp (one byte each)
 *   32 name (32 bytes)
 *
 * Used by the Firmware tab before it arms a trial boot: the bootloader refuses
 * a slot whose kernel fails these checks, so arming one only costs a reboot
 * that ends at the bootloader prompt instead of in a booted image.
 */

#ifndef CONFD_UIMAGE_H
#define CONFD_UIMAGE_H

#define UIMAGE_HDR_LEN 64U

static unsigned int uimage_be32(const unsigned char *p)
{
	return ((unsigned int)p[0] << 24) | ((unsigned int)p[1] << 16)
	     | ((unsigned int)p[2] << 8) | (unsigned int)p[3];
}

/*
 * The ordinary Ethernet/zlib CRC32, a nibble at a time (a 16-entry table keeps
 * the daemon small; the speed is not the point). Incremental: pass the result
 * of the previous call to continue, 0 to start.
 */
static unsigned int uimage_crc32(unsigned int crc, const unsigned char *p,
				 unsigned long n)
{
	static const unsigned int tbl[16] = {
		0x00000000, 0x1db71064, 0x3b6e20c8, 0x26d930ac,
		0x76dc4190, 0x6b6b51f4, 0x4db26158, 0x5005713c,
		0xedb88320, 0xf00f9344, 0xd6d6a3e8, 0xcb61b38c,
		0x9b64c2b0, 0x86d3d2d4, 0xa00ae278, 0xbdbdf21c,
	};
	unsigned long i;

	crc = ~crc;
	for (i = 0; i < n; i++) {
		crc ^= p[i];
		crc = tbl[crc & 0xf] ^ (crc >> 4);
		crc = tbl[crc & 0xf] ^ (crc >> 4);
	}
	return ~crc;
}

/*
 * The 64-byte header of a kernel partition of `part` bytes: the data size when
 * the magic and header CRC hold and the data fits the partition, 0 when not.
 */
static unsigned long uimage_header_ok(const unsigned char *h, unsigned long part)
{
	unsigned char z[UIMAGE_HDR_LEN];
	unsigned int i, size;

	if (uimage_be32(h) != 0x27051956U)
		return 0;
	for (i = 0; i < UIMAGE_HDR_LEN; i++)
		z[i] = (i >= 4 && i < 8) ? 0 : h[i];
	if (uimage_crc32(0, z, UIMAGE_HDR_LEN) != uimage_be32(h + 4))
		return 0;
	size = uimage_be32(h + 12);
	if (part < UIMAGE_HDR_LEN || size == 0
	    || (unsigned long)size > part - UIMAGE_HDR_LEN)
		return 0;
	return size;
}

#endif /* CONFD_UIMAGE_H */
