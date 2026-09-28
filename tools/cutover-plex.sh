#!/usr/bin/env bash
# cutover-plex.sh — Phase 1b: native plexmediaserver → the plex container.
#
#   tools/cutover-plex.sh --dry-run     check everything, change nothing
#   tools/cutover-plex.sh               cut over; rolls back by itself on failure
#   tools/cutover-plex.sh --rollback    back to native Plex
#
# The container takes over with a COPY of the native database: same server
# identity, watch history and library paths. /var/lib/plexmediaserver is never
# written, which is what makes the rollback a restart.
#
# Run as yourself, not as root: it asks for sudo once, up front, before
# anything stops. Everything it prints also goes to $APPDATA/cutover-plex.log.
#
# Exit codes: 0 done (or already done) · 1 a precondition failed, nothing
# changed · 2 usage · 3 a step failed and the rollback succeeded · 4 the
# rollback failed too — Plex is DOWN, see docs/phases.md → Phase 1b.

set -uo pipefail

REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"

# identity_plex, version_plex, session_count, env_get, APPDATA, PLEX_URL and
# the docker helpers come from the updater, so the two agree on what "the
# same server" and "someone is watching" mean.
# shellcheck source=SCRIPTDIR/update-stack.sh
UPDATE_STACK_LIB=1 . "$REPO/tools/update-stack.sh" \
    || { echo "cannot load tools/update-stack.sh" >&2; exit 1; }

PLEX_MOVE_CONFIG="${PLEX_MOVE_CONFIG:-/etc/plex-move.conf}"
NATIVE_UNIT="${NATIVE_UNIT:-plexmediaserver}"
NATIVE_TIMER="${NATIVE_TIMER:-plex-update.timer}"
CONTAINER_TIMER="${CONTAINER_TIMER:-pms-update.timer}"
NATIVE_DATA="${NATIVE_DATA:-/var/lib/plexmediaserver/Library/Application Support/Plex Media Server}"
DEST_PARENT="${DEST_PARENT:-$APPDATA/plex/Library/Application Support}"
STATE_FILE="${STATE_FILE:-$APPDATA/.cutover-plex.state}"
LOG_FILE="${LOG_FILE:-$APPDATA/cutover-plex.log}"
IMAGE="${IMAGE:-lscr.io/linuxserver/plex:latest}"
WAIT="${WAIT:-180}"
PUID="${PUID:-$(env_get PUID)}"; PUID="${PUID:-1000}"
PGID="${PGID:-$(env_get PGID)}"; PGID="${PGID:-1001}"

