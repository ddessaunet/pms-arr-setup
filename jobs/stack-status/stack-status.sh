#!/usr/bin/env bash
# jobs/stack-status/stack-status.sh: launcher; the script is stack-status.ts (see its header).
REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"
. "$REPO/stack/lib/bun.sh" || exit 3
exec "$BUN" --no-install "$REPO/jobs/stack-status/stack-status.ts" "$@"
