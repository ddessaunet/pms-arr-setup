#!/usr/bin/env bash
# prowlarr-configure.sh — apply Prowlarr's settings through its API, then read
# them back and test every indexer. Idempotent: re-running changes nothing.
#
#   tools/prowlarr-configure.sh            apply login, FlareSolverr, indexers; verify
#   tools/prowlarr-configure.sh --check    read back and test only; changes nothing
#
# Normally reached through npm: `npm run prowlarr:configure` / `prowlarr:check`.
#
# The API key is not set here: compose passes PROWLARR_API_KEY from .env as
# PROWLARR__AUTH__APIKEY, so it is fixed before the first start and Radarr and
# Sonarr (Phase 4) can use it without anyone copying it out of the UI. The auth
# method (forms, not required from local addresses) comes the same way.
#
# The indexers live below as data. Public trackers come and go: a dead one is
# reported as FAILING, not treated as a configuration error.
#
# Exit: 0 applied and verified (or no drift; FAILING indexers only warn) ·
# 1 drift, or a step failed · 2 usage · 3 unreachable or not configured.

set -uo pipefail

REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"

# env_get, the api() plumbing, login and allowed hosts — shared with arr-configure.sh.
# shellcheck source=SCRIPTDIR/lib/servarr.sh
. "$REPO/tools/lib/servarr.sh" || { echo "cannot load tools/lib/servarr.sh" >&2; exit 3; }

PROWLARR_URL="${PROWLARR_URL:-http://127.0.0.1:9696}"
PROWLARR_API_KEY="${PROWLARR_API_KEY:-$(env_get PROWLARR_API_KEY)}"
PROWLARR_USER="${PROWLARR_USER:-$(env_get PROWLARR_USER)}"
PROWLARR_PASS="${PROWLARR_PASS:-$(env_get PROWLARR_PASS)}"
FLARESOLVERR_URL="${FLARESOLVERR_URL:-http://flaresolverr:8191/}"
# Adding or testing an indexer makes Prowlarr fetch the site first; through
# FlareSolverr that alone is ~15-20 s, and a slow tracker adds to it.
PROWLARR_TIMEOUT="${PROWLARR_TIMEOUT:-120}"
PROWLARR_WAIT="${PROWLARR_WAIT:-90}"

SVC_NAME=prowlarr SVC_API=v1
SVC_URL="$PROWLARR_URL" SVC_KEY="$PROWLARR_API_KEY"
SVC_USER="$PROWLARR_USER" SVC_PASS="$PROWLARR_PASS"
SVC_TIMEOUT="$PROWLARR_TIMEOUT" SVC_WAIT="$PROWLARR_WAIT"

# ─── the settings ─────────────────────────────────────────────────────────────
# definitionName|route. "flare" sends that indexer through FlareSolverr (via
# the `flare` tag); keep it to the ones Cloudflare actually blocks, since each
# search through it costs a headless Chromium and ~15 s. Measured 2026-09-29:
# 1337x and EZTV each pass once, are then challenged ("blocked by CloudFlare
# Protection"), and pass through FlareSolverr — both definitions carry a
# FlareSolverr note. The rest pass direct. Flip an entry to "flare" if its
# test starts failing on a Cloudflare challenge.
INDEXERS=(
    "1337x|flare"
    "thepiratebay|direct"
    "limetorrents|direct"
    "Knaben|direct"
    "yts|direct"
    "eztv|flare"
)

FLARE_TAG="flare"

# Applications Prowlarr pushes its indexers to (full sync), as
# implementation|compose service|port|.env key. Each is applied only when its
# key is set, so Prowlarr on its own (Phase 3) still configures cleanly.
# URLs are container names on the arr network; the *_APP_URL overrides exist
# for rehearsing against throwaway containers.
APPLICATIONS=(
    "Radarr|radarr|7878|RADARR_API_KEY"
    "Sonarr|sonarr|8989|SONARR_API_KEY"
)
PROWLARR_SELF_URL="${PROWLARR_SELF_URL:-http://prowlarr:9696}"

app_entry_key() { local v="${1##*|}"; printf '%s' "${!v:-$(env_get "$v")}"; }
app_entry_url() {
    local rest="${1#*|}" svc port v
    svc="${rest%%|*}"; rest="${rest#*|}"; port="${rest%%|*}"; v="${svc^^}_APP_URL"
    printf '%s' "${!v:-http://$svc:$port}"
}
want_app_fields() { # entry
    jq -cn --arg p "$PROWLARR_SELF_URL" --arg b "$(app_entry_url "$1")" '{prowlarrUrl: $p, baseUrl: $b}'
}
want_app_top() { jq -cn --arg n "${1%%|*}" '{name: $n, syncLevel: "fullSync"}'; }