log()  { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG_FILE" 2>/dev/null || true; }
ok()   { log "  ok    $*"; }
bad()  { log "  FAIL  $*"; }
step() { log "── $*"; }

# ─── pure helpers (tests/cutover-plex.test.sh) ────────────────────────────────

# 0 same · 2 image newer (the DB migrates on first start) · 1 image older (abort:
# it would open a database written by a newer Plex).
version_decision() { # native image
    [[ "$1" == "$2" ]] && return 0
    dpkg --compare-versions "$2" gt "$1" && return 2
    return 1
}

# KEY=VALUE, one per line. Parsed, never sourced: only the keys asked for are
# read, so a stray line cannot run anything.
state_get() { # key [file]
    sed -n "s/^$1=//p" "${2:-$STATE_FILE}" 2>/dev/null | tail -n1
}

state_write() { # file key=value...
    local file="$1"; shift
    printf '%s\n' "$@" >"$file"
}

# "2=132 3=7" style lists, compared as sets so section order does not matter.
counts_match() { # want got
    [[ "$(tr ' ' '\n' <<<"$1" | sort)" == "$(tr ' ' '\n' <<<"$2" | sort)" ]]
}

# ─── plex API (token from pms-local's config — the one its scripts use) ───────
native_token() {
    [[ -n "${PLEX_TOKEN:-}" ]] && { printf '%s' "$PLEX_TOKEN"; return; }
    sed -n 's/^PLEX_TOKEN=//p' "$PLEX_MOVE_CONFIG" 2>/dev/null | tail -n1
}

api() { # path [curl args...]
    local path="$1"; shift
    curl -sf --max-time "$PLEX_TIMEOUT" -H "X-Plex-Token: $TOKEN" "$@" "$PLEX_URL$path"
}

# "key=count ..." for every library section.
section_counts() {
    local keys k n out=()
    keys="$(api /library/sections | grep -oE '<Directory [^>]*' | sed -n 's/.*[[:space:]]key="\([0-9]*\)".*/\1/p')" || return 1
    [[ -n "$keys" ]] || return 1
    for k in $keys; do
        n="$(api "/library/sections/$k/all" | sed -n 's/.*<MediaContainer[^>]*[[:space:]]size="\([0-9]*\)".*/\1/p' | head -1)"
        [[ -n "$n" ]] || return 1
        out+=("$k=$n")
    done
    printf '%s' "${out[*]}"
}

section_paths() {
    api /library/sections | grep -oE '<Location [^>]*' | sed -n 's/.*path="\([^"]*\)".*/\1/p'
}

pref_get() {
    api /:/prefs | grep -oE "<Setting id=\"$1\"[^>]*" | sed -n 's/.*value="\([^"]*\)".*/\1/p' | head -1
}

pref_set() { api "/:/prefs?$1=$2" -X PUT -o /dev/null; }

wait_identity() { # want
    local deadline=$((SECONDS + WAIT))
    while (( SECONDS < deadline )); do
        [[ "$(identity_plex 2>/dev/null)" == "$1" ]] && return 0
        sleep 3
    done
    return 1
}

native_masked() { [[ "$(systemctl is-enabled "$NATIVE_UNIT" 2>/dev/null)" == masked* ]]; }

# ─── preconditions ────────────────────────────────────────────────────────────
# Fills IDENT, COUNTS, TRASH, NATIVE_VER, IMAGE_VER. Changes nothing.
preflight() {
    local fails=0 p need avail
    step "Preconditions"

    [[ "$(id -u)" -ne 0 ]] || { bad "run as yourself, not root — it asks for sudo itself"; return 1; }

    if docker info >/dev/null 2>&1 && (cd "$REPO" && docker compose config -q 2>/dev/null); then
        ok "docker reachable, compose.yaml renders"
    else
        bad "docker unreachable or compose.yaml does not render"; fails=$((fails + 1))
    fi
    if [[ "$(stat -c '%u:%g' "$APPDATA" 2>/dev/null)" == "$PUID:$PGID" ]]; then
        ok "$APPDATA owned $PUID:$PGID"
    else
        bad "$APPDATA missing or not owned $PUID:$PGID"; fails=$((fails + 1))
    fi

    if native_masked; then
        bad "$NATIVE_UNIT is already masked — cut over already? (--rollback to go back)"
        return 1
    fi
    if systemctl is-active --quiet "$NATIVE_UNIT"; then
        ok "$NATIVE_UNIT active"
    else
        bad "$NATIVE_UNIT is not running — start it; the cutover records its live state"; return 1
    fi

    TOKEN="$(native_token)"
    [[ -n "$TOKEN" ]] || { bad "no PLEX_TOKEN in $PLEX_MOVE_CONFIG"; return 1; }
    local body n
    if ! body="$(api /status/sessions)"; then
        bad "native Plex rejected PLEX_TOKEN or did not answer"; return 1
    fi
    n="$(session_count "$body")" || { bad "unrecognised /status/sessions answer"; return 1; }
    if [[ "$n" -eq 0 ]]; then ok "no one is streaming"; else bad "$n active session(s) — wait for them to finish"; fails=$((fails + 1)); fi

    IDENT="$(identity_plex)"
    if [[ -n "$IDENT" ]]; then ok "server identity $IDENT"
    else bad "cannot read /identity"; fails=$((fails + 1)); fi
    if COUNTS="$(section_counts)"; then ok "library sections (key=items): $COUNTS"
    else bad "cannot read library section counts"; fails=$((fails + 1)); fi
    TRASH="$(pref_get autoEmptyTrash)"
    if [[ -n "$TRASH" ]]; then ok "autoEmptyTrash=$TRASH (held at 0 during the cutover)"
    else bad "cannot read autoEmptyTrash"; fails=$((fails + 1)); fi

    NATIVE_VER="$(dpkg-query -W -f='${Version}' plexmediaserver 2>/dev/null)"
    IMAGE_VER="$(docker run --rm --entrypoint dpkg-query "$IMAGE" -W -f='${Version}' plexmediaserver 2>/dev/null)"
    if [[ -z "$NATIVE_VER" || -z "$IMAGE_VER" ]]; then
        bad "cannot read Plex versions (native '${NATIVE_VER}', image '${IMAGE_VER}')"; fails=$((fails + 1))
    else
        version_decision "$NATIVE_VER" "$IMAGE_VER"
        case $? in
            0) ok "versions match: $NATIVE_VER" ;;
            2) log "  warn  image $IMAGE_VER is newer than native $NATIVE_VER — the copy's database migrates on first start (the native one is untouched, so rollback still works)" ;;
            *) bad "image $IMAGE_VER is OLDER than native $NATIVE_VER — it would open a newer database; pull a current image"; fails=$((fails + 1)) ;;
        esac
    fi

    while IFS= read -r p; do
        [[ -n "$p" ]] || continue
        if [[ -d "$p" && -n "$(ls -A "$p" 2>/dev/null)" ]]; then ok "library path $p present"
        else bad "library path $p is missing or empty — is /mnt/data mounted?"; fails=$((fails + 1)); fi
    done < <(section_paths)

    if [[ -e "$APPDATA/plex/Library" ]]; then
        bad "$APPDATA/plex/Library already exists — a previous attempt? Move it aside first"; fails=$((fails + 1))
    else
        ok "$APPDATA/plex/Library does not exist yet"
    fi

    need="$(( $(du -sk "$NATIVE_DATA" 2>/dev/null | cut -f1) * 3 ))"
    avail="$(df -Pk "$APPDATA" | awk 'NR==2 {print $4}')"
    if [[ "$need" -gt 0 && "$avail" -ge "$need" ]]; then
        ok "space: $((avail / 1048576)) GiB free on $APPDATA, need $((need / 1048576 + 1)) GiB"
    else
        bad "not enough space on $APPDATA (${avail} KiB free, need ${need} KiB)"; fails=$((fails + 1))
    fi

    [[ "$fails" -eq 0 ]]
}

