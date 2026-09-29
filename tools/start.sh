#!/usr/bin/env bash
# start.sh — preflight, then bring up whatever the current phase has enabled.
#
#   tools/start.sh        (npm start)
#
# Never passes --profile. A service a phase keeps behind a profile starts only
# through its runbook step in docs/phases.md, so this can be run at any time
# without starting something a phase has not reached.

set -uo pipefail

REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
cd "$REPO" || exit 1

# Create every missing ${APPDATA}/<service> bind source as YOU, first. Left to
# Docker, a missing bind source is created as root:root — harmless for the
# linuxserver images, which start as root and chown their /config, but fatal
# for an image that runs unprivileged from the start (Seerr runs as `node`:
# EACCES on /app/config, restart loop). $APPDATA is ours, so no sudo is needed.
appdata="$(sed -n 's/^APPDATA=//p' .env 2>/dev/null | tail -n1)"; appdata="${appdata:-/opt/appdata}"
while IFS= read -r src; do
    [[ -n "$src" && ! -e "$src" ]] || continue
    mkdir -p -- "$src" && echo "created $src"
done < <(docker compose --profile '*' config --format json 2>/dev/null \
    | jq -r --arg a "$appdata/" '.services[].volumes[]? | select(.type == "bind") | .source | select(startswith($a))')

tools/preflight.sh || { echo "Preflight failed — not starting anything." >&2; exit 1; }
echo

# With every service behind a profile, compose answers a bare `up` with
# "no service selected" and exit 1, which reads like a fault. It is not one.
if [[ -z "$(docker compose config --services 2>/dev/null)" ]]; then
    echo "Nothing to start yet: every service is behind a profile until its phase."
    echo "See docs/phases.md for the step that starts the next one."
    exit 0
fi

docker compose up -d || exit 1
echo
docker compose ps
