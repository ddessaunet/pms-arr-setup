#!/usr/bin/env bash
# update-stack.sh — weekly, safe image updates for the running containers.
#
#   tools/update-stack.sh               update every service in UPDATE_SERVICES
#   tools/update-stack.sh plex          update just these
#   tools/update-stack.sh --dry-run     pull and report; never recreate anything
#
# Run weekly by pms-update.timer (systemd/). It is the container counterpart of
# pms-local's plex-update.sh and keeps that script's rules:
#
#   - never interrupt a stream: Plex with active sessions waits a week
#   - a missing or rejected token is a failure, not a guess
#   - an update counts only once the service is answering again
#
# and adds the one native could not do: go back to the previous image.
#
# --dry-run still pulls. Pulling only downloads; the running container is not
# touched until something recreates it.
#
# Exit codes — the unit's failed state is the alert, as with plex-update:
#   0  updated, already current, deferred for a stream, not running, or locked
#   3  preflight: docker, .env or compose unusable
#   4  Plex token unreadable or rejected: cannot tell whether anyone is streaming
#   5  Plex is running but will not answer: session state unknown
#   6  pull failed
#   9  new image did not come up healthy; rolled back and the old one is serving
#  10  the rollback failed too: the service is DOWN — see docs/updating.md
#
# With several services, each is tried and the worst code wins.

set -uo pipefail

REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"

# Reads one KEY from .env without sourcing it; the environment wins.
env_get() {
    [[ -f "$REPO/.env" ]] || return 0
    sed -n "s/^$1=//p" "$REPO/.env" | tail -n1
}

APPDATA="${APPDATA:-$(env_get APPDATA)}"
APPDATA="${APPDATA:-/opt/appdata}"
UPDATE_SERVICES="${UPDATE_SERVICES:-$(env_get UPDATE_SERVICES)}"
UPDATE_SERVICES="${UPDATE_SERVICES:-plex}"
UPDATE_HEALTH_WAIT="${UPDATE_HEALTH_WAIT:-$(env_get UPDATE_HEALTH_WAIT)}"
UPDATE_HEALTH_WAIT="${UPDATE_HEALTH_WAIT:-180}"
UPDATE_LOCK="${UPDATE_LOCK:-$APPDATA/.update-stack.lock}"
DRY_RUN="${DRY_RUN:-0}"

# Host-networked, so this is the real server, as it is for pms-local's scripts.
PLEX_URL="${PLEX_URL:-http://127.0.0.1:32400}"
PLEX_PREFS="${PLEX_PREFS:-$APPDATA/plex/Library/Application Support/Plex Media Server/Preferences.xml}"
PLEX_TIMEOUT="${PLEX_TIMEOUT:-10}"

# How long a service with no identity check must stay up to count as healthy.
STEADY_SECS="${STEADY_SECS:-20}"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

short() { printf '%s' "${1#sha256:}" | cut -c1-12; }

# Per-service hooks are plain functions named <hook>_<service>, dashes as
# underscores. A service with none gets the defaults: no gate, and "running
# steadily" as health. Adding a service is adding it to UPDATE_SERVICES, plus
# hooks only if it needs them.
hook() { printf '%s_%s' "$1" "${2//-/_}"; }
has_hook() { declare -F "$(hook "$1" "$2")" >/dev/null; }

