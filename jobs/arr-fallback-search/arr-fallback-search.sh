#!/usr/bin/env bash
# jobs/arr-fallback-search/arr-fallback-search.sh: launcher; the job is arr-fallback-search.ts (see its header).
REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"
. "$REPO/stack/lib/bun.sh" || exit 3
exec "$BUN" --no-install "$REPO/jobs/arr-fallback-search/arr-fallback-search.ts" "$@"