# ─── rollback ─────────────────────────────────────────────────────────────────
rollback() {
    local ident trash ts rc=0
    step "Rollback to native Plex"
    ident="$(state_get IDENT)"
    trash="$(state_get TRASH)"
    [[ -n "$ident" ]] || log "  warn  no state file at $STATE_FILE — skipping the identity and autoEmptyTrash checks"

    (cd "$REPO" && docker compose --profile cutover stop plex >/dev/null 2>&1) || true
    ok "plex container stopped"

    if ! { sudo systemctl unmask "$NATIVE_UNIT" && sudo systemctl start "$NATIVE_UNIT"; }; then
        bad "could not start $NATIVE_UNIT"; return 1
    fi
    if [[ -n "$ident" ]]; then
        if wait_identity "$ident"; then ok "native Plex serving $ident"
        else bad "native Plex did not come back as $ident within ${WAIT}s"; rc=1; fi
    fi

    if [[ -n "$trash" ]]; then
        TOKEN="$(native_token)"
        if pref_set autoEmptyTrash "$trash"; then ok "autoEmptyTrash restored to $trash"
        else log "  warn  could not restore autoEmptyTrash=$trash — set it in Settings → Library"; fi
    fi

    if sudo systemctl enable --now "$NATIVE_TIMER" >/dev/null 2>&1; then ok "$NATIVE_TIMER re-armed"
    else log "  warn  could not re-arm $NATIVE_TIMER"; fi
    if systemctl cat "$CONTAINER_TIMER" >/dev/null 2>&1; then
        sudo systemctl disable --now "$CONTAINER_TIMER" >/dev/null 2>&1 && ok "$CONTAINER_TIMER disarmed"
    fi

    if [[ -e "$APPDATA/plex" ]]; then
        ts="$(date +%Y%m%d-%H%M%S)"
        mv "$APPDATA/plex" "$APPDATA/plex.rolled-back-$ts" 2>/dev/null \
            || sudo mv "$APPDATA/plex" "$APPDATA/plex.rolled-back-$ts"
        ok "container copy kept at $APPDATA/plex.rolled-back-$ts"
    fi
    return "$rc"
}

# ─── cutover ──────────────────────────────────────────────────────────────────
fail_and_roll_back() {
    bad "$1"
    if rollback; then
        log "Rolled back: native Plex is serving again. Nothing under /var/lib/plexmediaserver was changed."
        exit 3
    fi
    log "ROLLBACK FAILED — Plex is down. See docs/phases.md → Phase 1b → Rollback."
    exit 4
}

