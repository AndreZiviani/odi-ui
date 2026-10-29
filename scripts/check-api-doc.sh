#!/bin/sh
# Every route src/routes.c answers is listed in docs/API.md, and every route
# the docs list exists. A route shipped without its line is how /api/ntp and
# eight others went undocumented. serve_public() names its routes by `target`.
set -eu
cd "$(dirname "$0")/.."
code=$(grep -ohE 'seq\((path|target), "/api/[a-z0-9_-]+"' src/routes.c | grep -oE '/api/[a-z0-9_-]+' | sort -u)
doc=$(grep -ohE '(GET|POST) +/api/[a-z0-9_-]+' docs/API.md | grep -oE '/api/[a-z0-9_-]+' | sort -u)
missing=$(printf '%s\n' "$code" | grep -vxF "$doc" || true)
stale=$(printf '%s\n' "$doc" | grep -vxF "$code" || true)
[ -z "$missing" ] || { echo "routes missing from docs/API.md:"; echo "$missing"; }
[ -z "$stale" ] || { echo "docs/API.md lists routes src/routes.c does not answer:"; echo "$stale"; }
[ -z "$missing$stale" ] || exit 1
echo "api doc ok: $(printf '%s\n' "$code" | wc -l | tr -d ' ') routes"
