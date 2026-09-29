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