cutover() {
    local got pid_wait=30
    step "Recording state"
    state_write "$STATE_FILE" "IDENT=$IDENT" "TRASH=$TRASH" "COUNTS=$COUNTS" \
        "NATIVE_VER=$NATIVE_VER" "IMAGE_VER=$IMAGE_VER" "AT=$(date -Is)"
    ok "$STATE_FILE"

    step "Holding autoEmptyTrash at 0"
    # Before the stop, so the copied Preferences.xml carries 0: a container
    # that starts without its library then shows titles as unavailable
    # instead of deleting them and their watch state.
    pref_set autoEmptyTrash 0 && [[ "$(pref_get autoEmptyTrash)" == 0 ]] \
        || { bad "could not set autoEmptyTrash=0 — nothing else changed"; exit 1; }
    ok "autoEmptyTrash=0 on native"

    step "Stopping native Plex"
    sudo systemctl disable --now "$NATIVE_TIMER" >/dev/null 2>&1 || true
    ok "$NATIVE_TIMER disarmed"
    if ! { sudo systemctl stop "$NATIVE_UNIT" && sudo systemctl mask "$NATIVE_UNIT"; }; then
        fail_and_roll_back "could not stop and mask $NATIVE_UNIT"
    fi
    while pgrep -u plex >/dev/null 2>&1 && (( pid_wait-- > 0 )); do sleep 1; done
    pgrep -u plex >/dev/null 2>&1 && fail_and_roll_back "processes owned by plex are still running — the database may be open"
    ok "$NATIVE_UNIT stopped and masked; no plex processes left"

    step "Removing the shadow container"
    (cd "$REPO" && docker compose --profile shadow rm -sf plex-shadow >/dev/null 2>&1) || true
    ok "plex-shadow removed (its config in $APPDATA/plex-shadow is left for you)"

    step "Copying the database"
    if ! { sudo install -d -o "$PUID" -g "$PGID" "$DEST_PARENT" \
           && sudo rsync -a --exclude plexmediaserver.pid "$NATIVE_DATA" "$DEST_PARENT/" \
           && sudo chown -R "$PUID:$PGID" "$APPDATA/plex"; }; then
        fail_and_roll_back "copy failed"
    fi
    ok "copied to $DEST_PARENT/Plex Media Server, owned $PUID:$PGID"

    step "Starting the plex container"
    (cd "$REPO" && docker compose --profile cutover up -d plex) || fail_and_roll_back "docker compose up failed"

    step "Verifying"
    wait_identity "$IDENT" || fail_and_roll_back "container did not serve identity $IDENT within ${WAIT}s"
    ok "serving the same server: $IDENT ($(version_plex))"

    TOKEN="$(native_token)"
    local deadline=$((SECONDS + WAIT))
    until got="$(section_counts)" && counts_match "$COUNTS" "$got"; do
        (( SECONDS < deadline )) || fail_and_roll_back "library counts differ: want '$COUNTS', got '${got:-none}'"
        sleep 5
    done
    ok "library counts match: $got"

    local p
    while IFS= read -r p; do
        [[ -n "$p" ]] || continue
        docker exec plex sh -c 'ls -A "$1" | grep -q .' _ "$p" 2>/dev/null \
            || fail_and_roll_back "the container cannot see $p"
    done < <(section_paths)
    ok "every library path is visible inside the container"

    if pref_set autoEmptyTrash "$TRASH"; then ok "autoEmptyTrash restored to $TRASH"
    else log "  warn  could not restore autoEmptyTrash=$TRASH — set it in Settings → Library"; fi

    log ""
    log "Cut over. Check by hand (docs/phases.md → Phase 1b → Verify):"
    log "  - clients reconnect to the same server without being re-added; watch state and On Deck intact"
    log "  - a native qBittorrent import refreshes the library (/var/log/plex-move.log)"
    log "  - a test delete in Plex triggers plex-watch (journalctl -u plex-watch -f)"
    log "Then: remove 'PMS shadow' on plex.tv, rm -rf $APPDATA/plex-shadow,"
    log "      drop profiles: [cutover] from compose.yaml, npm run update:dry, npm run deploy."
    log "To go back: tools/cutover-plex.sh --rollback"
}

main() {
    local mode=run
    case "${1:-}" in
        "")          ;;
        --dry-run)   mode=dry ;;
        --rollback)  mode=rollback ;;
        -h|--help)   sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)           echo "usage: ${0##*/} [--dry-run | --rollback]" >&2; exit 2 ;;
    esac
    [[ "$(id -u)" -ne 0 ]] || { echo "Run this as yourself, not as root." >&2; exit 1; }
    cd "$REPO" || exit 1

    log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ cutover-plex ($mode)"

    if [[ "$mode" == rollback ]]; then
        sudo -v || exit 1
        if rollback; then log "Rolled back."; exit 0; fi
        log "Rollback finished with problems above."; exit 4
    fi

    # Already done: native masked, container serving the recorded server.
    if native_masked && [[ -n "$(state_get IDENT)" && "$(identity_plex 2>/dev/null)" == "$(state_get IDENT)" ]]; then
        log "Already cut over: the plex container is serving $(state_get IDENT)."
        exit 0
    fi

    preflight || { log "Preconditions failed — nothing was changed."; exit 1; }

    if [[ "$mode" == dry ]]; then
        log ""
        log "Dry run — nothing was changed. A real run would:"
        log "  1. record identity, counts and autoEmptyTrash to $STATE_FILE"
        log "  2. set autoEmptyTrash=0 on native Plex"
        log "  3. disable $NATIVE_TIMER; stop and mask $NATIVE_UNIT"
        log "  4. remove the plex-shadow container (not its config)"
        log "  5. rsync the native data into $DEST_PARENT and chown it $PUID:$PGID"
        log "  6. docker compose --profile cutover up -d plex"
        log "  7. verify identity, counts and paths; restore autoEmptyTrash — or roll back"
        exit 0
    fi

    # One password prompt, before anything stops, not halfway through.
    sudo -v || { log "sudo refused — nothing was changed."; exit 1; }
    cutover
}

[[ "${CUTOVER_PLEX_LIB:-0}" == "1" ]] || main "$@"
