#!/usr/bin/env bash
# apps/plex/configure.sh — pin Plex to the wired interface through its API, then
# read it back. Idempotent.
#
#   apps/plex/configure.sh            apply, then verify
#   apps/plex/configure.sh --check    verify only; changes nothing
#
# Normally run as `task plex:configure` / `task plex:check`.
#
# The box has two NICs on the same /24, both on DHCP: eno1 (wired) and wlp2s0
# (Wi-Fi). With "Preferred network interface" on Any, Plex advertises both
# addresses, and clients pick the Wi-Fi one as often as not. Linux answers ARP
# for either address on either NIC, so that traffic usually still crosses the
# wire, but only by accident. Pinned to eno1, Plex offers local clients the
# wired address only. The setting names the interface, not an address, so it
# survives the DHCP moves (.86 <-> .87).
#
# This is the only Plex setting the repo owns; everything else stays in Plex's
# own UI. The token is PLEX_TOKEN from .env, or else the server's own
# PlexOnlineToken from its Preferences.xml.
#
# Exit: 0 applied and verified (or no drift) · 1 drift, or a step failed ·
# 2 usage · 3 not reachable, no token, or the interface does not exist.

set -uo pipefail

REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"
# shellcheck source=SCRIPTDIR/../../stack/lib/servarr.sh
. "$REPO/stack/lib/servarr.sh" || { echo "cannot load stack/lib/servarr.sh" >&2; exit 3; }

APPDATA="${APPDATA:-$(env_get APPDATA)}"; APPDATA="${APPDATA:-/opt/appdata}"
PLEX_URL="${PLEX_URL:-http://127.0.0.1:32400}"
PLEX_PREFS="${PLEX_PREFS:-$APPDATA/plex/Library/Application Support/Plex Media Server/Preferences.xml}"
PLEX_TIMEOUT="${PLEX_TIMEOUT:-15}"
PLEX_WAIT="${PLEX_WAIT:-90}"
PLEX_TOKEN="${PLEX_TOKEN:-$(env_get PLEX_TOKEN)}"

# ─── the setting ──────────────────────────────────────────────────────────────
PLEX_IFACE="${PLEX_IFACE:-eno1}"
PREF=PreferredNetworkInterface

# ─── pure helpers (apps/plex/configure.test.sh) ──────────────────────────────
prefs_token() { # Preferences.xml
    sed -n 's/.*PlexOnlineToken="\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -1
}

# The value of one setting in a GET /:/prefs JSON response; fails when absent.
pref_value() { # prefs-json id
    jq -er --arg id "$2" '.MediaContainer.Setting[] | select(.id == $id) | .value' <<<"$1" 2>/dev/null
}

# The interfaces Plex offers for the setting, one per line ("" is Any). Its
# enumValues read ":Any|eno1:eno1 (192.168.0.86)|…".
pref_choices() { # prefs-json id
    jq -r --arg id "$2" '.MediaContainer.Setting[] | select(.id == $id) | .enumValues // ""
        | split("|")[] | split(":")[0]' <<<"$1" 2>/dev/null
}

# The address Plex lists for an interface, e.g. 192.168.0.86; empty when none.
iface_addr() { # prefs-json id iface
    jq -r --arg id "$2" --arg i "$3" '.MediaContainer.Setting[] | select(.id == $id) | .enumValues // ""
        | split("|")[] | select(startswith($i + ":")) | capture("\\((?<a>[^)]*)\\)").a' <<<"$1" 2>/dev/null
}

has_choice() { grep -qxF -- "$3" < <(pref_choices "$1" "$2"); } # prefs-json id iface

# ─── API ──────────────────────────────────────────────────────────────────────
# Sets $HTTP, leaves the response in $BODY. Never inside $(...): a subshell
# loses $HTTP. The token goes in a header, never the URL.
px() { # METHOD path
    HTTP="$(curl -s --max-time "$PLEX_TIMEOUT" -X "$1" -o "$BODY" -w '%{http_code}' \
        -H "X-Plex-Token: $PLEX_TOKEN" -H 'Accept: application/json' "$PLEX_URL$2")" || HTTP=000
    [[ "$HTTP" == 2* ]]
}

# ─── apply / verify ───────────────────────────────────────────────────────────
apply_iface() {
    local got
    px GET /:/prefs || { log "  FAIL  read prefs (HTTP $HTTP)"; return 1; }
    got="$(pref_value "$(body)" "$PREF")" || { log "  FAIL  no $PREF in /:/prefs"; return 1; }
    if [[ "$got" == "$PLEX_IFACE" ]]; then log "  interface already $PLEX_IFACE"; return 0; fi
    px PUT "/:/prefs?$PREF=$PLEX_IFACE" || { log "  FAIL  write $PREF (HTTP $HTTP)"; return 1; }
    log "  interface set: ${got:-Any} → $PLEX_IFACE"
}

verify() {
    local prefs got
    px GET /:/prefs || { log "  FAIL  read prefs (HTTP $HTTP)"; return 1; }
    prefs="$(body)"
    got="$(pref_value "$prefs" "$PREF")" || { log "  FAIL  no $PREF in /:/prefs"; return 1; }
    if [[ "$got" == "$PLEX_IFACE" ]]; then
        log "  ok       preferred network interface: $PLEX_IFACE ($(iface_addr "$prefs" "$PREF" "$PLEX_IFACE"))"
        return 0
    fi
    log "  DRIFT    preferred network interface: ${got:-Any}, want $PLEX_IFACE"
    return 1
}

# ─── main ─────────────────────────────────────────────────────────────────────
main() {
    local mode=apply
    case "${1:-}" in
        "")        ;;
        --check)   mode=check ;;
        -h|--help) sed -n '2,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)         echo "usage: ${0##*/} [--check]" >&2; exit 2 ;;
    esac

    [[ -n "$PLEX_TOKEN" ]] || PLEX_TOKEN="$(prefs_token "$PLEX_PREFS")"
    [[ -n "$PLEX_TOKEN" ]] || { echo "No Plex token: set PLEX_TOKEN in $REPO/.env, or check $PLEX_PREFS." >&2; exit 3; }

    BODY="$(mktemp)"; trap 'rm -f "$BODY"' EXIT
    log "Plex at $PLEX_URL ($mode)"
    local deadline=$((SECONDS + PLEX_WAIT))
    until px GET /identity; do
        (( SECONDS < deadline )) || { log "  FAIL  not answering at $PLEX_URL — is it running?"; exit 3; }
        sleep 3
    done
    log "  up: $(body | jq -r '.MediaContainer.version // "?"')"

    # Plex lists the host's interfaces as the setting's choices. One that is
    # missing (renamed NIC, unplugged at boot) would leave Plex on nothing.
    px GET /:/prefs || { log "  FAIL  read prefs (HTTP $HTTP)"; [[ "$HTTP" == 401 ]] && exit 3; exit 1; }
    if ! has_choice "$(body)" "$PREF" "$PLEX_IFACE"; then
        log "  FAIL  Plex offers no interface $PLEX_IFACE (has: $(pref_choices "$(body)" "$PREF" | grep . | paste -sd' ' -))"
        exit 3
    fi

    if [[ "$mode" == apply ]]; then
        apply_iface || exit 1
    fi
    log "Read-back:"
    if verify; then log "No drift."; exit 0; fi
    [[ "$mode" == check ]] && log "To apply: task plex:configure"
    exit 1
}

[[ "${PLEX_CONFIGURE_LIB:-0}" == "1" ]] || main "$@"
