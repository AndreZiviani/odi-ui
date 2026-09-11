/*
 * Reading the OMCI MIB — the OLT's own description of the service it has
 * provisioned on this ONU.
 *
 * This is the half of the device the config page cannot show. The keys in
 * `flash` are what WE asked for; the MIB is what the line actually built, and
 * when those two disagree the MIB is right. Nearly every "O5 but no traffic"
 * report on this hardware is settled by two of these tables, which is why they
 * have a page rather than a shell command.
 *
 * Three properties hold everything here together:
 *
 *   - It is read-only. No route reaches `omcicli mib set`.
 *   - Nothing derived from the request is ever concatenated into a command.
 *     run_to_buf_ex execve()s omcicli directly, so there is no shell to quote
 *     for -- but the arguments are still domain-checked, so a bad one fails as
 *     "not a MIB table" here instead of as whatever omcicli makes of it.
 *   - The output is returned verbatim. Every attribute this firmware prints is
 *     laid out differently from the last, and a parser in C would have to be
 *     rebuilt for each one; the browser can afford to be permissive, and the
 *     raw view is worth having on its own.
 */

#include "confd.h"
#include "buffers.h"
#include "http.h"
#include "omci.h"

/*
 * A class id or a table name. The names are exactly the set registered by
 * /lib/omci/mib_*.so in the image -- 81 of them on the 2022 base -- and the
 * numbers are their G.988 class ids; omcicli takes either.
 */
static int me_token_ok(const char *s)
{
	unsigned long i;

	for (i = 0; s[i]; i++) {
		char c = s[i];

		if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
		      (c >= '0' && c <= '9') || c == '_'))
			return 0;
	}
	return i > 0 && i <= 32;
}

/* An entity id, in the form omcicli prints them: hex, 0x optional. */
static int entity_ok(const char *s)
{
	unsigned long i = 0;

	if (s[0] == '0' && (s[1] == 'x' || s[1] == 'X'))
		i = 2;
	if (!s[i])
		return 0;
	for (; s[i]; i++)
		if (hexval(s[i]) < 0)
			return 0;
	return i <= 10;
}

/*
 * Run omcicli and answer with what it printed.
 *
 * `truncated` is reported rather than hidden. `mib get all` on a provisioned
 * line does not fit in any buffer worth giving it, and a silently short answer
 * would read as "the OLT provisioned nothing", which is the single most
 * misleading thing this page could say.
 */
static void emit_omcicli(int fd, char *const argv[])
{
	long got, code = -1;

	got = run_to_buf_ex(OMCICLI_PATH, argv, omci, sizeof(omci), &code);
	if (got < 0) {
		respond(fd, "500 Internal Server Error", "application/json", 0);
		put_fd(fd, "{\"error\":\"could not run omcicli\"}");
		return;
	}

	respond(fd, "200 OK", "application/json", 0);
	put_fd(fd, "{\"raw\":\"");
	put_json_cstr(fd, omci);
	put_fd(fd, "\",\"truncated\":");
	put_fd(fd, ((unsigned long)got + 1 >= sizeof(omci)) ? "true" : "false");

	/*
	 * 127 is run_to_buf_ex's own "execve failed", not omcicli's. Saying so
	 * separates "this image has no omcicli" from "omcicli did not like the
	 * arguments", which are fixed in completely different places.
	 */
	if (code == 0) {
		put_fd(fd, ",\"ok\":true}");
	} else if (code == 127) {
		put_fd(fd, ",\"ok\":false,\"error\":\"no omcicli in this image\"}");
	} else {
		put_fd(fd, ",\"ok\":false,\"error\":\"omcicli refused the request\"}");
	}
}

static void bad(int fd, const char *why)
{
	respond(fd, "400 Bad Request", "application/json", 0);
	put_fd(fd, "{\"error\":\"");
	put_json_cstr(fd, why);
	put_fd(fd, "\"}");
}

void emit_omci_json(int fd, const char *query)
{
	static char me[40], entity[16], what[16], cmd[16];
	char *argv[6];

	/* Check the return, not just the buffer: form_get decodes every value it
	 * walks past into `out`, so a query with no `cmd` at all can leave the
	 * last field's value sitting there. */
	if (!form_get(query, "cmd", cmd, sizeof(cmd))) {
		bad(fd, "cmd must be me, tables or dump");
		return;
	}

	/*
	 * The registered table list, from the running stack rather than from
	 * the image. /lib/omci/mib_*.so says what COULD be registered; only the
	 * stack knows what is, and on a line that never reached O5 the
	 * difference is the whole answer.
	 */
	if (seq(cmd, "tables")) {
		argv[0] = "omcicli"; argv[1] = "get"; argv[2] = "tables"; argv[3] = 0;
		emit_omcicli(fd, argv);
		return;
	}

	/*
	 * The data-path dumps. Allowlisted by name rather than passed through,
	 * because `omcicli dump` also takes `avltree [avlkeyid]` and the
	 * argument shape differs per verb.
	 */
	if (seq(cmd, "dump")) {
		if (!form_get(query, "what", what, sizeof(what)) ||
		    (!seq(what, "conn") && !seq(what, "srvflow") &&
		     !seq(what, "qmap") && !seq(what, "tasks"))) {
			bad(fd, "dump takes conn, srvflow, qmap or tasks");
			return;
		}
		argv[0] = "omcicli"; argv[1] = "dump"; argv[2] = what; argv[3] = 0;
		emit_omcicli(fd, argv);
		return;
	}

	if (!seq(cmd, "me")) {
		bad(fd, "cmd must be me, tables or dump");
		return;
	}

	if (!form_get(query, "me", me, sizeof(me)) || !me_token_ok(me)) {
		bad(fd, "me must be a class id or a MIB table name");
		return;
	}

	argv[0] = "omcicli"; argv[1] = "mib"; argv[2] = "get"; argv[3] = me;
	argv[4] = 0;
	argv[5] = 0;

	/*
	 * The entity id is optional, and omitting it means "every instance",
	 * which is what the pages ask for. It is passed as its own argument
	 * because that is how `omcicli mib set <class> <entity> ...` takes it.
	 */
	if (form_get(query, "entity", entity, sizeof(entity)) && entity[0]) {
		if (!entity_ok(entity)) {
			bad(fd, "entity must be a hex id");
			return;
		}
		argv[4] = entity;
	}

	emit_omcicli(fd, argv);
}
