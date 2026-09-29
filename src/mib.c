/*
 * The MIB side: what the schema says about a key, whether a value is allowed,
 * how a write is made and read back, and how the config files become JSON.
 */

#include "confd.h"
#include "buffers.h"
#include "mib.h"

/*
 * Type-level validation, server side.
 *
 * The browser also checks ranges and option lists from meta.tsv, but that is a
 * convenience: anything reachable over HTTP has to be validated here too, since
 * a request need not come from the page.
 */
int type_ok(const char *type, const char *v)
{
	unsigned long i, dots = 0, digits = 0;

	if (seq(type, "int")) {
		if (!v[0])
			return 0;
		for (i = 0; v[i]; i++)
			if (v[i] < '0' || v[i] > '9')
				return 0;
		return 1;
	}
	if (seq(type, "ipv4")) {
		unsigned long oct = 0;

		/* Counting dots and digits is not enough: it accepts
		 * 1.2.3.400 and 999.999.999.999. Seven keys carry this type,
		 * LAN_IP_ADDR among them -- the address this UI is reached on. */
		for (i = 0; v[i]; i++) {
			if (v[i] == '.') {
				if (!digits || digits > 3 || oct > 255)
					return 0;
				digits = 0;
				oct = 0;
				dots++;
			} else if (v[i] >= '0' && v[i] <= '9') {
				oct = oct * 10 + (unsigned long)(v[i] - '0');
				digits++;
			} else {
				return 0;
			}
		}
		return dots == 3 && digits && digits <= 3 && oct <= 255;
	}
	if (seq(type, "mac") || seq(type, "hex32") || seq(type, "hexascii")) {
		unsigned long want = seq(type, "mac") ? 12 : (seq(type, "hex32") ? 32 : 0);

		for (i = 0; v[i]; i++)
			if (hexval(v[i]) < 0)
				return 0;
		if (i % 2)
			return 0;                  /* hex is whole bytes */
		return want ? (i == want) : 1;
	}
	if (seq(type, "hostport")) {
		/* host or host:port, the form busybox ntpd -p and syslogd -R
		 * both take: an IPv4 literal or a hostname, letters, digits,
		 * dots and hyphens, then an optional :1-65535. No spaces or
		 * quotes, which is the point: svc-syslogd.sh and svc-ntpd.sh
		 * read this value back out of the store into a command line. */
		unsigned long hlen = 0, port = 0, pdigits = 0;

		/* Empty clears the key (odi-oss flash removes it): remote
		 * logging and NTP off. */
		if (!v[0])
			return 1;

		for (i = 0; v[i] && v[i] != ':'; i++) {
			char c = v[i];

			if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
			      (c >= '0' && c <= '9') || c == '.' || c == '-'))
				return 0;
			hlen++;
		}
		if (!hlen || hlen > 253 || v[0] == '.' || v[0] == '-' ||
		    v[hlen - 1] == '.' || v[hlen - 1] == '-')
			return 0;
		if (v[i] == ':') {
			for (i++; v[i]; i++) {
				if (v[i] < '0' || v[i] > '9' || ++pdigits > 5)
					return 0;
				port = port * 10 + (unsigned long)(v[i] - '0');
			}
			return pdigits && port >= 1 && port <= 65535;
		}
		return 1;
	}
	if (seq(type, "ascii14")) {
		/* ONU_HW_VERSION: at most 14 printable ASCII characters, the
		 * width of the ONU-G version attribute. Empty clears the key
		 * (odi-oss flash removes it, and omcid then reports the device
		 * id). The three flash refuses -- a quote, < and & -- are
		 * refused here first. */
		if (!v[0])
			return 1;
		for (i = 0; v[i]; i++) {
			unsigned char c = (unsigned char)v[i];

			if (i >= 14 || c < 0x20 || c > 0x7e || c == '"' || c == '<' || c == '&')
				return 0;
		}
		return 1;
	}
	if (seq(type, "string"))
		return 1;

	/*
	 * An unrecognised type is refused, not waved through.
	 *
	 * This used to `return 1` for anything it did not know, which meant a
	 * typo in the schema's type column -- `itn` for `int` -- silently
	 * disabled validation for that key while every other check still
	 * passed. Failing closed turns that into a visible refusal instead.
	 * scripts/check-schema.py validates the column against this same set,
	 * so the two cannot drift apart unnoticed.
	 */
	return 0;
}

