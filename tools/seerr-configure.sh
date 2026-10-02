#!/usr/bin/env bash
# seerr-configure.sh — apply Seerr's settings through its API, then read them
# back and test the connections. Idempotent.
#
#   tools/seerr-configure.sh            apply, then verify
#   tools/seerr-configure.sh --check    verify only; changes nothing
#
# Normally reached through npm: `npm run seerr:configure` / `npm run seerr:check`.
#
# One step cannot be scripted: Seerr's first run needs you to sign in with Plex
# in a browser (OAuth). That creates the admin account the API key acts as —
# until then every settings call is 403, and this script says so and stops.
# Sign in, then run this; it does the rest of the setup wizard, including
# marking it finished.
#
# The API key is Seerr's own, generated on first start into
# $APPDATA/seerr/settings.json — nothing to put in .env. Radarr and Sonarr are
# reached with their .env keys.
#
# Requests from Seerr are ordinary Radarr/Sonarr adds, so everything Phases 4
# and 6 set up applies to them unchanged: the profiles below, hardlinked
# imports, unmonitor on delete, and arr-reclaim freeing the space of a Plex delete.
#
# Exit: 0 applied and verified (or no drift; a FAILING test only warns) ·
# 1 drift, or a step failed · 2 usage · 3 not reachable, or no admin yet.

set -uo pipefail

REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
# shellcheck source=SCRIPTDIR/lib/servarr.sh
. "$REPO/tools/lib/servarr.sh" || { echo "cannot load tools/lib/servarr.sh" >&2; exit 3; }

APPDATA="${APPDATA:-$(env_get APPDATA)}"; APPDATA="${APPDATA:-/opt/appdata}"
SEERR_URL="${SEERR_URL:-http://127.0.0.1:5055}"
SEERR_SETTINGS="${SEERR_SETTINGS:-$APPDATA/seerr/settings.json}"
RADARR_API_KEY="${RADARR_API_KEY:-$(env_get RADARR_API_KEY)}"
SONARR_API_KEY="${SONARR_API_KEY:-$(env_get SONARR_API_KEY)}"
PLEX_URL="${PLEX_URL:-http://127.0.0.1:32400}"   # from this host, for the identity check

# Seerr's API is /api/v1 with the same X-Api-Key header as the Servarr apps.
SVC_NAME=seerr SVC_API=v1 SVC_URL="$SEERR_URL"
SVC_TIMEOUT="${SEERR_TIMEOUT:-60}" SVC_WAIT="${SEERR_WAIT:-90}"
SVC_KEY=""

# ─── the settings ─────────────────────────────────────────────────────────────
# Plex on the host network, through the host gateway.
want_plex() { jq -cn '{ip: "host.docker.internal", port: 32400, useSsl: false}'; }

# Libraries by NAME: Plex section ids differ between installs. "Other Videos"
# stays off (not requestable); Plex photo libraries are never offered at all.
LIBRARIES=("Movies" "TV Shows")

# Only the admin (you) signs in; the admin's requests are auto-approved.
want_main() { jq -cn '{newPlexLogin: false}'; }

# The profile a request uses by default, per app — the ones Recyclarr creates
# (recyclarr/recyclarr.yml) and arr-configure.sh's default_profile names.
# Movies are 4K HDR; series stay 1080p. For a film with no 4K HDR release, pick
# "4K HDR or 1080p" in the request's options (admin): 1080p now, replaced by 4K
# HDR when one appears. It stays opt-in, so it is never the default here.
profile_name() { case "$1" in radarr) echo "UHD Bluray + WEB" ;; sonarr) echo "WEB-1080p" ;; esac; }

# The host's LAN address, for the "open in Radarr/Sonarr" links Seerr shows.
lan_ip() { lan_ips | head -1; }

