/*
 * The MIB side: what the schema says about a key, whether a value is allowed,
 * how a write is made and read back, and how the config files become JSON.
 *
 * The distinction that matters here is display form against address form. A
 * table row is SHOWN as SW_PORT_TBL[1].PVID and WRITTEN as SW_PORT_TBL.1.PVID;
 * handing the display form to `flash set` resolves to a different entry, writes
 * it, and exits 0. Writes therefore go through the schema's address column,
 * never through the name.
 */

#ifndef CONFD_MIB_H
#define CONFD_MIB_H

int type_ok(const char *type, const char *v);
int refused_key(const char *k);
int schema_lookup(const char *buf, const char *name,
		  char *addr, unsigned long dcap,
		  char *type, unsigned long tcap,
		  char *writable, unsigned long wcap,
		  char *apply, unsigned long acap);
int tsv_field(const char *buf, const char *name, unsigned long col,
	      char *out, unsigned long cap);
int meta_ok(const char *name, const char *v, const char **why);
int write_key(const char *addr, const char *value, char *out, unsigned long cap);
int apply_omci(void);
long load_values(void);
void emit_values_json(int fd, const char *buf);
void emit_tsv_json(int fd, const char *buf, const char **col, unsigned long ncol);

#endif /* CONFD_MIB_H */