/*
 * Never writable, whatever the schema says.
 *
 * A wrong SerDes mode takes out telnet, ssh, this UI and the exporter
 * simultaneously, because every one of them arrives over that link. What is
 * left is a serial console behind soldered UART pads. The schema marks these
 * too; this list exists so that a bad schema edit cannot be the only thing
 * standing between a typo and a bricked stick.
 */
int refused_key(const char *k)
{
	return seq(k, "LAN_SDS_MODE") || seq(k, "LAN_SPEED_MODE") ||
	       seq(k, "FIBER_MODE");
}

/*
 * Look a key up in the schema, copying the columns the write path needs.
 *
 * `address` matters more than it looks. A table row is displayed as
 * SW_PORT_TBL[1].PVID, which is this project's own notation, while xmlconfig
 * wants SW_PORT_TBL.1.PVID. Handing the display form to `flash set` does not
 * fail — it resolves to a DIFFERENT entry, writes that, and exits 0 echoing
 * the wrong key. Silently writing the wrong setting while reporting success is
 * the worst failure available here, so the address column exists to make the
 * two forms impossible to confuse.
 */
int schema_lookup(const char *buf, const char *name,
			 char *addr, unsigned long dcap,
			 char *type, unsigned long tcap,
			 char *writable, unsigned long wcap,
			 char *apply, unsigned long acap)
{
	unsigned long i = 0;

	addr[0] = 0;
	type[0] = 0;
	writable[0] = 0;
	apply[0] = 0;
	while (buf[i]) {
		unsigned long ls = i, le = i, p, c, fs;

		while (buf[le] && buf[le] != '\n')
			le++;
		if (buf[ls] == '#' || ls == le)
			goto next;

		/* column 0 is the name */
		p = ls;
		while (p < le && buf[p] != '\t')
			p++;
		{
			unsigned long n = 0;

			while (name[n] && ls + n < p && name[n] == buf[ls + n])
				n++;
			if (name[n] || ls + n != p)
				goto next;
		}
		/*
		 * Every column through 6 must be present.
		 *
		 * The out-params were zeroed on entry, so a truncated row used
		 * to leave writable and type as "" -- and "" is neither "never"
		 * nor "identity", which made the key writable, and made type_ok
		 * return 1 for anything. A malformed row became the most
		 * permissive row in the file. It matters because confd prefers
		 * /etc/config/confd/keys.tsv, edited live on the device, which
		 * `make check` never sees.
		 */
		for (c = 1; c <= 6; c++) {
			if (p >= le)
				return 0;
			p++;
			fs = p;
			while (p < le && buf[p] != '\t')
				p++;
			if (c == 2) {
				unsigned long n = 0;

				while (fs + n < p && n + 1 < dcap)
					addr[n] = buf[fs + n], n++;
				addr[n] = 0;
			} else if (c == 4) {
				unsigned long n = 0;

				while (fs + n < p && n + 1 < tcap)
					type[n] = buf[fs + n], n++;
				type[n] = 0;
			} else if (c == 5) {
				unsigned long n = 0;

				while (fs + n < p && n + 1 < acap)
					apply[n] = buf[fs + n], n++;
				apply[n] = 0;
			} else if (c == 6) {
				unsigned long n = 0;

				while (fs + n < p && n + 1 < wcap)
					writable[n] = buf[fs + n], n++;
				writable[n] = 0;
			}
		}
		return 1;
next:
		i = (buf[le] == '\n') ? le + 1 : le;
	}
	return 0;
}

