#!/usr/bin/env bash
# bazarr-configure.sh — apply Bazarr's settings through its API, then read them
# back and test the connections. Idempotent.
#
#   tools/bazarr-configure.sh            apply, then verify
#   tools/bazarr-configure.sh --check    verify only; changes nothing
#
# Normally reached through npm: `npm run bazarr:configure` / `npm run bazarr:check`.
#
# Bazarr fetches Spanish and English subtitles for what Radarr and Sonarr
# manage, and writes them beside the video (Title (Year).es.srt / .en.srt),
# where Plex reads them as local subtitles. Plex's own "Search subtitles" keeps
# working beside it: Plex saves those into its database, never the library.
#
# The API key is Bazarr's own, generated on first start into
# $APPDATA/bazarr/config/config.yaml — nothing to put in .env. Radarr, Sonarr
# and Plex are reached with their .env keys; the WebUI login is ARR_USER/ARR_PASS.
# OpenSubtitles.com is used only when OPENSUBTITLES_USER/PASS are set.
#
# This script owns ALL language profiles: Bazarr replaces the whole list on a
# write, so a profile added in the WebUI is removed by the next apply.
#
# Exit: 0 applied and verified (or no drift; a FAILING connection only warns) ·
# 1 drift, or a step failed · 2 usage · 3 not reachable, or not configured.

set -uo pipefail

REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
# shellcheck source=SCRIPTDIR/lib/servarr.sh
. "$REPO/tools/lib/servarr.sh" || { echo "cannot load tools/lib/servarr.sh" >&2; exit 3; }

APPDATA="${APPDATA:-$(env_get APPDATA)}"; APPDATA="${APPDATA:-/opt/appdata}"
BAZARR_URL="${BAZARR_URL:-http://127.0.0.1:6767}"
BAZARR_CONFIG="${BAZARR_CONFIG:-$APPDATA/bazarr/config/config.yaml}"
BAZARR_TIMEOUT="${BAZARR_TIMEOUT:-60}"
BAZARR_WAIT="${BAZARR_WAIT:-90}"
RADARR_API_KEY="${RADARR_API_KEY:-$(env_get RADARR_API_KEY)}"
SONARR_API_KEY="${SONARR_API_KEY:-$(env_get SONARR_API_KEY)}"
ARR_USER="${ARR_USER:-$(env_get ARR_USER)}"
ARR_PASS="${ARR_PASS:-$(env_get ARR_PASS)}"
PLEX_TOKEN="${PLEX_TOKEN:-$(env_get PLEX_TOKEN)}"
OPENSUBTITLES_USER="${OPENSUBTITLES_USER:-$(env_get OPENSUBTITLES_USER)}"
OPENSUBTITLES_PASS="${OPENSUBTITLES_PASS:-$(env_get OPENSUBTITLES_PASS)}"
BZ_KEY=""

# ─── the settings ─────────────────────────────────────────────────────────────
# Wanted languages, in profile order. One profile, the default for every movie
# and series, so each title gets both.
LANGS=(es en)
PROFILE_ID=1
PROFILE_NAME="Spanish + English"

# Providers that need no account, by what they cover: subtis (Spanish movies),
# yifysubtitles (movies), subtitulamostv (Spanish/English TV), gestdown (TV).
# Bazarr 1.6 dropped podnapisi, and subdivx became subx, which needs an API key.
FREE_PROVIDERS=(subtis yifysubtitles subtitulamostv gestdown)

opensubtitles_on() { [[ -n "$OPENSUBTITLES_USER" && -n "$OPENSUBTITLES_PASS" ]]; }

providers() {
    if opensubtitles_on; then printf '%s\n' opensubtitlescom "${FREE_PROVIDERS[@]}"
    else printf '%s\n' "${FREE_PROVIDERS[@]}"; fi
}

