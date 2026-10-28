#!/usr/bin/env bash
# jobs/pms-update/update-stack.sh: launcher; the job is update-stack.ts (see its header).
REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"
. "$REPO/stack/lib/bun.sh" || exit 3
exec "$BUN" --no-install "$REPO/jobs/pms-update/update-stack.ts" "$@"