/*
 * Column `col` of the row whose first column is `name`. Same shape as
 * schema_lookup, but for the files where only one field is wanted.
 *
 * A row shorter than `col` yields an empty string and 0, so a caller cannot
 * mistake "the file does not say" for "the file says nothing applies".
 */
int tsv_field(const char *buf, const char *name, unsigned long col,
		     char *out, unsigned long cap)
{
	unsigned long i = 0;

	out[0] = 0;
	while (buf[i]) {
		unsigned long ls = i, le = i, p, c, fs, n = 0;

		while (buf[le] && buf[le] != '\n')
			le++;
		if (buf[ls] == '#' || ls == le)
			goto next;

		p = ls;
		while (p < le && buf[p] != '\t')
			p++;
		while (name[n] && ls + n < p && name[n] == buf[ls + n])
			n++;
		if (name[n] || ls + n != p)
			goto next;

		for (c = 1; c <= col; c++) {
			if (p >= le)
				return 0;      /* short row */
			p++;
			fs = p;
			while (p < le && buf[p] != '\t')
				p++;
			if (c == col) {
				unsigned long k = 0;

				while (fs + k < p && k + 1 < cap)
					out[k] = buf[fs + k], k++;
				out[k] = 0;
				return 1;
			}
		}
		return 0;
next:
		i = (buf[le] == '\n') ? le + 1 : le;
	}
	return 0;
}

/*
 * The range and option-list checks from meta.tsv, enforced server side.
 *
 * The browser applies these too, but that was ALL that applied them: an
 * out-of-range VLAN ID typed into the page was marked invalid in red and then
 * POSTed anyway, because save() never consulted the marking and the daemon had
 * no notion of a range at all. A VLAN ID of 99999 is a valid integer and was
 * written to flash as one.
 *
 * Returns 0 and fills `why` when the value is not acceptable.
 */
int meta_ok(const char *name, const char *v, const char **why)
{
	char field[512];

	*why = 0;

	if (tsv_field(meta, name, 3, field, sizeof(field)) && field[0]) {
		unsigned long i = 0;
		int found = 0;

		/* options are value=label pairs joined by '|'. Only the value
		 * half is compared; the label is for the page. */
		while (field[i] && !found) {
			unsigned long vs = i, k = 0;

			while (field[i] && field[i] != '=' && field[i] != '|')
				i++;
			if (field[i] == '=') {
				while (vs + k < i && v[k] && v[k] == field[vs + k])
					k++;
				if (vs + k == i && !v[k])
					found = 1;
			}
			while (field[i] && field[i] != '|')
				i++;
			if (field[i] == '|')
				i++;
		}
		if (!found) {
			*why = "not one of the values this key accepts";
			return 0;
		}
	}

	if (tsv_field(meta, name, 5, field, sizeof(field)) && field[0]) {
		unsigned long i = 0, lo = 0, hi = 0, n = 0;

		while (field[i] >= '0' && field[i] <= '9')
			lo = lo * 10 + (unsigned long)(field[i++] - '0');
		if (field[i] != '-')
			return 1;              /* malformed range: check-schema.py catches it */
		i++;
		while (field[i] >= '0' && field[i] <= '9')
			hi = hi * 10 + (unsigned long)(field[i++] - '0');
		if (field[i])
			return 1;

		/* Reached only for a key whose type already proved it decimal. */
		for (i = 0; v[i]; i++) {
			if (v[i] < '0' || v[i] > '9')
				return 1;
			n = n * 10 + (unsigned long)(v[i] - '0');
			if (n > 0xffffff)
				break;
		}
		if (n < lo || n > hi) {
			*why = "outside the range this key accepts";
			return 0;
		}
	}
	return 1;
}

/*
 * Write one key and read it back.
 *
 * `flash set` is used rather than driving xmlconfig directly because it also
 * decides whether the value belongs in the CS or the HS file, which is not
 * something to reimplement. Exactly three arguments matter: with more, flash
 * treats them as a list to hex-encode and concatenate. Values reach execve as
 * one argv element with no shell in between, so a space or a quote in a value
 * is data rather than syntax.
 *
 * The read-back is the point. `flash set` cannot clear a key at all — its set
 * branch is guarded by [ "$3" != "" ], so an empty value falls through to the
 * usage text and exits 1 while looking like it worked.
 */