# ─── docker ───────────────────────────────────────────────────────────────────
# Naming a service on the command line enables its profile, so these also work
# on a service a phase still keeps behind one.
container_of() { docker compose ps -q "$1" 2>/dev/null | head -1; }
image_ref()    { docker inspect -f '{{.Config.Image}}' "$1"; }
image_of()     { docker inspect -f '{{.Image}}' "$1"; }
image_id()     { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null; }
running()      { [[ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" == true ]]; }
recreate()     { docker compose up -d --no-deps "$1"; }

# ─── plex ─────────────────────────────────────────────────────────────────────
# The server's own token, straight from its config: nothing to keep in sync,
# and it is the admin token /status/sessions needs. Sent as a header, so it
# never lands in a URL, a log line or `ps`.
plex_token() {
    sed -n 's/.*PlexOnlineToken="\([^"]*\)".*/\1/p' "$PLEX_PREFS" 2>/dev/null | head -1
}

# Same parser as pms-local's plex-update.sh.
session_count() {
    local body="$1" n
    [[ "$body" == *"<MediaContainer"* ]] || return 2
    n="$(sed -n 's/.*<MediaContainer[^>]*[[:space:]]size="\([0-9]*\)".*/\1/p' <<<"$body" | head -1)"
    [[ -n "$n" ]] || return 2
    printf '%s' "$n"
}

# 0 clear · 1 someone is watching · 4 token missing/rejected · 5 no answer
gate_plex() {
    local token body rc=0 n
    token="$(plex_token)"
    if [[ -z "$token" ]]; then
        log "plex: ERROR: no PlexOnlineToken in $PLEX_PREFS — cannot tell whether anyone is streaming"
        return 4
    fi

    body="$(curl -sf --max-time "$PLEX_TIMEOUT" -H "X-Plex-Token: $token" \
        "$PLEX_URL/status/sessions")" || rc=$?
    case "$rc" in
        0) ;;
        22) log "plex: ERROR: Plex rejected its own token"; return 4 ;;
        # Only asked while the container is running, so silence is not
        # "nothing to interrupt" — it is not knowing, and guessing risks
        # killing playback.
        *)  log "plex: ERROR: Plex is running but not answering (curl $rc)"; return 5 ;;
    esac

    n="$(session_count "$body")" || { log "plex: ERROR: unrecognised /status/sessions response"; return 5; }
    if [[ "$n" -ne 0 ]]; then
        log "plex: $n active session(s) — deferring to the next run."
        return 1
    fi
    return 0
}

# What must be unchanged after the update: the server identity. A container
# that answers with a different one came up on a fresh config, which is not a
# working update however healthy it looks.
identity_plex() {
    curl -sf --max-time "$PLEX_TIMEOUT" "$PLEX_URL/identity" \
        | sed -n 's/.*machineIdentifier="\([^"]*\)".*/\1/p' | head -1
}

version_plex() {
    curl -sf --max-time "$PLEX_TIMEOUT" "$PLEX_URL/identity" \
        | sed -n 's/.*<MediaContainer[^>]*[[:space:]]version="\([^"]*\)".*/\1/p' | head -1
}

# ─── health ───────────────────────────────────────────────────────────────────
# With an identity hook: up when it reports the identity from before. Without:
# up when the same container has run for STEADY_SECS without restarting.
# StartedAt, not "running" twice: a crash loop under restart: unless-stopped
# can be caught running at both looks, but never with the same start time.
started_at() { docker inspect -f '{{.State.StartedAt}}' "$1" 2>/dev/null; }

wait_healthy() {
    local svc="$1" want="$2" deadline=$((SECONDS + UPDATE_HEALTH_WAIT)) cid t0
    while (( SECONDS < deadline )); do
        cid="$(container_of "$svc")"
        if [[ -n "$cid" ]] && running "$cid"; then
            if [[ -n "$want" ]]; then
                [[ "$("$(hook identity "$svc")" 2>/dev/null)" == "$want" ]] && return 0
            else
                t0="$(started_at "$cid")"
                sleep "$STEADY_SECS"
                running "$cid" && [[ "$(started_at "$cid")" == "$t0" ]] && return 0
            fi
        fi
        sleep 5
    done
    return 1
}

