#!/usr/bin/env bash
# jobs/stack-api/stack-api.sh: launcher; the service is stack-api.ts (see its header).
REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"
. "$REPO/stack/lib/bun.sh" || exit 3
exec "$BUN" --no-install "$REPO/jobs/stack-api/stack-api.ts" "$@"