# Every owned setting, as {"section.key": value}. Only these are ever written.
# auth.password is the md5 Bazarr stores; form_body sends the plain one.
# only_monitored stays off: most of the library is unmonitored (Phase 8 imported
# it that way), and those titles need subtitles as much as new ones.
# Not radarr/sonarr.base_url: a written "/" is stored as "", which would read
# back as drift forever, and the default already works.
want_settings() {
    local md5 os=()
    md5="$(printf '%s' "$ARR_PASS" | md5sum | cut -d' ' -f1)"
    opensubtitles_on && os=(--arg osu "$OPENSUBTITLES_USER" --arg osp "$OPENSUBTITLES_PASS")
    jq -cn --arg rk "$RADARR_API_KEY" --arg sk "$SONARR_API_KEY" \
        --arg user "$ARR_USER" --arg md5 "$md5" --argjson pid "$PROFILE_ID" \
        --argjson prov "$(providers | jq -Rcs 'split("\n") | map(select(. != ""))')" \
        "${os[@]}" '
        {
            "general.use_radarr": true,  "radarr.ip": "radarr", "radarr.port": 7878,
            "radarr.ssl": false, "radarr.apikey": $rk, "radarr.only_monitored": false,
            "general.use_sonarr": true,  "sonarr.ip": "sonarr", "sonarr.port": 8989,
            "sonarr.ssl": false, "sonarr.apikey": $sk, "sonarr.only_monitored": false,
            "general.movie_default_enabled": true, "general.movie_default_profile": $pid,
            "general.serie_default_enabled": true, "general.serie_default_profile": $pid,
            "general.enabled_providers": $prov,
            "general.use_embedded_subs": true,
            "general.subfolder": "current",
            "general.use_plex": true, "plex.ip": "host.docker.internal", "plex.port": 32400,
            "plex.ssl": false, "plex.movie_library": ["Movies"], "plex.series_library": ["TV Shows"],
            "plex.update_movie_library": true, "plex.update_series_library": true,
            "plex.set_movie_added": false, "plex.set_episode_added": false,
            "auth.type": "form", "auth.username": $user, "auth.password": $md5
        }
        + (if $ARGS.named.osu then
             {"opensubtitlescom.username": $ARGS.named.osu, "opensubtitlescom.password": $ARGS.named.osp}
           else {} end)'
}

want_profiles() {
    printf '%s\n' "${LANGS[@]}" | jq -Rcs --argjson id "$PROFILE_ID" --arg name "$PROFILE_NAME" '
        split("\n") | map(select(. != "")) | to_entries | [{
            profileId: $id, name: $name, cutoff: null,
            items: map({id: (.key + 1), language: .value, audio_exclude: "False",
                        audio_only_include: "False", hi: "False", forced: "False"}),
            mustContain: [], mustNotContain: [], originalFormat: false, tag: null
        }]'
}

