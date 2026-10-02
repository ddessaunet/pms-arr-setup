#!/usr/bin/env bash
# apps/recyclarr/run.sh — run Recyclarr once, as a throwaway container.
#
#   apps/recyclarr/run.sh sync --preview    (task recyclarr:preview) — changes nothing
#   apps/recyclarr/run.sh sync              (task recyclarr:sync)
#
# Any Recyclarr arguments pass through. The config is recyclarr.yml beside this
# script; afterwards run `task arr:configure` and `task seerr:configure`
# (docs/phases.md → Phase 6).

set -uo pipefail

REPO="$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)"
cd "$REPO" || exit 1

# Its state folder must be ours before Docker sees it: a missing bind source is
# created root:root, and Recyclarr runs as ${PUID}:${PGID} (the Phase 5 trap).
appdata="$(sed -n 's/^APPDATA=//p' .env 2>/dev/null | tail -n1)"; appdata="${appdata:-/opt/appdata}"
mkdir -p -- "$appdata/recyclarr" || exit 1

exec docker compose run --rm recyclarr "$@"