int write_key(const char *addr, const char *value, char *out, unsigned long cap)
{
	char *argv[5];
	char buf[512];
	unsigned long i = 0, vs;

	argv[0] = "flash";
	argv[1] = "set";
	argv[2] = (char *)addr;
	argv[3] = (char *)value;
	argv[4] = 0;

	if (run_to_buf(FLASH_PATH, argv, buf, sizeof(buf), FLASH_TIMEOUT_MS) <= 0)
		return 0;

	/* flash echoes "KEY=value" from its own xmlconfig -g when it is done. */
	while (buf[i] && buf[i] != '=')
		i++;
	if (!buf[i])
		return 0;
	vs = ++i;
	while (buf[i] && buf[i] != '\n' && buf[i] != '\r')
		i++;
	{
		unsigned long n = 0;

		while (vs + n < i && n + 1 < cap)
			out[n] = buf[vs + n], n++;
		out[n] = 0;
	}
	return seq(out, value);
}

/*
 * Restart the OMCI stack so a change takes effect without a reboot.
 *
 * PATH is not optional: omci_app shells out to `flash` itself and inherits it,
 * and without /etc/scripts it reads a zero MAC and exits with
 * "GPON mac_check fail", taking the ONU off the line. runomci.sh also calls
 * runigmp.sh, which noisily fails to re-insmod a loaded module and to start a
 * second igmpd; neither is an error worth reporting.
 */
int apply_omci(void)
{
	static char *const argv[] = { "sh", 0 };
	static const char script[] =
		"PATH=$PATH:/etc/scripts\n"
		"kill $(pidof omci_app) 2>/dev/null\n"
		"i=0; while [ $i -lt 15 ] && pidof omci_app >/dev/null 2>&1; do sleep 1; i=$((i+1)); done\n"
		"trap '' HUP\n"
		"( /etc/runomci.sh >/dev/null 2>&1 & )\n"
		"sleep 3\n"
		"pidof omci_app >/dev/null 2>&1 && echo APPLIED || echo FAILED\n";
	char buf[256];
	unsigned long i;

	if (run_script_to_buf("/bin/sh", argv, script, buf, sizeof(buf),
			      APPLY_TIMEOUT_MS) <= 0)
		return 0;
	for (i = 0; buf[i]; i++)
		if (spre(buf + i, "APPLIED"))
			return 1;
	return 0;
}

/*
 * `flash all cs` and `flash all hs` — two forks for every value on the device.
 * Reading them key by key would be 184 forks at ~30 ms each, which is a five
 * second page load; the cost of a fork here is the process, not the work.
 */
long load_values(void)
{
	static char *const cs[] = { "flash", "all", "cs", 0 };
	static char *const hs[] = { "flash", "all", "hs", 0 };
	long a, b;

	a = run_to_buf(FLASH_PATH, cs, values, sizeof(values), FLASH_TIMEOUT_MS);
	if (a <= 0)
		return -1;
	b = run_to_buf(FLASH_PATH, hs, values + a, sizeof(values) - (unsigned long)a,
		       FLASH_TIMEOUT_MS);
	return b < 0 ? a : a + b;
}

/*
 * Emit {"NAME":"value",...} from `flash all` XML.
 *
 * Table rows are keyed as TBL[index].Field so they are addressable and match
 * what gen-schema.py writes, since the browser joins the two by name.
 */
