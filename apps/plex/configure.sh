#!/usr/bin/env bash
# apps/plex/configure.sh: launcher; the script is configure.ts (see its header).
REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"
. "$REPO/stack/lib/bun.sh" || exit 3
exec "$BUN" --no-install "$REPO/apps/plex/configure.ts" "$@"
