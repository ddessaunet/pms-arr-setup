#!/usr/bin/env bash
# deploy.sh — install the updater's systemd units, then arm or disarm its timer.
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
)
SERVICE_SRC="systemd/pms-update.service"
TIMER="pms-update.timer"
NATIVE_PLEX_UNIT="plexmediaserver.service"

# What ExecStart must say. The unit cannot use a relative path, so it names
# this clone; a moved clone would leave the timer running a file that is gone.
WANT_EXEC="$REPO/tools/update-stack.sh"

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

exec_path() { sed -n 's/^ExecStart=//p' "$SERVICE_SRC" | head -1; }

# Reports drift; changes nothing. 0 = everything matches.
check() {
    local rc=0 entry got

    if [[ "$(exec_path)" != "$WANT_EXEC" ]]; then
        echo "WRONG ExecStart in $SERVICE_SRC: '$(exec_path)', want '$WANT_EXEC'"
        rc=1
    fi

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
    fi
    return "$rc"
}

preflight() {
    if [[ "$(id -u)" -eq 0 ]]; then
        echo "Run this as yourself, not as root — it asks for sudo where it needs it." >&2
        exit 1
    fi
    # A unit pointing at a missing script gives you a timer that fails every
    # Sunday and nothing else.
    if [[ "$(exec_path)" != "$WANT_EXEC" ]]; then
        echo "$SERVICE_SRC runs '$(exec_path)', but this clone is at $REPO." >&2
        echo "Edit its ExecStart= to: $WANT_EXEC" >&2
        exit 1
    fi
    [[ -x "$WANT_EXEC" ]] || { echo "$WANT_EXEC is missing or not executable." >&2; exit 1; }
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
        echo "SYS_PREFIX set — skipping daemon-reload and the timer."
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
}

verify() {
    if [[ -n "$SYS_PREFIX" ]]; then
        check && echo checked
        return
    fi

    local rc=0
    # Catches a typo'd or removed directive before it costs you a Sunday.
    systemd-analyze verify "/etc/systemd/system/$TIMER" \
        /etc/systemd/system/pms-update.service 2>&1 \
        | grep -F 'pms-update' || true
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