# One default, non-4K server per app. The profile id is taken from the app's
# own test response, never assumed.
want_server() { # app profile-id
    local app="$1" pid="$2" key port root
    case "$app" in
        radarr) key="$RADARR_API_KEY"; port=7878; root=/mnt/data/streaming/movies ;;
        sonarr) key="$SONARR_API_KEY"; port=8989; root=/mnt/data/streaming/series ;;
    esac
    jq -cn --arg app "$app" --arg key "$key" --argjson port "$port" --arg root "$root" \
        --argjson pid "$pid" --arg pname "$(profile_name "$app")" --arg ext "http://$(lan_ip):$port" '
        {
            name: ($app | .[0:1] | ascii_upcase) + ($app | .[1:]),
            hostname: $app, port: $port, apiKey: $key, useSsl: false, baseUrl: "",
            activeProfileId: $pid, activeProfileName: $pname, activeDirectory: $root,
            is4k: false, isDefault: true, externalUrl: $ext,
            syncEnabled: false, preventSearch: false
        }
        + (if $app == "radarr" then {minimumAvailability: "released"}
           else {activeAnimeProfileId: $pid, activeAnimeProfileName: $pname,
                 activeAnimeDirectory: $root, enableSeasonFolders: true} end)'
}

# ─── pure helpers (tests/seerr-configure.test.sh) ─────────────────────────────
seerr_key() { jq -r '.main.apiKey // empty' "$1" 2>/dev/null; }

# The id of a quality profile by name, from a /settings/<app>/test response.
profile_id() { # test-json name
    jq -r --arg n "$2" '[.profiles[]? | select(.name == $n) | .id][0] // empty' <<<"$1"
}

# Keys of $want that differ in $got, ignoring the API key (compared by test).
server_drift() { # got want
    host_drift "$1" "$(jq -c 'del(.apiKey)' <<<"$2")"
}

# Library names enabled in a /settings/plex/library response, sorted, one per line.
enabled_libraries() { jq -r '[.[] | select(.enabled) | .name] | sort | .[]' <<<"$1"; }
wanted_libraries() { printf '%s\n' "${LIBRARIES[@]}" | sort; }

# ─── the profile id, as the app reports it ────────────────────────────────────
# Right after `npm run recyclarr:sync` a new profile can be missing from what
# Seerr relays for a few seconds (seen 2026-09-29: seerr:configure run straight
# after the sync failed, and the same call a minute later listed it). Re-ask
# for up to PROFILE_SETTLE tries, 2 s apart, before calling it missing.
PROFILE_SETTLE="${PROFILE_SETTLE:-6}"
PID=""
# Sets PID. 0 found · 1 the connection test failed · 2 not visible after retries.
# Never call inside $(...): api() sets $HTTP, which a subshell would lose.
settled_profile_id() { # app test-body-json
    local try=0
    PID=""
    while :; do
        api POST "/settings/$1/test" < <(printf '%s' "$2") || return 1
        PID="$(profile_id "$(body)" "$(profile_name "$1")")"
        [[ -n "$PID" ]] && return 0
        (( ++try < PROFILE_SETTLE )) || return 2
        sleep 2
    done
}

# What to tell the user when the profile is not there after the retries.
profile_missing_msg() { # app
    printf "%s has no '%s' profile visible after ~%ss — did npm run recyclarr:sync finish? (it creates it)" \
        "$1" "$(profile_name "$1")" "$(( (PROFILE_SETTLE - 1) * 2 ))"
}

# ─── apply ────────────────────────────────────────────────────────────────────
apply_plex() {
    local cur drift
    get /settings/plex || { log "  FAIL  read Plex settings (HTTP $HTTP)"; return 1; }
    cur="$(body)"; drift="$(host_drift "$cur" "$(want_plex)")"
    if [[ -z "$drift" && "$(jq -r '.machineId // empty' <<<"$cur")" != "" ]]; then
        log "  Plex server already set"
    else
        # Seerr connects with the admin's Plex token and records the server's
        # machineId — a 200 here is itself a connection test.
        # Only the fields we own: Seerr rejects read-only ones (machineId,
        # name, libraries…) sent back in a write with a 400.
        api POST /settings/plex < <(want_plex) \
            || { log "  FAIL  Plex server (HTTP $HTTP): $(api_error)"; return 1; }
        log "  Plex server set: $(body | jq -r '"\(.name) (\(.machineId))"')"
    fi

    api POST /settings/plex/library/sync </dev/null || { log "  FAIL  sync Plex libraries (HTTP $HTTP)"; return 1; }
    local libs id name enabled want changed=0
    libs="$(body)"
    while IFS=$'\t' read -r id name enabled; do
        want=false
        printf '%s\n' "${LIBRARIES[@]}" | grep -qxF "$name" && want=true
        [[ "$enabled" == "$want" ]] && continue
        api PUT "/settings/plex/library/$id" < <(jq -cn --argjson e "$want" '{enabled: $e}') \
            || { log "  FAIL  library $name (HTTP $HTTP)"; return 1; }
        changed=1
    done < <(jq -r '.[] | [.id, .name, .enabled] | @tsv' <<<"$libs")
    if [[ "$changed" -eq 1 ]]; then log "  libraries set: ${LIBRARIES[*]}"
    else log "  libraries already set"; fi
}

