#!/usr/bin/env bash
# stack/lib/arr-configure.sh: launcher; the script is arr-configure.ts (see its header).
REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"
. "$REPO/stack/lib/bun.sh" || exit 3
exec "$BUN" --no-install "$REPO/stack/lib/arr-configure.ts" "$@"