# ─── pure helpers (tests/prowlarr-configure.test.sh) ──────────────────────────

# A new indexer from its schema entry.
indexer_new() { # schema-entry app-profile-id tags-json
    jq -c --argjson p "$2" --argjson t "$3" '.enable = true | .appProfileId = $p | .tags = $t' <<<"$1"
}

# An existing indexer brought to what we want; same object when nothing changes.
indexer_fix() { # indexer tags-json
    jq -c --argjson t "$2" '.enable = true | .tags = $t' <<<"$1"
}

indexer_differs() { # indexer tags-json
    [[ "$(jq -c --argjson t "$2" '[.enable == true, ((.tags | sort) == ($t | sort))] | all' <<<"$1")" != true ]]
}

proxy_differs() { # proxy host tag-id
    [[ "$(jq -c --arg h "$2" --argjson t "$3" \
        '[(.fields[] | select(.name == "host") | .value) == $h, .tags == [$t]] | all' <<<"$1")" != true ]]
}

# ─── apply ────────────────────────────────────────────────────────────────────
FLARE_ID=""
apply_flare() {
    local schema cur id
    # Prowlarr answers an existing label with that tag, so this is idempotent.
    api POST /tag < <(jq -cn --arg l "$FLARE_TAG" '{label: $l}') \
        || { log "  FAIL  tag (HTTP $HTTP)"; return 1; }
    FLARE_ID="$(body | jq -r .id)"

    get /indexerProxy || { log "  FAIL  read proxies (HTTP $HTTP)"; return 1; }
    cur="$(body | jq -c '[.[] | select(.implementation == "FlareSolverr")][0] // empty')"
    if [[ -z "$cur" ]]; then
        get /indexerProxy/schema || { log "  FAIL  proxy schema (HTTP $HTTP)"; return 1; }
        schema="$(body | jq -c '.[] | select(.implementation == "FlareSolverr")')"
        api POST /indexerProxy < <(jq -c --arg h "$FLARESOLVERR_URL" --argjson t "$FLARE_ID" \
            '.name = "FlareSolverr" | .tags = [$t] | (.fields[] | select(.name == "host") | .value) = $h' <<<"$schema") \
            || { log "  FAIL  add FlareSolverr proxy (HTTP $HTTP): $(api_error)"; return 1; }
        log "  FlareSolverr proxy added ($FLARESOLVERR_URL, tag $FLARE_TAG)"
    elif proxy_differs "$cur" "$FLARESOLVERR_URL" "$FLARE_ID"; then
        id="$(jq -r .id <<<"$cur")"
        api PUT "/indexerProxy/$id" < <(jq -c --arg h "$FLARESOLVERR_URL" --argjson t "$FLARE_ID" \
            '.tags = [$t] | (.fields[] | select(.name == "host") | .value) = $h' <<<"$cur") \
            || { log "  FAIL  update FlareSolverr proxy (HTTP $HTTP)"; return 1; }
        log "  FlareSolverr proxy updated"
    else
        log "  FlareSolverr proxy already set"
    fi
}

tags_for() { [[ "$1" == flare ]] && printf '[%s]' "$FLARE_ID" || printf '[]'; }

apply_applications() {
    local entry key
    for entry in "${APPLICATIONS[@]}"; do
        key="$(app_entry_key "$entry")"
        if [[ -z "$key" ]]; then log "  ${entry%%|*}: no API key in .env — skipped"; continue; fi
        apply_resource "application ${entry%%|*}" applications "${entry%%|*}" \
            "$(want_app_top "$entry")" "$(want_app_fields "$entry")" apiKey "$key" || return 1
    done
}

apply_indexers() {
    local schema existing profile entry def route tags cur
    get /indexer/schema || { log "  FAIL  indexer schema (HTTP $HTTP)"; return 1; }
    schema="$(body)"
    get /indexer || { log "  FAIL  read indexers (HTTP $HTTP)"; return 1; }
    existing="$(body)"
    get /appprofile || { log "  FAIL  app profiles (HTTP $HTTP)"; return 1; }
    profile="$(body | jq -r '.[0].id')"

    for entry in "${INDEXERS[@]}"; do
        def="${entry%%|*}"; route="${entry#*|}"; tags="$(tags_for "$route")"
        cur="$(jq -c --arg d "$def" '[.[] | select(.definitionName == $d)][0] // empty' <<<"$existing")"
        if [[ -z "$cur" ]]; then
            local s
            s="$(jq -c --arg d "$def" '.[] | select(.definitionName == $d)' <<<"$schema")"
            [[ -n "$s" ]] || { log "  FAIL  $def: no such indexer definition in Prowlarr"; return 1; }
            api POST /indexer < <(indexer_new "$s" "$profile" "$tags") \
                || { log "  FAIL  add $def (HTTP $HTTP): $(api_error)"; return 1; }
            log "  $def added ($route)"
        elif indexer_differs "$cur" "$tags"; then
            api PUT "/indexer/$(jq -r .id <<<"$cur")" < <(indexer_fix "$cur" "$tags") \
                || { log "  FAIL  update $def (HTTP $HTTP)"; return 1; }
            log "  $def updated ($route)"
        else
            log "  $def already set ($route)"
        fi
    done
}