apply_server() { # app
    local app="$1" pid want cur drift id rc=0
    settled_profile_id "$app" "$(want_server "$app" 0)" || rc=$?
    case "$rc" in
        1) log "  FAIL  $app connection test (HTTP $HTTP): $(api_error)"; return 1 ;;
        2) log "  FAIL  $(profile_missing_msg "$app")"; return 1 ;;
    esac
    pid="$PID"
    want="$(want_server "$app" "$pid")"

    get "/settings/$app" || { log "  FAIL  read $app servers (HTTP $HTTP)"; return 1; }
    cur="$(body | jq -c '[.[] | select(.is4k == false)][0] // empty')"
    if [[ -z "$cur" ]]; then
        api POST "/settings/$app" < <(printf '%s' "$want") \
            || { log "  FAIL  add $app (HTTP $HTTP): $(api_error)"; return 1; }
        log "  $app server added ($(profile_name "$app"))"
        return 0
    fi
    drift="$(server_drift "$cur" "$want")"
    if [[ -z "$drift" ]]; then log "  $app server already set"; return 0; fi
    id="$(jq -r .id <<<"$cur")"
    api PUT "/settings/$app/$id" < <(printf '%s' "$want") \
        || { log "  FAIL  update $app (HTTP $HTTP): $(api_error)"; return 1; }
    log "  $app server updated ($(tr '\n' ' ' <<<"$drift" | sed 's/ $//'))"
}

apply_main() {
    local cur drift
    get /settings/main || { log "  FAIL  read main settings (HTTP $HTTP)"; return 1; }
    cur="$(body)"; drift="$(host_drift "$cur" "$(want_main)")"
    if [[ -z "$drift" ]]; then log "  sign-in already admin-only"; return 0; fi
    api POST /settings/main < <(want_main) \
        || { log "  FAIL  main settings (HTTP $HTTP): $(api_error)"; return 1; }
    log "  sign-in set to admin-only (newPlexLogin off)"
}

# The wizard's last step. Then one full Plex scan, so every title already in
# the library shows as Available and cannot be requested again as a duplicate —
# Seerr reads that from Plex, whatever Radarr/Sonarr know.
apply_finish() {
    local init
    init="$(curl -s --max-time "$SVC_TIMEOUT" "$SEERR_URL/api/v1/settings/public" | jq -r '.initialized')"
    if [[ "$init" != true ]]; then
        api POST /settings/initialize </dev/null || { log "  FAIL  finish setup (HTTP $HTTP)"; return 1; }
        log "  setup wizard marked finished"
        if api POST /settings/jobs/plex-full-scan/run </dev/null; then
            log "  Plex full scan started (marks the existing library Available)"
        else
            log "  WARN  could not start the Plex full scan (HTTP $HTTP) — Settings → Jobs"
        fi
    else
        log "  setup already finished"
    fi
}

