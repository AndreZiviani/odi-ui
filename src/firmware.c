/*
 * Boot selection and the firmware view.
 */

#include "confd.h"
#include "http.h"
#include "firmware.h"

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
void emit_firmware_json(int fd)
{
	static char *const argv[] = { "nv", "getenv", 0 };
	char buf[4096];
	char ver[128];
	unsigned long i = 0;
	int first = 1;

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

	if (run_to_buf("/bin/nv", argv, buf, sizeof(buf)) > 0) {
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
	put_fd(fd, "},\"confd\":\"");
	put_json_cstr(fd, BUILD_ID);
	put_fd(fd, "\"");

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
	if (run_to_buf_ex("/bin/nv", argv, buf, sizeof(buf), &code) < 0)
		return 0;
	return code == 0;
}
