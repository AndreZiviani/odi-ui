# The RLX5281 is big-endian MIPS-I. Debian's gcc-mips-linux-gnu targets exactly
# that when told to; see sfp-exporter's notes on why a stock cross-gcc is enough
# for freestanding code and why the RSDK is only needed once you link a libc.
FROM debian:bookworm-slim
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
      gcc-mips-linux-gnu libc6-dev-mips-cross binutils-mips-linux-gnu make file \
 && rm -rf /var/lib/apt/lists/*