# ─── one service ──────────────────────────────────────────────────────────────
update_one() {
    local svc="$1" cid ref old new want="" rc

    cid="$(container_of "$svc")"
    if [[ -z "$cid" ]]; then
        log "$svc: not running — skipping."
        return 0
    fi
    if ! ref="$(image_ref "$cid")" || ! old="$(image_of "$cid")"; then
        log "$svc: ERROR: cannot inspect the running container"
        return 3
    fi
    log "$svc: running $(short "$old") ($ref)"

    docker compose pull -q "$svc" || { log "$svc: ERROR: pull failed"; return 6; }
    new="$(image_id "$ref")"
    if [[ -z "$new" || "$new" == "$old" ]]; then
        log "$svc: already current — nothing to do."
        return 0
    fi
    log "$svc: new image $(short "$new")"

    if has_hook gate "$svc"; then
        "$(hook gate "$svc")"; rc=$?
        case "$rc" in
            0) ;;
            1) return 0 ;;        # deferred; the pulled image waits for next week
            *) return "$rc" ;;
        esac
    fi

    if [[ "$DRY_RUN" == 1 ]]; then
        log "$svc: dry run — would recreate on $(short "$new")."
        return 0
    fi

    if has_hook identity "$svc"; then
        want="$("$(hook identity "$svc")")"
        [[ -n "$want" ]] || { log "$svc: ERROR: cannot read its identity before updating"; return 5; }
    fi
    has_hook version "$svc" && log "$svc: version before: $("$(hook version "$svc")")"

    log "$svc: recreating on $(short "$new")"
    if recreate "$svc" && wait_healthy "$svc" "$want"; then
        has_hook version "$svc" && log "$svc: version after:  $("$(hook version "$svc")")"
        log "$svc: updated."
        # Only this image, and only if nothing else still uses it: never a
        # blanket prune on a box with other work.
        docker image rm "$old" >/dev/null 2>&1 || true
        return 0
    fi

    log "$svc: ERROR: not healthy within ${UPDATE_HEALTH_WAIT}s on $(short "$new") — rolling back to $(short "$old")"
    if docker tag "$old" "$ref" && recreate "$svc" && wait_healthy "$svc" "$want"; then
        log "$svc: rolled back; $(short "$old") is serving. Next week's run will try $(short "$new") again."
        return 9
    fi
    log "$svc: ERROR: rollback failed — $svc is DOWN. See docs/updating.md."
    return 10
}

# ─── main ─────────────────────────────────────────────────────────────────────
preflight() {
    cd "$REPO" || return 1
    docker info >/dev/null 2>&1 || { echo "docker is not reachable as $(id -un)" >&2; return 1; }
    [[ -f .env ]] || { echo "$REPO/.env is missing" >&2; return 1; }
    docker compose config -q 2>/dev/null || { echo "compose.yaml does not render" >&2; return 1; }
    [[ -d "$APPDATA" ]] || { echo "$APPDATA does not exist" >&2; return 1; }
}

main() {
    local -a services=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dry-run) DRY_RUN=1 ;;
            -h|--help) sed -n '2,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
            -*)        echo "usage: ${0##*/} [--dry-run] [service...]" >&2; exit 2 ;;
            *)         services+=("$1") ;;
        esac
        shift
    done
    [[ ${#services[@]} -gt 0 ]] || read -r -a services <<<"$UPDATE_SERVICES"

    preflight || exit 3

    exec 9>"$UPDATE_LOCK" || { echo "cannot open $UPDATE_LOCK" >&2; exit 3; }
    flock -n 9 || { log "Another update holds $UPDATE_LOCK — exiting."; exit 0; }

    log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    log "Services:   ${services[*]}"
    log "Dry run:    $DRY_RUN"

    local svc rc worst=0
    for svc in "${services[@]}"; do
        update_one "$svc"; rc=$?
        (( rc > worst )) && worst=$rc
    done
    exit "$worst"
}

# Sourcing with UPDATE_STACK_LIB=1 gets the functions without running anything,
# which is how tests/update-stack.test.sh reaches them.
[[ "${UPDATE_STACK_LIB:-0}" == "1" ]] || main "$@"
