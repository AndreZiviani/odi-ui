/*
 * Boot selection and the firmware view.
 */

#include "confd.h"
#include "http.h"
#include "firmware.h"
#include "buffers.h"

/*
 * Boot selection.
 *
 * U-Boot keeps a one-shot trial slot, and using it is the difference between an
 * experiment and a site visit. Setting sw_tryactive boots a partition ONCE with
 * the watchdog armed; if the image does not come up, the next boot returns to
 * whatever sw_commit names, unattended. A trial that boots fine still reverts on
 * the following reboot, so keeping an image is a separate deliberate act.
 *
 * The obvious-looking alternative — writing sw_commit straight away — makes an
 * unproven image permanent before it has booted even once, and is what every
 * runbook for this device used to say.
 *
 * sw_active is U-Boot's own record of what it last booted. It is written by the
 * bootloader on every boot and is never set here.
 */
/* How much of the flasher's output /api/firmware carries: enough for the
 * last dozen lines, which say where it is and whether it failed. */
#define FWU_LOG_TAIL 1600

const char *confd_exe = "";

/*
 * What each slot actually holds, read off its kernel partition.
 *
 * U-Boot sw_version<p> is only what the last updater chose to record there:
 * odi-oss fwu.sh records nothing unless asked, and the stock one records
 * whatever its tarball says. On a live stick it named an odi-oss build for
 * the slot holding the stock firmware. The uImage header in k<p> is written
 * by the flash itself, so it cannot drift from the image: its name field
 * ("Linux Kernel Image" on the stock base, "Linux Kernel Image 6.18" on
 * odi-oss) and its build time are what the page judges a slot by.
 *
 * 64 bytes, read with read(2) from the mtd character device: no child, no
 * wait on another process, nothing to bound. The partition index comes from
 * /proc/mtd by name, never assumed.
 */
static int mtd_index(const char *mtds, const char *name)
{
	unsigned long i = 0;

	while (mtds[i]) {
		unsigned long ls = i, q;

		while (mtds[i] && mtds[i] != '\n')
			i++;
		/* mtd4: 00148000 00010000 "k0" */
		if (spre(mtds + ls, "mtd")) {
			for (q = ls; q < i && mtds[q] != '"'; q++)
				;
			if (q < i && spre(mtds + q + 1, name)
			    && mtds[q + 1 + str_len(name)] == '"') {
				int n = 0;

				for (q = ls + 3; mtds[q] >= '0' && mtds[q] <= '9'; q++)
					n = n * 10 + (mtds[q] - '0');
				return n;
			}
		}
		if (mtds[i] == '\n')
			i++;
	}
	return -1;
}

static void emit_slot(int fd, const char *mtds, char p)
{
	char part[3] = { 'k', p, 0 };
	char dev[16] = "/dev/mtd";
	unsigned char h[65];
	int idx = mtd_index(mtds, part);
	unsigned long n = 8, k;
	unsigned long t;

	put_fd(fd, "\"");
	write_all(fd, &p, 1);
	put_fd(fd, "\":{");
	if (idx < 0 || idx > 99)
		goto done;
	if (idx >= 10)
		dev[n++] = (char)('0' + idx / 10);
	dev[n++] = (char)('0' + idx % 10);
	dev[n] = 0;
	if (read_file(dev, (char *)h, sizeof(h)) != 64)
		goto done;
	/* IH_MAGIC, big-endian: anything else is not a uImage, and saying
	 * nothing is more honest than a guess. */
	if (h[0] != 0x27 || h[1] != 0x05 || h[2] != 0x19 || h[3] != 0x56)
		goto done;
	t = ((unsigned long)h[8] << 24) | ((unsigned long)h[9] << 16)
	  | ((unsigned long)h[10] << 8) | h[11];
	for (k = 32; k < 64 && h[k] >= 0x20 && h[k] < 0x7f; k++)
		;
	put_fd(fd, "\"kernel\":\"");
	put_json_str(fd, (const char *)h + 32, k - 32);
	put_fd(fd, "\",\"built\":");
	{
		char num[12];
		unsigned long m = 0;

		if (!t)
			num[m++] = '0';
		while (t) {
			num[m++] = (char)('0' + t % 10);
			t /= 10;
		}
		while (m)
			write_all(fd, &num[--m], 1);
	}
done:
	put_fd(fd, "}");
}

