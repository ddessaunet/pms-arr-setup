#!/usr/bin/env bash
# qbt-configure.sh — apply the container qBittorrent's settings through its
# WebUI API, then read them back. Idempotent: re-running changes nothing.
#
#   tools/qbt-configure.sh            set credentials (first run), settings, categories; verify
#   tools/qbt-configure.sh --check    read back and report drift only; changes nothing
#
# Normally reached through npm: `npm run qbt:configure` / `npm run qbt:check`.
#
# This is the container instance on :8081 that Radarr and Sonarr use — the
# only one since Phase 7a retired pms-local's native qbittorrent-nox (:8080).
#
# The settings live below as data, so a reinstall gets exactly these in one
# command. docs/phases.md points here rather than repeating them.
#
# First run on a fresh container: qBittorrent has no password yet and prints a
# temporary one in its log. The script reads it, logs in as admin, and sets
# QBT_ARR_USER / QBT_ARR_PASS from .env; every later run logs in with those.
# Passwords travel on stdin or in the environment — never in argv, a URL or a
# log line.
#
# Exit: 0 applied and verified (or no drift) · 1 drift, or a step failed ·
# 2 usage · 3 cannot log in / not configured.

set -uo pipefail

REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"

env_get() {
    [[ -f "$REPO/.env" ]] || return 0
    sed -n "s/^$1=//p" "$REPO/.env" | tail -n1
}

QBT_ARR_URL="${QBT_ARR_URL:-http://127.0.0.1:8081}"
QBT_ARR_USER="${QBT_ARR_USER:-$(env_get QBT_ARR_USER)}"
QBT_ARR_PASS="${QBT_ARR_PASS:-$(env_get QBT_ARR_PASS)}"
QBT_CONTAINER="${QBT_CONTAINER:-qbittorrent}"
QBT_TIMEOUT="${QBT_TIMEOUT:-10}"

TORRENTS="/mnt/data/torrents"

# ─── the settings ─────────────────────────────────────────────────────────────
# Categories: name → save path. With automatic torrent management on, a
# torrent Radarr adds under "radarr" lands in its category's path.
CATEGORIES=(
    "radarr=$TORRENTS/radarr"
    "sonarr=$TORRENTS/sonarr"
)

# The host's own IPv4 addresses, minus loopback and Docker's bridges.
lan_ips() {
    local ip
    for ip in $(hostname -I 2>/dev/null); do
        [[ "$ip" == *:* ]] && continue                             # IPv6
        [[ "$ip" == 127.* ]] && continue
        [[ "$ip" =~ ^172\.(1[6-9]|2[0-9]|3[01])\. ]] && continue  # docker bridges
        printf '%s\n' "$ip"
    done
}

# Host header validation stays on; these are the names it accepts.
#   qbittorrent  — Radarr/Sonarr on the arr network (Phase 4)
#   127.0.0.1    — this script. Leave it out and the first setPreferences
#                  locks the script out of every call after it.
domain_list() {
    local d=(qbittorrent localhost 127.0.0.1 "$(hostname)")
    mapfile -t -O "${#d[@]}" d < <(lan_ips)
    local IFS=';'
    printf '%s' "${d[*]}"
}

want_prefs() {
    jq -cn --arg torrents "$TORRENTS" --arg domains "$(domain_list)" '{
        save_path:                             $torrents,
        temp_path_enabled:                     true,
        temp_path:                             ($torrents + "/.incomplete-arr"),
        auto_tmm_enabled:                      true,
        autorun_enabled:                       false,
        listen_port:                           13762,
        upnp:                                  false,
        max_ratio_enabled:                     true,
        max_ratio:                             2,
        max_seeding_time_enabled:              true,
        max_seeding_time:                      20160,
        max_ratio_act:                         0,
        web_ui_host_header_validation_enabled: true,
        web_ui_domain_list:                    $domains
    }'
}
# Seeding: ratio 2.0 or 14 days (20160 min), whichever comes first, then the
# torrent STOPS (max_ratio_act 0 — no ShareLimitAction line in the conf; 1 is
# Remove and 3 RemoveWithContent, checked on 5.2.3). Stopping rather than
# removing leaves the removal to Radarr/Sonarr's "Remove Completed", which also
# tidies their queue. The library copy is its own hardlink and stays.
#
# Deleting in Plex does not wait for this: pms-local's plex-watch reconciles
# this instance too (QBT_ARR_URL) and removes the torrent right away.

# ─── API ──────────────────────────────────────────────────────────────────────
JAR=""
BODY=""

log() { printf '%s\n' "$*"; }

# curl with the session cookie and the Referer the CSRF check wants. Sets $HTTP
# and leaves the response in $BODY. Never call it inside $(...) or at the end
# of a pipe — both are subshells, and $HTTP would not come back out. Feed it
# stdin with < <(...) instead; that is how passwords reach curl.
HTTP=""
api() { # path [curl args...]
    local path="$1"; shift
    HTTP="$(curl -s --max-time "$QBT_TIMEOUT" -b "$JAR" -c "$JAR" -o "$BODY" \
        -H "Referer: $QBT_ARR_URL" -w '%{http_code}' "$@" "$QBT_ARR_URL$path")" || HTTP=000
    [[ "$HTTP" == 2* ]]
}
body() { cat "$BODY" 2>/dev/null; }

