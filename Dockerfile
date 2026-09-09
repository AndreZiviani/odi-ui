# The RLX5281 is big-endian MIPS-I. Debian's gcc-mips-linux-gnu targets exactly
# that when told to; see sfp-exporter's notes on why a stock cross-gcc is enough
# for freestanding code and why the RSDK is only needed once you link a libc.
FROM debian:bookworm-slim
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
      gcc-mips-linux-gnu libc6-dev-mips-cross binutils-mips-linux-gnu make file \
      qemu-user-static curl python3 \
 && rm -rf /var/lib/apt/lists/*

# qemu-user-static runs the big-endian MIPS binary on the build host, which is
# what makes scripts/smoke.sh possible: the HTTP layer can be exercised without
# a stick, and the request parsing this daemon does is exactly the part where a
# mistake is silent on real hardware.
