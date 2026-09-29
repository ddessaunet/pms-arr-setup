#!/usr/bin/env bash
# deploy.test.sh — unit fixtures for tools/deploy.sh
#
#   tests/deploy.test.sh
#
# Offline, and changes nothing: the script is sourced with DEPLOY_LIB=1 so
# main() never runs, and systemctl is replaced by a stub.
#
# Covers which side of the cutover the timer follows. Installing units needs
# sudo and a live box: `npm run check` / `npm run deploy` are the rehearsal.

cd "$(dirname "$0")/.." || exit 1

export DEPLOY_LIB=1
# shellcheck source=SCRIPTDIR/../tools/deploy.sh
. ./tools/deploy.sh || { echo "cannot source tools/deploy.sh"; exit 1; }
set +euo pipefail   # deploy.sh runs strict; the fixtures check exit codes

PASS=0; FAIL=0

ok_rc() { # label want-rc cmd...
    local label="$1" want="$2"; shift 2
    "$@" >/dev/null 2>&1; local got=$?
    if [[ "$got" == "$want" ]]; then
        PASS=$((PASS + 1)); printf '  ok    %s\n' "$label"
    else
        FAIL=$((FAIL + 1)); printf '  FAIL  %s\n          want rc %s, got rc %s\n' "$label" "$want" "$got"
    fi
}

# ─── plex_runs_here ───────────────────────────────────────────────────────────
# systemctl is stubbed: STUB_OUT is what `is-enabled` prints, STUB_RC its exit
# status (non-zero for everything but enabled-like states, as the real one).
echo "plex_runs_here"
# shellcheck disable=SC2032  # a stub for plex_runs_here only; nothing here runs sudo
systemctl() { printf '%s' "${STUB_OUT:-}"; return "${STUB_RC:-0}"; }
runs_as() { STUB_OUT="$1" STUB_RC="$2" plex_runs_here; }

ok_rc "masked (Phase 1b) → here"           0 runs_as masked 1
ok_rc "masked-runtime → here"              0 runs_as masked-runtime 1
ok_rc "not installed (Phase 7b) → here"    0 runs_as "" 1
ok_rc "not-found → here"                   0 runs_as not-found 4
ok_rc "enabled (rolled back) → native"     1 runs_as enabled 0
ok_rc "disabled but installed → native"    1 runs_as disabled 1
ok_rc "static → native"                    1 runs_as static 0

# ─── summary ──────────────────────────────────────────────────────────────────
echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