# 0 logged in · 1 rejected. 5.x answers 204 (4.x: 200 "Ok."); a wrong
# password is 401 (4.x: 200 "Fails.").
login() { # user; password on stdin
    api /api/v2/auth/login --data-urlencode "username=$1" --data-urlencode "password@-" || return 1
    [[ "$HTTP" == 204 || ( "$HTTP" == 200 && "$(body)" == "Ok." ) ]]
}

# The temporary password qBittorrent prints while none is set.
temp_password() {
    docker logs "$QBT_CONTAINER" 2>&1 \
        | sed -n 's/.*temporary password is provided for this session: \([^[:space:]]*\).*/\1/p' \
        | tail -n1
}

set_prefs() { # json on stdin
    api /api/v2/app/setPreferences --data-urlencode "json@-"
}

# First run: log in with the temporary password and set ours.
bootstrap_credentials() {
    local tmp
    tmp="$(temp_password)"
    [[ -n "$tmp" ]] || return 1
    login admin < <(printf '%s' "$tmp") || return 1
    log "  first run: logged in with the temporary password; setting $QBT_ARR_USER"
    set_prefs < <(U="$QBT_ARR_USER" P="$QBT_ARR_PASS" jq -cn '{web_ui_username: env.U, web_ui_password: env.P}') \
        || return 1
    login "$QBT_ARR_USER" < <(printf '%s' "$QBT_ARR_PASS")
}

# Create, or on 409 (exists) edit, so a changed path is applied too.
ensure_category() { # name path
    api /api/v2/torrents/createCategory --data-urlencode "category=$1" --data-urlencode "savePath=$2" && return 0
    [[ "$HTTP" == 409 ]] || return 1
    api /api/v2/torrents/editCategory --data-urlencode "category=$1" --data-urlencode "savePath=$2"
}

# ─── read-back ────────────────────────────────────────────────────────────────
# "key<TAB>ok|DRIFT<TAB>got<TAB>want", one line per wanted preference.
prefs_report() { # got-json want-json
    jq -r --argjson want "$2" '. as $got | $want | to_entries[]
        | [.key, (if $got[.key] == .value then "ok" else "DRIFT" end),
           ($got[.key] | tostring), (.value | tostring)] | @tsv' <<<"$1"
}

categories_report() { # got-json
    local entry name path got
    for entry in "${CATEGORIES[@]}"; do
        name="${entry%%=*}"; path="${entry#*=}"
        got="$(jq -r --arg n "$name" '.[$n].savePath // "(missing)"' <<<"$1")"
        if [[ "$got" == "$path" ]]; then
            printf 'category %s\tok\t%s\t%s\n' "$name" "$got" "$path"
        else
            printf 'category %s\tDRIFT\t%s\t%s\n' "$name" "$got" "$path"
        fi
    done
}

verify() {
    local prefs cats report rc=0
    api /api/v2/app/preferences || { log "  FAIL  cannot read preferences (HTTP $HTTP)"; return 1; }
    prefs="$(body)"
    api /api/v2/torrents/categories || { log "  FAIL  cannot read categories (HTTP $HTTP)"; return 1; }
    cats="$(body)"
    report="$(prefs_report "$prefs" "$(want_prefs)"; categories_report "$cats")"
    while IFS=$'\t' read -r key state got want; do
        if [[ "$state" == ok ]]; then
            log "  ok     $key = $got"
        else
            log "  DRIFT  $key = $got, want $want"; rc=1
        fi
    done <<<"$report"
    return "$rc"
}

# ─── main ─────────────────────────────────────────────────────────────────────
main() {
    local mode=apply
    case "${1:-}" in
        "")        ;;
        --check)   mode=check ;;
        -h|--help) sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)         echo "usage: ${0##*/} [--check]" >&2; exit 2 ;;
    esac

    if [[ -z "$QBT_ARR_USER" || -z "$QBT_ARR_PASS" ]]; then
        echo "QBT_ARR_USER and QBT_ARR_PASS must be set in $REPO/.env (the :8081 instance's WebUI login)." >&2
        exit 3
    fi

    JAR="$(mktemp)"; BODY="$(mktemp)"; trap 'rm -f "$JAR" "$BODY"' EXIT

    log "qBittorrent at $QBT_ARR_URL ($mode)"
    if login "$QBT_ARR_USER" < <(printf '%s' "$QBT_ARR_PASS"); then
        log "  logged in as $QBT_ARR_USER"
    elif [[ "$mode" == apply ]] && bootstrap_credentials; then
        log "  credentials set; logged in as $QBT_ARR_USER"
    else
        log "  FAIL  cannot log in as $QBT_ARR_USER (HTTP ${HTTP:-000})."
        [[ "$mode" == check ]] || log "        No temporary password in 'docker logs $QBT_CONTAINER' either — is it running, or was its password set to something else?"
        exit 3
    fi

    if [[ "$mode" == apply ]]; then
        set_prefs < <(want_prefs) || { log "  FAIL  setPreferences (HTTP $HTTP)"; exit 1; }
        log "  preferences applied"
        local entry
        for entry in "${CATEGORIES[@]}"; do
            ensure_category "${entry%%=*}" "${entry#*=}" \
                || { log "  FAIL  category ${entry%%=*} (HTTP $HTTP)"; exit 1; }
        done
        log "  categories applied"
    fi

    log "Read-back:"
    if verify; then
        log "No drift."
        exit 0
    fi
    [[ "$mode" == check ]] && log "To apply: npm run qbt:configure"
    exit 1
}

[[ "${QBT_CONFIGURE_LIB:-0}" == "1" ]] || main "$@"