/* The sw_* lines of an `nv getenv` / `nv fallback` dump, as JSON members. */
static void emit_sw_pairs(int fd, const char *buf)
{
	unsigned long i = 0;
	int first = 1;

	while (buf[i]) {
		unsigned long ls = i, le = i, eq;

		while (buf[le] && buf[le] != '\n')
			le++;
		if (!spre(buf + ls, "sw_"))
			goto next;
		eq = ls;
		while (eq < le && buf[eq] != '=')
			eq++;
		if (eq == le)
			goto next;
		if (!first)
			put_fd(fd, ",");
		first = 0;
		put_fd(fd, "\"");
		put_json_str(fd, buf + ls, eq - ls);
		put_fd(fd, "\":\"");
		put_json_str(fd, buf + eq + 1, le - eq - 1);
		put_fd(fd, "\"");
next:
		i = (buf[le] == '\n') ? le + 1 : le;
	}
}

void emit_firmware_json(int fd)
{
	static char *const argv[] = { "nv", "getenv", 0 };
	char buf[4096];
	char ver[128];

	respond(fd, "200 OK", "application/json", 0);
	put_fd(fd, "{\"running\":\"");
	if (read_file("/etc/version", ver, sizeof(ver)) > 0) {
		unsigned long n = 0;

		while (ver[n] && ver[n] != '\n' && ver[n] != ' ')
			n++;
		put_json_str(fd, ver, n);
	}
	put_fd(fd, "\",\"mem\":\"");
	{
		/* Total RAM, so the upload note can state the real figure rather
		 * than a number baked into the page. */
		char mi[256];
		unsigned long k;

		if (read_file("/proc/meminfo", mi, sizeof(mi)) > 0) {
			for (k = 0; mi[k]; k++) {
				if (!spre(mi + k, "MemTotal:"))
					continue;
				k += 9;
				while (mi[k] == ' ')
					k++;
				{
					unsigned long e = k;

					while (mi[e] && mi[e] != ' ' && mi[e] != '\n')
						e++;
					/* kB -> MB, integer, good enough for a note */
					{
						unsigned long v = 0, q;

						for (q = k; q < e; q++)
							v = v * 10 + (unsigned long)(mi[q] - '0');
						v /= 1024;
						{
							char num[8];
							unsigned long n = 0;

							if (!v)
								num[n++] = '0';
							while (v) {
								num[n++] = (char)('0' + v % 10);
								v /= 10;
							}
							while (n)
								write_all(fd, &num[--n], 1);
						}
					}
				}
				break;
			}
		}
	}
	put_fd(fd, " MB\",\"env\":{");
	if (run_to_buf("/bin/nv", argv, buf, sizeof(buf), NV_TIMEOUT_MS) > 0)
		emit_sw_pairs(fd, buf);
	/*
	 * The OTHER copy of the redundant environment: what U-Boot uses if the
	 * winning copy is ever left invalid, which an interrupted setenv is how
	 * it happens. A plain setenv writes only the winning copy, so a trial
	 * can leave the two disagreeing about sw_commit, and a page that says
	 * "the next reboot returns to slot N" needs both answers. odi-oss nv
	 * prints it for `nv fallback`; the stock nv prints its usage text, which
	 * carries no sw_ line, so this is empty there rather than wrong.
	 */
	put_fd(fd, "},\"fallback\":{");
	{
		static char *const fargv[] = { "nv", "fallback", 0 };

		if (run_to_buf("/bin/nv", fargv, buf, sizeof(buf), NV_TIMEOUT_MS) > 0)
			emit_sw_pairs(fd, buf);
	}
	put_fd(fd, "},\"slots\":{");
	{
		char mtds[1024];

		if (read_file("/proc/mtd", mtds, sizeof(mtds)) <= 0)
			mtds[0] = 0;
		emit_slot(fd, mtds, '0');
		put_fd(fd, ",");
		emit_slot(fd, mtds, '1');
	}
	put_fd(fd, "},\"confd\":\"");
	put_json_cstr(fd, BUILD_ID);
	put_fd(fd, "\",\"exe\":\"");
	put_json_cstr(fd, confd_exe);
	put_fd(fd, "\"");

	/*
	 * A background write, if fwu_starter.sh started one: its state line
	 * split into fields, and the end of the flasher's output. The page
	 * polls this while the state says running.
	 */
	{
		char st[96];
		long n = read_file(FWU_STATE, st, sizeof(st));

		if (n > 0) {
			unsigned long i = 0, f;
			static const char *field[] = { "state", "pid", "slot", "rc" };

			put_fd(fd, ",\"write\":{");
			for (f = 0; f < 4; f++) {
				unsigned long b;

				while (st[i] == ' ')
					i++;
				b = i;
				while (st[i] && st[i] != ' ' && st[i] != '\n')
					i++;
				if (f)
					put_fd(fd, ",");
				put_fd(fd, "\"");
				put_fd(fd, field[f]);
				put_fd(fd, "\":\"");
				put_json_str(fd, st + b, i - b);
				put_fd(fd, "\"");
			}
			put_fd(fd, ",\"log\":\"");
			n = read_file(FWU_LOG, filebuf, sizeof(filebuf));
			if (n > 0) {
				/* The tail: the last lines are the ones that say
				 * where it is and whether it failed. */
				unsigned long from = (unsigned long)n > FWU_LOG_TAIL
					? (unsigned long)n - FWU_LOG_TAIL : 0;

				put_json_str(fd, filebuf + from, (unsigned long)n - from);
			}
			put_fd(fd, "\"}");
		}
	}

	/* The switch files this UI may toggle, and the override that makes
	 * LAN_IP_ADDR a dead letter while it exists. */
	put_fd(fd, ",\"switches\":{\"" SWITCH_OMCI_IDENTITY "\":");
	put_fd(fd, file_exists(SWITCH_DIR SWITCH_OMCI_IDENTITY) ? "true" : "false");
	put_fd(fd, "},\"lanip_override\":");
	put_fd(fd, file_exists(LANIP_OVERRIDE) ? "true" : "false");

	/* Which credential is in force. A built-in default nobody can see is the
	 * same thing as no password, so this is not decoration: it is what makes
	 * the fallback in confd.h defensible. */
	put_fd(fd, ",\"defaultauth\":");
	put_fd(fd, auth_is_default() ? "true" : "false");

	/* The build manifest, as an object. Emitted from the file rather than
	 * parsed into known fields: the build writes key=value lines, and a new
	 * component should appear here without a C change. */
	{
		char man[512];
		long n = read_file(BUILD_MANIFEST, man, sizeof(man));
		unsigned long i = 0;
		int first = 1;

		put_fd(fd, ",\"build\":{");
		if (n > 0) {
			while (man[i]) {
				unsigned long ls = i, le = i, eq;

				while (man[le] && man[le] != '\n')
					le++;
				eq = ls;
				while (eq < le && man[eq] != '=')
					eq++;
				if (eq == le || eq == ls)
					goto nextline;
				if (!first)
					put_fd(fd, ",");
				first = 0;
				put_fd(fd, "\"");
				put_json_str(fd, man + ls, eq - ls);
				put_fd(fd, "\":\"");
				put_json_str(fd, man + eq + 1, le - eq - 1);
				put_fd(fd, "\"");
nextline:
				i = (man[le] == '\n') ? le + 1 : le;
			}
		}
		put_fd(fd, "}}");
	}
}

