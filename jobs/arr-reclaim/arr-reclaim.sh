#!/usr/bin/env bash
# jobs/arr-reclaim/arr-reclaim.sh: launcher; the job is arr-reclaim.ts (see its header).
REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"
. "$REPO/stack/lib/bun.sh" || exit 3
exec "$BUN" --no-install "$REPO/jobs/arr-reclaim/arr-reclaim.ts" "$@"
