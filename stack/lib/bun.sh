#!/usr/bin/env bash
# stack/lib/bun.sh — finds Bun for a launcher. Sourced, never run.
#
# A script ported to TypeScript keeps its .sh path as a launcher, because the
# units, deploy.sh, pms-home.sh and other scripts name it:
#
#   REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"
#   . "$REPO/stack/lib/bun.sh" || exit 3
#   exec "$BUN" --no-install "$REPO/jobs/x/x.ts" "$@"
#
# systemd units set no PATH and neither does sudo, so Homebrew's bin is not on
# it there. First match wins:
#   1. PMS_BUN, if set (and then only it: a wrong one is an error, not skipped)
#   2. bun on PATH
#   3. /home/linuxbrew/.linuxbrew/bin/bun, where `brew install bun` puts it
# A candidate older than PMS_BUN_MIN is skipped. Sets BUN and BUN_VERSION, or
# says why on stderr and returns 3.
#
# Keep PMS_BUN_MIN at or below .bun-version (stack/lib/bun.test.sh checks it).
# The box pins Bun (`brew pin bun`): an unplanned upgrade would reach every job
# at once, arr-reclaim included.

# shellcheck disable=SC2034  # BUN and BUN_VERSION are for the script that sources this
PMS_BUN_MIN="1.4.0"
BUN_FALLBACK="/home/linuxbrew/.linuxbrew/bin/bun"
BUN=""
BUN_VERSION=""

# 0 when version $1 (x.y.z, any suffix ignored) is at least $2.
bun_version_at_least() { # version minimum
    local IFS=. i have want
    [[ "$1" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+) ]] || return 1
    read -r -a have <<<"${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.${BASH_REMATCH[3]}"
    read -r -a want <<<"$2"
    for i in 0 1 2; do
        (( 10#${have[i]} > 10#${want[i]:-0} )) && return 0
        (( 10#${have[i]} < 10#${want[i]:-0} )) && return 1
    done
    return 0
}

# Sets BUN/BUN_VERSION from the first usable candidate; 3 and a message when none is.
pms_bun() {
    local c v tried=() seen=" "
    if [[ -n "${PMS_BUN:-}" ]]; then
        set -- "$PMS_BUN"
    else
        set -- "$(command -v bun 2>/dev/null)" "$BUN_FALLBACK"
    fi
    for c in "$@"; do
        [[ -n "$c" && "$seen" != *" $c "* ]] || continue
        seen+="$c "
        if [[ ! -x "$c" ]]; then
            [[ -n "${PMS_BUN:-}" ]] && tried+=("$c: not an executable")
            continue
        fi
        v="$("$c" --version 2>/dev/null)"
        if bun_version_at_least "$v" "$PMS_BUN_MIN"; then
            BUN="$c"; BUN_VERSION="$v"
            return 0
        fi
        tried+=("$c: version '${v:-?}'")
    done
    {
        echo "No usable Bun (need $PMS_BUN_MIN or later)."
        [[ ${#tried[@]} -eq 0 ]] || printf '  %s\n' "${tried[@]}"
        echo "Install it as yourself, not with sudo: brew install bun && brew pin bun"
        echo "(or point PMS_BUN at a bun binary)"
    } >&2
    return 3
}

# Sourcing with BUN_LIB=1 gets the functions without the lookup (bun.test.sh).
[[ "${BUN_LIB:-0}" == "1" ]] || pms_bun