void emit_values_json(int fd, const char *buf)
{
	unsigned long i = 0;
	int first = 1;
	char table[64];
	char index[8];

	table[0] = 0;
	index[0] = 0;

	put_fd(fd, "{");
	while (buf[i]) {
		unsigned long ls = i, le = i;

		while (buf[le] && buf[le] != '\n')
			le++;

		/* Skip indentation before matching. `flash all` indents with
		 * spaces and /etc/config_default*.xml with tabs, and matching
		 * literal prefixes meant the defaults file parsed as zero
		 * values — an empty answer that looked like "no defaults" rather
		 * than a parse failure. */
		while (ls < le && (buf[ls] == ' ' || buf[ls] == '\t'))
			ls++;

		if (spre(buf + ls, "<Dir Name=\"")) {
			unsigned long p = ls, n = 0;

			while (p < le && buf[p] != '"')
				p++;
			p++;
			while (p < le && buf[p] != '"' && n + 1 < sizeof(table))
				table[n++] = buf[p++];
			table[n] = 0;
			index[0] = 0;
			if (seq(table, "MIB_TABLE") || seq(table, "HW_MIB_TABLE"))
				table[0] = 0;
			/* <!--index=N--> on the same line */
			for (p = ls; p + 8 < le; p++) {
				if (spre(buf + p, "index=")) {
					unsigned long m = 0;

					p += 6;
					while (p < le && buf[p] >= '0' && buf[p] <= '9' &&
					       m + 1 < sizeof(index))
						index[m++] = buf[p++];
					index[m] = 0;
					break;
				}
			}
			goto next;
		}

		if (spre(buf + ls, "<Value Name=\"")) {
			unsigned long p = ls, ks, ke, vs, ve;

			while (p < le && buf[p] != '"')
				p++;
			ks = ++p;
			while (p < le && buf[p] != '"')
				p++;
			ke = p;
			p++;
			while (p < le && buf[p] != '"')
				p++;
			vs = ++p;
			while (p < le && buf[p] != '"')
				p++;
			ve = p;
			if (ke <= ks || ve < vs)
				goto next;

			/*
			 * A value inside a table Dir that carries no index has
			 * no addressable form -- TBL..Field is not a thing
			 * xmlconfig accepts -- so it is dropped rather than
			 * emitted bare. Emitted bare it would collide with a
			 * real scalar of the same name, and the four
			 * implementations of this parser disagreed about it:
			 * gen-schema.py dropped it and the other three did not.
			 */
			if (table[0] && !index[0])
				goto next;

			if (!first)
				put_fd(fd, ",");
			first = 0;
			put_fd(fd, "\"");
			if (table[0] && index[0]) {
				put_json_cstr(fd, table);
				put_fd(fd, "[");
				put_json_cstr(fd, index);
				put_fd(fd, "].");
			}
			put_json_str(fd, buf + ks, ke - ks);
			put_fd(fd, "\":\"");
			put_json_str(fd, buf + vs, ve - vs);
			put_fd(fd, "\"");
		}
next:
		i = (buf[le] == '\n') ? le + 1 : le;
	}
	put_fd(fd, "}");
}

/*
 * A TSV as JSON rows, given the column names. Comment lines and the header are
 * skipped, so the files stay readable and self-documenting on disk.
 */
void emit_tsv_json(int fd, const char *buf, const char **col, unsigned long ncol)
{
	unsigned long i = 0;
	int first = 1;

	put_fd(fd, "[");
	while (buf[i]) {
		unsigned long ls = i, le = i, p, c;

		while (buf[le] && buf[le] != '\n')
			le++;

		if (buf[ls] == '#' || ls == le || spre(buf + ls, "name\t"))
			goto next;   /* comment, blank line, or the header */

		if (!first)
			put_fd(fd, ",");
		first = 0;
		put_fd(fd, "{");
		p = ls;
		for (c = 0; c < ncol; c++) {
			unsigned long fs = p;

			while (p < le && buf[p] != '\t')
				p++;
			if (c)
				put_fd(fd, ",");
			put_fd(fd, "\"");
			put_fd(fd, col[c]);
			put_fd(fd, "\":\"");
			put_json_str(fd, buf + fs, p - fs);
			put_fd(fd, "\"");
			if (p < le)
				p++;
		}
		put_fd(fd, "}");
next:
		i = (buf[le] == '\n') ? le + 1 : le;
	}
	put_fd(fd, "]");
}
