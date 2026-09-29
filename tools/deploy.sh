#!/usr/bin/env bash
# deploy.sh — install the systemd units (the updater's and arr-reclaim's), arm
# or disarm the updater's timer, and (re)start the arr-reclaim watcher.
#
#   tools/deploy.sh            install, reload, arm/disarm, verify
#   tools/deploy.sh --check    report drift only; changes nothing
#
# Normally reached through npm: `npm run deploy` / `npm run check`.
#
# This repo ships nothing into /opt — compose runs from the clone — so the
# units are the whole deploy. The structure is pms-local's deploy-system.sh.
#
# The timer follows the same signal as pms-local's deploy, inverted: while
# plexmediaserver is masked Plex runs here, so pms-update.timer is armed and
# pms-local's plex-update.timer is not; unmask it (the Phase 1b rollback) and
# both deploys swap. Exactly one updater is ever armed, and either deploy is
# safe to re-run on either side of the cutover.
#
# **Run it as yourself, not as root.** It asks for sudo at the installs and the
# systemctl calls and nowhere else. `sudo npm run deploy` does not work: node
# comes from nvm, which sudo strips out of PATH.
#
# Rehearse anywhere harmless first — SYS_PREFIX relocates every destination:
#   SYS_PREFIX=/tmp/rehearsal tools/deploy.sh --check

set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
cd "$REPO" || exit 1

SYS_PREFIX="${SYS_PREFIX:-}"

# src:dest:mode — always root:root, because /etc is.
MANIFEST=(
    "systemd/pms-update.service:/etc/systemd/system/pms-update.service:644"
    "systemd/pms-update.timer:/etc/systemd/system/pms-update.timer:644"
    "systemd/arr-reclaim.service:/etc/systemd/system/arr-reclaim.service:644"
)
TIMER="pms-update.timer"
NATIVE_PLEX_UNIT="plexmediaserver.service"

# The long-running watcher: enabled and restarted on EVERY deploy, not only
# when its unit changes — it is also stale when tools/arr-reclaim.sh changes,
# which no unit file shows. (The same reasoning as pms-local's plex-watch.)
WATCHER="arr-reclaim.service"

# What each unit's ExecStart must say, as unit|command. A unit cannot use a
# relative path, so it names this clone; a moved clone would leave it running
# a file that is gone.
EXECS=(
    "systemd/pms-update.service|$REPO/tools/update-stack.sh"
    "systemd/arr-reclaim.service|$REPO/tools/arr-reclaim.sh watch"
)

TIMER_CHANGED=0
ANY_CHANGED=0

# entry → MF_SRC / MF_DST / MF_MODE
manifest_parse() {
    local entry="$1" rest
    MF_SRC="${entry%%:*}"
    rest="${entry#*:}"
    MF_DST="${SYS_PREFIX}${rest%:*}"
    MF_MODE="${rest##*:}"
}

# Same test as pms-local's native_plex_masked(); masked-runtime counts.
native_plex_masked() {
    [[ "$(systemctl is-enabled "$NATIVE_PLEX_UNIT" 2>/dev/null)" == masked* ]]
}

exec_of() { sed -n 's/^ExecStart=//p' "$1" | head -1; }

# Prints one line per unit whose ExecStart is not what it must be.
exec_mismatches() {
    local entry unit want
    for entry in "${EXECS[@]}"; do
        unit="${entry%%|*}"; want="${entry#*|}"
        [[ "$(exec_of "$unit")" == "$want" ]] || printf '%s|%s|%s\n' "$unit" "$(exec_of "$unit")" "$want"
    done
}

# Reports drift; changes nothing. 0 = everything matches.
check() {
    local rc=0 entry got

    local unit have want
    while IFS='|' read -r unit have want; do
        [[ -n "$unit" ]] || continue
        echo "WRONG ExecStart in $unit: '$have', want '$want'"; rc=1
    done < <(exec_mismatches)

    for entry in "${MANIFEST[@]}"; do
        manifest_parse "$entry"
        if [[ ! -e "$MF_DST" ]]; then
            echo "SYSTEM MISSING: $MF_DST"; rc=1; continue
        fi
        if ! diff -q "$MF_DST" "$MF_SRC" >/dev/null; then
            echo "SYSTEM OUT OF SYNC: $MF_DST"; rc=1
        fi
        # Right bytes with the wrong mode is still drift: a plain cp does that.
        got="$(stat -c '%a %U:%G' "$MF_DST")"
        [[ "$got" == "$MF_MODE root:root" ]] \
            || { echo "SYSTEM WRONG PERMS: $MF_DST is $got, want $MF_MODE root:root"; rc=1; }
    done

    # Under SYS_PREFIX nothing real is wired up, so live timer state means nothing.
    if [[ -z "$SYS_PREFIX" ]]; then
        local armed=0
        systemctl is-enabled "$TIMER" >/dev/null 2>&1 && armed=1
        if native_plex_masked; then
            if [[ "$armed" == 1 ]]; then
                echo "ok: $TIMER armed ($NATIVE_PLEX_UNIT is masked — Plex runs here)"
            else
                echo "TIMER DISARMED: $NATIVE_PLEX_UNIT is masked, so $TIMER should be armed"; rc=1
            fi
        else
            if [[ "$armed" == 1 ]]; then
                echo "TIMER ARMED: $NATIVE_PLEX_UNIT is not masked — native Plex updates itself; $TIMER should be off"; rc=1
            else
                echo "ok: $TIMER disarmed (Plex is native — pms-local's plex-update.timer owns updates)"
            fi
        fi
        if systemctl is-enabled --quiet "$WATCHER" 2>/dev/null && systemctl is-active --quiet "$WATCHER"; then
            echo "ok: $WATCHER enabled and running"
        else
            echo "WATCHER DOWN: $WATCHER is not enabled and running — npm run deploy"; rc=1
        fi
    fi
    return "$rc"
}