# ─── verify ───────────────────────────────────────────────────────────────────
verify() {
    local rc=0 cur drift mid live app pid
    get /settings/plex || { log "  FAIL  read Plex settings"; return 1; }
    cur="$(body)"; drift="$(host_drift "$cur" "$(want_plex)")"
    mid="$(jq -r '.machineId // empty' <<<"$cur")"
    live="$(curl -s --max-time 10 "$PLEX_URL/identity" | sed -n 's/.*machineIdentifier="\([^"]*\)".*/\1/p' | head -1)"
    if [[ -n "$drift" ]]; then log "  DRIFT    Plex: $(tr '\n' ' ' <<<"$drift")"; rc=1
    elif [[ -z "$mid" || "$mid" != "$live" ]]; then log "  DRIFT    Plex server is '${mid:-none}', but Plex answers as '${live:-nothing}'"; rc=1
    else log "  ok       Plex server $(jq -r .name <<<"$cur") ($mid)"; fi

    get /settings/plex/library || { log "  FAIL  read libraries"; return 1; }
    if [[ "$(enabled_libraries "$(body)")" == "$(wanted_libraries)" ]]; then log "  ok       libraries: ${LIBRARIES[*]}"
    else log "  DRIFT    libraries enabled: $(enabled_libraries "$(body)" | paste -sd, -), want ${LIBRARIES[*]}"; rc=1; fi

    for app in radarr sonarr; do
        get "/settings/$app" || { log "  FAIL  read $app"; return 1; }
        cur="$(body | jq -c '[.[] | select(.is4k == false)][0] // empty')"
        if [[ -z "$cur" ]]; then log "  DRIFT    $app server missing"; rc=1; continue; fi
        # The wanted profile id comes from the app itself, as in apply — never
        # from what is stored, or a wrong id would be compared with itself.
        local src=0
        settled_profile_id "$app" "$cur" || src=$?
        if [[ "$src" -eq 1 ]]; then log "  FAILING  $app server — test fails: $(api_error)"; continue; fi
        if [[ "$src" -eq 2 ]]; then log "  DRIFT    $(profile_missing_msg "$app")"; rc=1; continue; fi
        pid="$PID"
        drift="$(server_drift "$cur" "$(want_server "$app" "$pid")")"
        if [[ -n "$drift" ]]; then log "  DRIFT    $app: $(tr '\n' ' ' <<<"$drift")"; rc=1; continue; fi
        log "  ok       $app server — test passes, $(profile_name "$app") (id $pid)"
    done

    get /settings/main || { log "  FAIL  read main"; return 1; }
    if [[ -z "$(host_drift "$(body)" "$(want_main)")" ]]; then log "  ok       sign-in admin-only"
    else log "  DRIFT    new Plex users can sign in"; rc=1; fi

    if [[ "$(curl -s --max-time 10 "$SEERR_URL/api/v1/settings/public" | jq -r .initialized)" == true ]]; then
        log "  ok       setup finished"
    else log "  DRIFT    setup wizard not finished"; rc=1; fi

    # Informational: what the Plex scan has marked Available so far.
    if get "/media?filter=available&take=1"; then
        log "  info     $(body | jq -r '.pageInfo.results // 0') title(s) Available (from Plex)"
    fi
    return "$rc"
}

# ─── main ─────────────────────────────────────────────────────────────────────
main() {
    local mode=apply
    case "${1:-}" in
        "")        ;;
        --check)   mode=check ;;
        -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)         echo "usage: ${0##*/} [--check]" >&2; exit 2 ;;
    esac

    local k missing=()
    for k in RADARR_API_KEY SONARR_API_KEY; do [[ -n "${!k}" ]] || missing+=("$k"); done
    [[ ${#missing[@]} -eq 0 ]] || { echo "Set ${missing[*]} in $REPO/.env." >&2; exit 3; }
    SVC_KEY="$(seerr_key "$SEERR_SETTINGS")"
    [[ -n "$SVC_KEY" ]] || { echo "No API key in $SEERR_SETTINGS — has Seerr started once?" >&2; exit 3; }

    BODY="$(mktemp)"; trap 'rm -f "$BODY"' EXIT
    log "Seerr at $SEERR_URL ($mode)"
    local deadline=$((SECONDS + SVC_WAIT))
    until curl -sf --max-time 5 -o /dev/null "$SEERR_URL/api/v1/status"; do
        (( SECONDS < deadline )) || { log "  FAIL  not answering at $SEERR_URL — is it running?"; exit 3; }
        sleep 3
    done
    log "  up: $(curl -s "$SEERR_URL/api/v1/status" | jq -r .version)"

    # 403 with the key means no admin exists: the Plex sign-in has not happened.
    if ! get /settings/main; then
        if [[ "$HTTP" == 403 ]]; then
            log "  Sign in first: open http://$(lan_ip):5055 and sign in with Plex (just that — this script does the rest of the wizard)."
        else
            log "  FAIL  settings not readable (HTTP $HTTP)"
        fi
        exit 3
    fi

    if [[ "$mode" == apply ]]; then
        apply_plex && apply_server radarr && apply_server sonarr && apply_main && apply_finish || exit 1
    fi
    log "Read-back:"
    if verify; then log "No drift."; exit 0; fi
    [[ "$mode" == check ]] && log "To apply: npm run seerr:configure"
    exit 1
}

[[ "${SEERR_CONFIGURE_LIB:-0}" == "1" ]] || main "$@"