# ─── verify ───────────────────────────────────────────────────────────────────
# Drift fails; an indexer failing its own test only warns — trackers go down.
verify() {
    local rc=0 proxy existing entry def route tags ix name
    verify_host || rc=1

    local entry
    for entry in "${APPLICATIONS[@]}"; do
        [[ -n "$(app_entry_key "$entry")" ]] || continue
        verify_resource "application ${entry%%|*}" applications "${entry%%|*}" \
            "$(want_app_top "$entry")" "$(want_app_fields "$entry")" || rc=1
    done

    get /tag || { log "  FAIL  read tags"; return 1; }
    FLARE_ID="$(body | jq -r --arg l "$FLARE_TAG" '[.[] | select(.label == $l)][0].id // empty')"
    get /indexerProxy || { log "  FAIL  read proxies"; return 1; }
    proxy="$(body | jq -c '[.[] | select(.implementation == "FlareSolverr")][0] // empty')"
    if [[ -n "$FLARE_ID" && -n "$proxy" ]] && ! proxy_differs "$proxy" "$FLARESOLVERR_URL" "$FLARE_ID"; then
        if api POST /indexerProxy/test < <(printf '%s' "$proxy"); then
            log "  ok       FlareSolverr proxy $FLARESOLVERR_URL answers"
        else
            log "  WARN     FlareSolverr proxy set, but its test fails (HTTP $HTTP)"
        fi
    else
        log "  DRIFT    FlareSolverr proxy or '$FLARE_TAG' tag missing or changed"; rc=1
    fi

    get /indexer || { log "  FAIL  read indexers"; return 1; }
    existing="$(body)"
    for entry in "${INDEXERS[@]}"; do
        def="${entry%%|*}"; route="${entry#*|}"; tags="$(tags_for "$route")"
        ix="$(jq -c --arg d "$def" '[.[] | select(.definitionName == $d)][0] // empty' <<<"$existing")"
        if [[ -z "$ix" ]]; then log "  DRIFT    $def missing"; rc=1; continue; fi
        name="$(jq -r .name <<<"$ix")"
        if indexer_differs "$ix" "$tags"; then log "  DRIFT    $name disabled or tags changed (want $route)"; rc=1; continue; fi
        if api POST /indexer/test < <(printf '%s' "$ix"); then
            log "  ok       $name ($route) — test passes"
        else
            log "  FAILING  $name ($route) — test fails: $(body | jq -r '.[0].errorMessage? // empty' 2>/dev/null | head -c 120)"
        fi
    done
    return "$rc"
}

# ─── main ─────────────────────────────────────────────────────────────────────
main() {
    local mode=apply
    case "${1:-}" in
        "")        ;;
        --check)   mode=check ;;
        -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)         echo "usage: ${0##*/} [--check]" >&2; exit 2 ;;
    esac

    local k missing=()
    for k in PROWLARR_API_KEY PROWLARR_USER PROWLARR_PASS; do [[ -n "${!k}" ]] || missing+=("$k"); done
    if [[ ${#missing[@]} -gt 0 ]]; then
        echo "Set ${missing[*]} in $REPO/.env." >&2
        exit 3
    fi

    BODY="$(mktemp)"; trap 'rm -f "$BODY"' EXIT

    log "Prowlarr at $PROWLARR_URL ($mode)"
    if ! wait_ready; then
        log "  FAIL  not answering with PROWLARR_API_KEY (HTTP $HTTP) — is it running, and started with this key?"
        exit 3
    fi
    log "  API up: $(body | jq -r .version)"

    if [[ "$mode" == apply ]]; then
        apply_host && apply_flare && apply_indexers && apply_applications || exit 1
    fi

    log "Read-back:"
    if verify; then
        log "No drift."
        exit 0
    fi
    [[ "$mode" == check ]] && log "To apply: npm run prowlarr:configure"
    exit 1
}

[[ "${PROWLARR_CONFIGURE_LIB:-0}" == "1" ]] || main "$@"
