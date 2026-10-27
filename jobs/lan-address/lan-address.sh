#!/usr/bin/env bash
# jobs/lan-address/lan-address.sh: launcher; the job is lan-address.ts (see its header).
REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"
. "$REPO/stack/lib/bun.sh" || exit 3
exec "$BUN" --no-install "$REPO/jobs/lan-address/lan-address.ts" "$@"