preflight() {
    if [[ "$(id -u)" -eq 0 ]]; then
        echo "Run this as yourself, not as root — it asks for sudo where it needs it." >&2
        exit 1
    fi
    # A unit pointing at a missing script gives you a timer that fails every
    # Sunday, or a watcher that restarts forever, and nothing else.
    local unit have want bad=0 entry
    while IFS='|' read -r unit have want; do
        [[ -n "$unit" ]] || continue
        echo "$unit runs '$have', but this clone is at $REPO." >&2
        echo "Edit its ExecStart= to: $want" >&2
        bad=1
    done < <(exec_mismatches)
    [[ "$bad" == 0 ]] || exit 1
    for entry in "${EXECS[@]}"; do
        want="${entry#*|}"; want="${want%% *}"
        [[ -x "$want" ]] || { echo "$want is missing or not executable." >&2; exit 1; }
    done
}

install_all() {
    local entry
    for entry in "${MANIFEST[@]}"; do
        manifest_parse "$entry"

        # Skip files already byte- and mode-identical, so a re-run is quiet and
        # the timer is not restarted for nothing.
        if [[ -e "$MF_DST" ]] \
           && diff -q "$MF_DST" "$MF_SRC" >/dev/null \
           && [[ "$(stat -c '%a %U:%G' "$MF_DST")" == "$MF_MODE root:root" ]]; then
            printf 'unchanged %s\n' "$MF_DST"
            continue
        fi

        sudo install -D -m "$MF_MODE" -o root -g root "$MF_SRC" "$MF_DST"
        printf 'installed %s %s\n' "$MF_MODE" "$MF_DST"
        ANY_CHANGED=1
        if [[ "$MF_DST" == *"$TIMER" ]]; then TIMER_CHANGED=1; fi
    done

    # Explicit, and load-bearing under `set -e`: without it this function
    # returns the status of its last test, which is false whenever the last
    # entry is not the timer, and the deploy dies before reloading systemd.
    return 0
}

arm() {
    if [[ -n "$SYS_PREFIX" ]]; then
        echo "SYS_PREFIX set — skipping daemon-reload, the timer and the watcher."
        return 0
    fi

    if [[ "$ANY_CHANGED" == 1 ]]; then
        sudo systemctl daemon-reload
        echo "daemon-reload"
    fi

    # Idempotent either way.
    if native_plex_masked; then
        sudo systemctl enable --now "$TIMER"
        echo "enabled $TIMER — $NATIVE_PLEX_UNIT is masked, so Plex runs here"
        # daemon-reload re-reads a changed timer but leaves the old elapse
        # armed; restarting is what makes a new OnCalendar take effect.
        if [[ "$TIMER_CHANGED" == 1 ]]; then
            sudo systemctl restart "$TIMER"
            echo "restarted $TIMER (unit file changed)"
        fi
    else
        sudo systemctl disable --now "$TIMER" 2>/dev/null || true
        echo "disabled $TIMER — Plex is native, and pms-local's plex-update.timer updates it"
    fi

    sudo systemctl enable "$WATCHER"
    sudo systemctl restart "$WATCHER"
    echo "enabled and restarted $WATCHER"
}

verify() {
    if [[ -n "$SYS_PREFIX" ]]; then
        check && echo checked
        return
    fi

    local rc=0
    # Catches a typo'd or removed directive before it costs you a Sunday.
    systemd-analyze verify "/etc/systemd/system/$TIMER" \
        /etc/systemd/system/pms-update.service "/etc/systemd/system/$WATCHER" 2>&1 \
        | grep -E 'pms-update|arr-reclaim' || true
    check || rc=1

    echo
    systemctl list-timers "$TIMER" --all --no-pager

    if [[ "$rc" == 0 ]]; then echo "checked"; else echo "checked, with problems above"; fi
    return "$rc"
}

case "${1:-}" in
    "")
        preflight
        install_all
        arm
        verify
        ;;
    --check)
        if check; then
            echo "checked"
        else
            echo
            echo "To apply: npm run deploy"
            exit 1
        fi
        ;;
    *)
        echo "usage: ${0##*/} [--check]" >&2
        exit 2
        ;;
esac
