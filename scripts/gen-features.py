#!/usr/bin/env python3
"""
Generate schema/features.tsv: which bit of each OMCI_CUSTOM_* mask does what.

`OMCI_CUSTOM_BDP`, `_RDP`, `_MCAST` and `_ME` are the four least documented
settings on this device and among the most consequential. The ODI stick ships
with `OMCI_CUSTOM_RDP=4` and nobody upstream could say why -- that is
Anime4000/RTL960x#41, "What is OMCI_CUSTOM_RDP?", open since 2022 with "no
information on this", and #107 for the VEIP bit next to it.

They are not opaque. Each bit selects one plugin, and the plugin files NAME the
bit in their own filenames:

    lib/features/internal/rdp_00000004.so     -> OMCI_CUSTOM_RDP bit 0x4
    lib/modules/features/bdp_00000002.ko      -> OMCI_CUSTOM_BDP bit 0x2

and each one DEFINES the feature as a function. So the mapping is read out of
the ELF symbol table, not guessed from strings and not taken on trust from a
third party: regenerate against a different base and you learn what that base
implements rather than what this one did.

Reading symbols rather than printable runs is what makes it exact. An earlier
version took the string next to `feature_api_register` in the string table and
got `printf` for `me_00080000.so`, because a string table is not a call
sequence. That module defines TWO features, and the symbol table says so.

    scripts/gen-features.py <unpacked-rootfs> > schema/features.tsv

To unpack a base without installing squashfs-tools on a Mac:

    docker run --rm --entrypoint sh -v "$PWD/base.tar":/work/image.tar:ro \\
        -v /tmp/rootfs:/out odi-firmware-repack -c \\
        'cd /tmp && tar xf /work/image.tar rootfs \\
         && unsquashfs -d /tmp/sq rootfs >/dev/null && cp -r /tmp/sq/lib /out/'
"""
import os
import re
import struct
import sys

MASKS = {"bdp": "OMCI_CUSTOM_BDP", "rdp": "OMCI_CUSTOM_RDP",
         "mc": "OMCI_CUSTOM_MCAST", "me": "OMCI_CUSTOM_ME"}

# Everything the toolchain defines in every one of these modules. What is left
# after removing it is the feature.
BOILERPLATE = {
    "_init", "_fini", "__do_global_dtors_aux", "__do_global_ctors_aux",
    "frame_dummy", "feature_module_init", "feature_module_exit",
    "feature_module_opt_init", "init_module", "cleanup_module",
}

STT_FUNC = 2
SHN_UNDEF = 0


def defined_funcs(path):
    """Defined STT_FUNC symbols of a 32-bit big-endian ELF, in order, deduped."""
    d = open(path, "rb").read()
    if d[:4] != b"\x7fELF" or d[4] != 1 or d[5] != 2:
        return []

    (e_shoff,) = struct.unpack_from(">I", d, 0x20)
    e_shentsize, e_shnum, e_shstrndx = struct.unpack_from(">HHH", d, 0x2E)

    secs = []
    for i in range(e_shnum):
        o = e_shoff + i * e_shentsize
        name, _typ, _fl, _ad, off, size, link, _info, _al, _es = \
            struct.unpack_from(">IIIIIIIIII", d, o)
        secs.append((name, off, size, link))
    if e_shstrndx >= len(secs):
        return []
    shstr_off = secs[e_shstrndx][1]

    def cstr(base, at):
        end = d.index(b"\0", base + at)
        return d[base + at:end].decode("ascii", "replace")

    out, seen = [], set()
    for name, off, size, link in secs:
        if cstr(shstr_off, name) not in (".dynsym", ".symtab"):
            continue
        if link >= len(secs):
            continue
        strtab = secs[link][1]
        for i in range(size // 16):
            o = off + i * 16
            st_name, _val, _size, st_info, _other, st_shndx = \
                struct.unpack_from(">IIIBBH", d, o)
            if st_shndx == SHN_UNDEF or (st_info & 0xF) != STT_FUNC:
                continue
            nm = cstr(strtab, st_name)
            if not nm or nm in BOILERPLATE or nm in seen:
                continue
            seen.add(nm)
            out.append(nm)
    return out


def features(path):
    """The feature(s) a module implements. A module may implement more than one:
    me_00080000.so defines both treat_cir_of_traffic_descriptor and
    force_meterType_of_trafficDesc on the same bit."""
    names = defined_funcs(path)
    if path.endswith(".ko"):
        # Kernel modules carry no useful modinfo -- every one says "RealTek
        # OMCI kernel module" -- but they name themselves in omci_<x>_init.
        got = [m.group(1) for m in
               (re.fullmatch(r"omci_(.+)_init", n) for n in names) if m]
        return got or names
    return names


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: gen-features.py <unpacked-rootfs> > schema/features.tsv")
    root = sys.argv[1]

    rows = []
    for rel in ("lib/features/internal", "lib/modules/features"):
        d = os.path.join(root, rel)
        if not os.path.isdir(d):
            print(f"# no {rel} under {root}", file=sys.stderr)
            continue
        for fn in sorted(os.listdir(d)):
            m = re.fullmatch(r"(bdp|rdp|mc|me)_([0-9a-fA-F]{8})\.(so|ko)", fn)
            if not m:
                continue
            kind, hexbits, _ = m.groups()
            path = os.path.join(d, fn)
            for feature in features(path) or [""]:
                rows.append((MASKS[kind], "0x%x" % int(hexbits, 16), feature,
                             os.path.join(rel, fn)))

    if not rows:
        sys.exit("no feature modules found -- is that an unpacked rootfs?")

    order = list(MASKS.values())
    rows.sort(key=lambda r: (order.index(r[0]), int(r[1], 16), r[2]))

    print("# generated by scripts/gen-features.py from an unpacked rootfs --")
    print("# do not hand-edit. Each bit of an OMCI_CUSTOM_* mask loads one")
    print("# plugin; the filename IS the bit, and the feature is the function")
    print("# the plugin defines. A bit can carry more than one row.")
    print("mask\tbit\tfeature\tmodule")
    for r in rows:
        print("\t".join(r))
    unnamed = sum(1 for r in rows if not r[2])
    print(f"# {len(rows)} rows, {unnamed} without a name", file=sys.stderr)


if __name__ == "__main__":
    main()
