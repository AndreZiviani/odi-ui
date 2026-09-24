#!/usr/bin/env bash
#
# Refuse to publish a confd whose build stamp does not name the release.
#
# BUILD_ID is `git describe --tags --always --dirty`, compiled in. v1.0.1 was
# published from a binary built by hand before the release workflow existed,
# out of a tree that still sat on v1.0.0 with the SSH-key change uncommitted:
# the stick running it reports v1.0.0-dirty while /etc/odi-build says v1.0.1,
# and the whole point of the stamp -- which build is answering -- was lost.
#
# So, before anything is published: HEAD must be exactly a v* tag, the tree
# must be clean, and build/confd must carry that tag and nothing else as its
# stamp. `make release` runs this, and so does the workflow on a tag.
set -euo pipefail
cd "$(dirname "$0")/.."

BIN=${1:-build/confd}
fail() { echo "check-stamp: $*" >&2; exit 1; }

tag=$(git describe --tags --exact-match 2>/dev/null) ||
	fail "HEAD is not a tag; a release is built from its tag only"
case "$tag" in v*) ;; *) fail "$tag is not a v* release tag" ;; esac
[ -z "$(git status --porcelain --untracked-files=no)" ] ||
	fail "the tree has uncommitted changes; the stamp would say -dirty"
[ -f "$BIN" ] || fail "no $BIN -- run make confd first"
# The backup header concatenates the stamp into one literal, so the exact
# string is findable in the stripped binary.
grep -a -q -F "confd build $tag -->" "$BIN" ||
	fail "$BIN is not stamped $tag (rebuild it: make clean confd)"
echo "check-stamp: $BIN is $tag"
