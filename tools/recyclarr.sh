#!/usr/bin/env bash
# recyclarr.sh — run Recyclarr once, as a throwaway container.
#
#   tools/recyclarr.sh sync --preview    (npm run recyclarr:preview) — changes nothing
#   tools/recyclarr.sh sync              (npm run recyclarr:sync)
#
# Any Recyclarr arguments pass through. The config is recyclarr/recyclarr.yml
# in this repo; afterwards run `npm run arr:configure` and `npm run
# seerr:configure` (docs/phases.md → Phase 6).

set -uo pipefail

REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
cd "$REPO" || exit 1

# Its state folder must be ours before Docker sees it: a missing bind source is
# created root:root, and Recyclarr runs as ${PUID}:${PGID} (the Phase 5 trap).
appdata="$(sed -n 's/^APPDATA=//p' .env 2>/dev/null | tail -n1)"; appdata="${appdata:-/opt/appdata}"
mkdir -p -- "$appdata/recyclarr" || exit 1

exec docker compose run --rm recyclarr "$@"