# ─── pure helpers (tests/bazarr-configure.test.sh) ────────────────────────────
# auth.apikey from config.yaml, without a YAML parser: the key line inside the
# top-level auth: block.
bazarr_key() { # config.yaml
    awk '/^auth:/ { on = 1; next } /^[^ ]/ { on = 0 }
         on && $1 == "apikey:" { gsub(/["'\'']/, "", $2); print $2; exit }' "$1" 2>/dev/null
}

# Owned keys whose value differs in a GET /system/settings response; empty when none.
settings_drift() { # got-json want-json
    jq -r --argjson want "$2" '. as $got | $want | to_entries[] | .key as $k
        | select(($got | getpath($k | split("."))) != .value) | $k' <<<"$1"
}

# The url-encoded form body that writes the named keys: settings-<section>-<key>,
# one pair per list item. The plain password goes in; Bazarr hashes it.
form_body() { # want-json keys(newline-separated)
    P="$ARR_PASS" jq -rn --argjson want "$1" --arg keys "$2" '
        [ $keys | split("\n")[] | select(. != "") as $k
          | ($want[$k] | if $k == "auth.password" then env.P else . end) as $v
          | ("settings-" + ($k | sub("\\."; "-"))) as $name
          | (if ($v | type) == "array" then $v[] else $v end)
          | "\($name | @uri)=\(tostring | @uri)" ]
        | join("&")'
}

noun() { if [[ "$1" == movies ]]; then echo "movie(s)"; else echo "series"; fi; }

# What matters of a language profile list: names, cutoffs and languages in order.
profiles_shape() { jq -c '[.[] | {profileId, name, cutoff, langs: [.items[].language]}]' <<<"$1"; }
profiles_drift() { [[ "$(profiles_shape "$1")" != "$(profiles_shape "$(want_profiles)")" ]]; }

# Enabled language codes from GET /system/languages, sorted, one per line.
enabled_langs() { jq -r '[.[] | select(.enabled) | .code2] | sort | .[]' <<<"$1"; }
wanted_langs() { printf '%s\n' "${LANGS[@]}" | sort; }

# Ids of titles with no language profile, from GET /movies or /series.
unprofiled() { # list-json id-field
    jq -r --arg f "$2" '.data[] | select(.profileId == null) | .[$f]' <<<"$1"
}

# ─── API ──────────────────────────────────────────────────────────────────────
# Sets $HTTP, leaves the response in $BODY; a form body is read from stdin.
# Never inside $(...): a subshell loses $HTTP.
bz() { # METHOD path
    local data=()
    [[ "$1" == POST ]] && data=(-H 'Content-Type: application/x-www-form-urlencoded' --data-binary @-)
    HTTP="$(curl -s --max-time "$BAZARR_TIMEOUT" -X "$1" -o "$BODY" -w '%{http_code}' \
        -H "X-API-KEY: $BZ_KEY" "${data[@]}" "$BAZARR_URL/api$2")" || HTTP=000
    [[ "$HTTP" == 2* ]]
}
bz_get() { bz GET "$1" </dev/null; }

# The stored Plex token works: plex.tv answers Bazarr's account call with it.
# (Bazarr keeps it encrypted, so it cannot be compared with .env.)
plex_token_ok() { bz_get /plex/webhook/list && body | jq -e '.data | has("webhooks")' >/dev/null 2>&1; }

# ─── apply ────────────────────────────────────────────────────────────────────
apply_settings() {
    local want drift langs_drift=0 prof_drift=0 form
    want="$(want_settings)"
    bz_get /system/settings || { log "  FAIL  read settings (HTTP $HTTP)"; return 1; }
    drift="$(settings_drift "$(body)" "$want")"
    bz_get /system/languages || { log "  FAIL  read languages (HTTP $HTTP)"; return 1; }
    [[ "$(enabled_langs "$(body)")" == "$(wanted_langs)" ]] || langs_drift=1
    bz_get /system/languages/profiles || { log "  FAIL  read language profiles (HTTP $HTTP)"; return 1; }
    profiles_drift "$(body)" && prof_drift=1

    if [[ -z "$drift" && "$langs_drift" -eq 0 && "$prof_drift" -eq 0 ]]; then
        log "  settings already set"
        return 0
    fi
    form="$(form_body "$want" "$drift")"
    if [[ "$langs_drift" -eq 1 ]]; then
        form+="${form:+&}$(printf '%s\n' "${LANGS[@]}" | jq -Rrs 'split("\n") | map(select(. != "") | "languages-enabled=\(@uri)") | join("&")')"
    fi
    if [[ "$prof_drift" -eq 1 ]]; then
        form+="${form:+&}languages-profiles=$(want_profiles | jq -Rr '@uri')"
    fi
    bz POST /system/settings < <(printf '%s' "$form") \
        || { log "  FAIL  write settings (HTTP $HTTP): $(body | head -c 160)"; return 1; }
    local what
    what="$(sed 's/\.password$/.password (hidden)/; s/\.apikey$/.apikey (hidden)/' <<<"$drift" | paste -sd' ' -)"
    [[ "$langs_drift" -eq 1 ]] && what+=" languages:${LANGS[*]}"
    [[ "$prof_drift" -eq 1 ]] && what+=" profile:'$PROFILE_NAME'"
    log "  settings set: ${what# }"
}

apply_plex_token() {
    if plex_token_ok; then log "  Plex token already set"; return 0; fi
    bz POST /plex/apikey < <(jq -rn --arg t "$PLEX_TOKEN" '"apikey=\($t | @uri)"') \
        || { log "  FAIL  Plex token (HTTP $HTTP)"; return 1; }
    log "  Plex token set (stored encrypted)"
}

# Titles synced before a default profile existed have none. Give them the one
# profile; titles added later get it as the default.
apply_profiles_to_titles() {
    local kind field ids n form
    for kind in movies series; do
        field=radarrId; [[ "$kind" == series ]] && field=sonarrSeriesId
        bz_get "/$kind?start=0&length=-1" || { log "  FAIL  read $kind (HTTP $HTTP)"; return 1; }
        ids="$(unprofiled "$(body)" "$field")"
        n="$(grep -c . <<<"$ids")"
        [[ "$n" -eq 0 ]] && continue
        local idkey=radarrid; [[ "$kind" == series ]] && idkey=seriesid
        form="$(jq -Rrs --arg k "$idkey" --arg p "$PROFILE_ID" \
            'split("\n") | map(select(. != "") | "\($k)=\(.)&profileid=\($p)") | join("&")' <<<"$ids")"
        bz POST "/$kind" < <(printf '%s' "$form") || { log "  FAIL  profile for $kind (HTTP $HTTP)"; return 1; }
        log "  '$PROFILE_NAME' given to $n $(noun "$kind") that had no profile"
    done
}

# ─── verify ───────────────────────────────────────────────────────────────────
# Radarr/Sonarr are connected once Bazarr reports their versions. Right after
# they are enabled that takes a few seconds; re-ask for up to CONNECT_SETTLE tries.
CONNECT_SETTLE="${CONNECT_SETTLE:-10}"
app_version() { # radarr|sonarr
    local try=0 v
    while :; do
        bz_get /system/status && v="$(body | jq -r --arg a "$1" '.data[$a + "_version"] // empty')"
        [[ -n "${v:-}" ]] && { printf '%s' "$v"; return 0; }
        (( ++try < CONNECT_SETTLE )) || return 1
        sleep 3
    done
}

verify() {
    local rc=0 drift app v kind field n
    bz_get /system/settings || { log "  FAIL  read settings"; return 1; }
    drift="$(settings_drift "$(body)" "$(want_settings)")"
    if [[ -n "$drift" ]]; then log "  DRIFT    settings: $(paste -sd' ' - <<<"$drift")"; rc=1
    else log "  ok       settings: Radarr/Sonarr, default profile, providers $(providers | paste -sd, -), Plex refresh, form login"; fi
    opensubtitles_on || log "  warn     OpenSubtitles.com off — set OPENSUBTITLES_USER/PASS in .env for its catalogue"

    bz_get /system/languages || { log "  FAIL  read languages"; return 1; }
    if [[ "$(enabled_langs "$(body)")" == "$(wanted_langs)" ]]; then log "  ok       languages: ${LANGS[*]}"
    else log "  DRIFT    languages enabled: $(enabled_langs "$(body)" | paste -sd, -), want ${LANGS[*]}"; rc=1; fi

    bz_get /system/languages/profiles || { log "  FAIL  read language profiles"; return 1; }
    if profiles_drift "$(body)"; then log "  DRIFT    language profiles: $(profiles_shape "$(body)")"; rc=1
    else log "  ok       one profile: '$PROFILE_NAME' (${LANGS[*]})"; fi

    for app in radarr sonarr; do
        if v="$(app_version "$app")"; then log "  ok       $app connected ($v)"
        else log "  FAILING  $app not connected — Bazarr reports no version"; fi
    done

    if plex_token_ok; then log "  ok       Plex token accepted"
    else log "  FAILING  Plex token refused — Plex will not refresh after a download"; fi

    for kind in movies series; do
        field=radarrId; [[ "$kind" == series ]] && field=sonarrSeriesId
        bz_get "/$kind?start=0&length=-1" || { log "  FAIL  read $kind"; return 1; }
        n="$(unprofiled "$(body)" "$field" | grep -c .)"
        if [[ "$n" -gt 0 ]]; then log "  DRIFT    $n $(noun "$kind") without a language profile"; rc=1; fi
    done

    # Informational: what is still wanted, and anything Bazarr flags.
    if bz_get /badges; then
        log "  info     wanted: $(body | jq -r '"\(.movies) movie(s), \(.episodes) episode(s)"')"
    fi
    if bz_get /system/health; then
        body | jq -r '.data[]? | "  warn     health: \(.object // "") \(.issue // .)"' 2>/dev/null
    fi
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

    local k missing=()
    for k in RADARR_API_KEY SONARR_API_KEY ARR_USER ARR_PASS PLEX_TOKEN; do [[ -n "${!k}" ]] || missing+=("$k"); done
    [[ ${#missing[@]} -eq 0 ]] || { echo "Set ${missing[*]} in $REPO/.env." >&2; exit 3; }
    BZ_KEY="$(bazarr_key "$BAZARR_CONFIG")"
    [[ -n "$BZ_KEY" ]] || { echo "No API key in $BAZARR_CONFIG — has Bazarr started once?" >&2; exit 3; }

    BODY="$(mktemp)"; trap 'rm -f "$BODY"' EXIT
    log "Bazarr at $BAZARR_URL ($mode)"
    local deadline=$((SECONDS + BAZARR_WAIT))
    until bz_get /system/status; do
        [[ "$HTTP" == 401 ]] && { log "  FAIL  the key from $BAZARR_CONFIG is refused"; exit 3; }
        (( SECONDS < deadline )) || { log "  FAIL  not answering at $BAZARR_URL — is it running?"; exit 3; }
        sleep 3
    done
    log "  up: $(body | jq -r .data.bazarr_version)"

    if [[ "$mode" == apply ]]; then
        apply_settings && apply_plex_token && apply_profiles_to_titles || exit 1
    fi
    log "Read-back:"
    if verify; then log "No drift."; exit 0; fi
    [[ "$mode" == check ]] && log "To apply: npm run bazarr:configure"
    exit 1
}

[[ "${BAZARR_CONFIGURE_LIB:-0}" == "1" ]] || main "$@"