int nv_set(const char *key, const char *value)
{
	char *argv[5];
	char buf[256];
	long code = -1;

	argv[0] = "nv";
	argv[1] = "setenv";
	argv[2] = (char *)key;
	argv[3] = (char *)value;
	argv[4] = 0;

	/*
	 * The exit code is the whole check here, and this used to test the byte
	 * count instead: `nv setenv` prints nothing on success, and a child that
	 * failed to exec exits 127 printing nothing too. So a missing /bin/nv
	 * answered {"ok":true,"note":"armed"} and the page said the partition
	 * was armed for one boot. sw_tryactive was never written, the reboot
	 * came up on the old image, and the natural conclusion was that the new
	 * image had failed its trial.
	 */
	if (run_to_buf_ex("/bin/nv", argv, buf, sizeof(buf), &code, NV_TIMEOUT_MS) < 0)
		return 0;
	return code == 0;
}

/*
 * Read one U-Boot variable.
 *
 * /api/firmware already emits every sw_* for the page, but a route that has to
 * DECIDE on one needs it in C -- and asking the page to send back what it was
 * told would let a caller choose its own answer.
 */
int nv_get(const char *key, char *out, unsigned long cap)
{
	static char *const argv[] = { "nv", "getenv", 0 };
	char buf[4096];
	unsigned long i = 0;

	out[0] = 0;
	if (run_to_buf("/bin/nv", argv, buf, sizeof(buf), NV_TIMEOUT_MS) <= 0)
		return 0;

	while (buf[i]) {
		unsigned long ls = i, le = i, eq, k = 0;

		while (buf[le] && buf[le] != '\n')
			le++;
		eq = ls;
		while (eq < le && buf[eq] != '=')
			eq++;
		if (eq < le && spre(buf + ls, key) && (ls + str_len(key)) == eq) {
			for (k = 0; eq + 1 + k < le && k + 1 < cap; k++)
				out[k] = buf[eq + 1 + k];
			out[k] = 0;
			return 1;
		}
		i = (buf[le] == '\n') ? le + 1 : le;
	}
	return 0;
}
