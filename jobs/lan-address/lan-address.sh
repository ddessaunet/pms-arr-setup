#!/usr/bin/env bash
# jobs/lan-address/lan-address.sh — when the box's LAN addresses change, apply the
# settings of the apps that list them again.
#
#   jobs/lan-address/lan-address.sh              apply the apps that are behind
#   jobs/lan-address/lan-address.sh --dry-run    say which ones; changes nothing
#   jobs/lan-address/lan-address.sh --force      apply all of them
#
# Normally run by lan-address.timer beside it (2 min after boot, then every
# 5 min), or as `task lan-address:run` / `:dry` / `:force`.
#
# The router assigns the box's addresses by DHCP, and they change: on a reboot
# the wired one has gone .86 → .87 and back. qBittorrent, Prowlarr, Radarr and
# Sonarr refuse a request to an address they don't list ("Unauthorized",
# "Invalid Hostname"), and Seerr links to Radarr and Sonarr by address. Their
# configure.sh scripts list the addresses the box has when they run, so this runs
# them again, but only for an app whose recorded addresses differ from now:
# Prowlarr's configure re-syncs its indexers on every run.
#
# Exit: 0 nothing to do, or every app applied · 1 an app failed (it is retried
# on the next run) · 2 usage.

set -uo pipefail

REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"
# shellcheck source=SCRIPTDIR/../../stack/lib/servarr.sh
. "$REPO/stack/lib/servarr.sh" || { echo "cannot load stack/lib/servarr.sh" >&2; exit 3; }

# The apps whose settings hold the box's addresses, in the order Taskfile.yml's
# CONFIGURED applies them. Bazarr reaches Plex as host.docker.internal, and Plex
# is pinned to an interface by name, so neither is one of them.
LAN_ADDRESS_APPS="${LAN_ADDRESS_APPS:-qbittorrent prowlarr radarr sonarr seerr}"

# ─── pure helpers (jobs/lan-address/lan-address.test.sh) ──────────────────────

# The box's LAN addresses now, sorted, on one line. Empty before DHCP answers.
addresses_now() { lan_ips | LC_ALL=C sort -u | paste -sd' ' -; }

# The addresses recorded for an app in the state text ("<app> <addresses>" lines).
state_of() { # state app
    awk -v a="$2" '$1 == a { sub(/^[^ ]+ */, ""); print; exit }' <<<"$1"
}

# The state text with the app's line set to the addresses.
state_set() { # state app addresses
    { grep -v "^$2 " <<<"$1"; printf '%s %s\n' "$2" "$3"; } | grep -v '^$' | LC_ALL=C sort
}

# The apps, of those given, whose recorded addresses are not these.
pending_apps() { # state addresses app...
    local state="$1" now="$2" app; shift 2
    for app in "$@"; do
        [[ "$(state_of "$state" "$app")" == "$now" ]] || printf '%s\n' "$app"
    done
}

# Apply one app's settings. A function so the test can stand in for it.
run_configure() { "$REPO/apps/$1/configure.sh"; }

state_write() { # text
    local tmp
    tmp="$(mktemp "$STATE.XXXXXX")" || { log "WARN: cannot write $STATE"; return 1; }
    if ! { printf '%s\n' "$1" > "$tmp" && mv -f -- "$tmp" "$STATE"; }; then
        rm -f -- "$tmp"; log "WARN: cannot write $STATE"; return 1
    fi
}

# ─── main ─────────────────────────────────────────────────────────────────────
main() {
    local dry=0 force=0 arg
    for arg in "$@"; do
        case "$arg" in
            --dry-run) dry=1 ;;
            --force)   force=1 ;;
            -h|--help) sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
            *)         echo "usage: ${0##*/} [--dry-run|--force]" >&2; exit 2 ;;
        esac
    done

    APPDATA="${APPDATA:-$(env_get APPDATA)}"; APPDATA="${APPDATA:-/opt/appdata}"
    STATE="${LAN_ADDRESS_STATE:-$APPDATA/.lan-address}"
    local lock="${LAN_ADDRESS_LOCK:-$APPDATA/.lan-address.lock}"

    local now
    now="$(addresses_now)"
    [[ -n "$now" ]] || { log "No LAN address yet — trying again next run."; exit 0; }

    if [[ "$dry" == 0 ]]; then
        exec 9>>"$lock" || { log "cannot open $lock"; exit 1; }
        flock -n 9 || { log "Another run holds $lock — skipping."; exit 0; }
    fi

    local state="" todo app old rc=0 done_any=0 failed=()
    [[ -r "$STATE" ]] && state="$(cat "$STATE")"
    # shellcheck disable=SC2086  # a word list on purpose
    if [[ "$force" == 1 ]]; then todo="$(printf '%s\n' $LAN_ADDRESS_APPS)"
    else todo="$(pending_apps "$state" "$now" $LAN_ADDRESS_APPS)"; fi
    [[ -n "$todo" ]] || exit 0   # the common case, every 5 minutes: quiet

    local apps
    mapfile -t apps <<<"$todo"
    log "LAN addresses now: $now"
    for app in "${apps[@]}"; do
        old="$(state_of "$state" "$app")"
        log "  $app: ${old:-never applied} → $now"
    done
    if [[ "$dry" == 1 ]]; then log "Dry run: nothing applied."; exit 0; fi

    for app in "${apps[@]}"; do
        log "── $app"
        if run_configure "$app" </dev/null 2>&1 | sed 's/^/    /'; then
            state="$(state_set "$state" "$app" "$now")"
            state_write "$state" || rc=1
            done_any=1
        else
            log "  $app: configure failed — trying again next run"
            failed+=("$app"); rc=1
        fi
    done

    if [[ "${#failed[@]}" -eq 0 ]]; then
        log "Stack now at $now."
    else
        [[ "$done_any" == 1 ]] && log "Applied the others; the stack answers at $now."
        log "Still pending: ${failed[*]}"
    fi
    exit "$rc"
}

[[ "${LAN_ADDRESS_LIB:-0}" == "1" ]] || main "$@"
