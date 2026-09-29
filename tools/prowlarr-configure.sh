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

env_get() {
    [[ -f "$REPO/.env" ]] || return 0
    sed -n "s/^$1=//p" "$REPO/.env" | tail -n1
}

PROWLARR_URL="${PROWLARR_URL:-http://127.0.0.1:9696}"
PROWLARR_API_KEY="${PROWLARR_API_KEY:-$(env_get PROWLARR_API_KEY)}"
PROWLARR_USER="${PROWLARR_USER:-$(env_get PROWLARR_USER)}"
PROWLARR_PASS="${PROWLARR_PASS:-$(env_get PROWLARR_PASS)}"
FLARESOLVERR_URL="${FLARESOLVERR_URL:-http://flaresolverr:8191/}"
# Adding or testing an indexer makes Prowlarr fetch the site first; through
# FlareSolverr that alone is ~15-20 s, and a slow tracker adds to it.
PROWLARR_TIMEOUT="${PROWLARR_TIMEOUT:-120}"
PROWLARR_WAIT="${PROWLARR_WAIT:-90}"

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

lan_ips() {
    local ip
    for ip in $(hostname -I 2>/dev/null); do
        [[ "$ip" == *:* ]] && continue
        [[ "$ip" == 127.* ]] && continue
        [[ "$ip" =~ ^172\.(1[6-9]|2[0-9]|3[01])\. ]] && continue
        printf '%s\n' "$ip"
    done
}

# Required by Prowlarr whenever auth is not required for local addresses.
#   prowlarr   — Radarr/Sonarr on the arr network (Phase 4)
#   127.0.0.1  — this script
allowed_hosts() {
    local h=(prowlarr localhost 127.0.0.1 "$(hostname)")
    mapfile -t -O "${#h[@]}" h < <(lan_ips)
    local IFS=','
    printf '%s' "${h[*]}"
}

# The host-config keys this script owns; everything else is left as Prowlarr has it.
want_host() {
    jq -cn --arg user "$PROWLARR_USER" --arg hosts "$(allowed_hosts)" '{
        username:               $user,
        authenticationMethod:   "forms",
        authenticationRequired: "disabledForLocalAddresses",
        allowedHosts:           $hosts
    }'
}

# ─── API ──────────────────────────────────────────────────────────────────────
BODY=""
HTTP=""

log() { printf '%s\n' "$*"; }

# Sets $HTTP, leaves the response in $BODY. Never inside $(...) or at the end
# of a pipe (subshells lose $HTTP); feed JSON with < <(...) — it is read from
# stdin with -d @- whenever a method sends a body.
api() { # METHOD path
    local method="$1" path="$2" data=()
    [[ "$method" == POST || "$method" == PUT ]] && data=(-H 'Content-Type: application/json' -d @-)
    HTTP="$(curl -s --max-time "$PROWLARR_TIMEOUT" -X "$method" -o "$BODY" -w '%{http_code}' \
        -H "X-Api-Key: $PROWLARR_API_KEY" "${data[@]}" "$PROWLARR_URL$path")" || HTTP=000
    [[ "$HTTP" == 2* ]]
}
body() { cat "$BODY" 2>/dev/null; }

get() { api GET "$1" </dev/null; }

wait_ready() {
    local deadline=$((SECONDS + PROWLARR_WAIT))
    until get /api/v1/system/status; do
        [[ "$HTTP" == 401 ]] && return 1        # up, but the key is wrong: waiting will not help
        (( SECONDS < deadline )) || return 1
        sleep 3
    done
}

# 0 when the forms login accepts PROWLARR_USER/PASS. Success redirects to the
# return URL; failure to /login?…loginFailed=true — both are 302.
login_ok() {
    local to
    to="$(curl -s --max-time "$PROWLARR_TIMEOUT" -o /dev/null -w '%{redirect_url}' \
        --data-urlencode "username=$PROWLARR_USER" --data-urlencode "password@-" \
        "$PROWLARR_URL/login?returnUrl=/" < <(printf '%s' "$PROWLARR_PASS"))" || return 1
    login_redirect_ok "$to"
}
login_redirect_ok() { [[ -n "$1" && "$1" != *loginFailed* ]]; }

# ─── pure helpers (tests/prowlarr-configure.test.sh) ──────────────────────────

# The keys of $want that differ in $got; empty when none do.
host_drift() { # got want
    jq -r --argjson want "$2" '. as $got | $want | to_entries[]
        | select($got[.key] != .value) | .key' <<<"$1"
}

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
apply_host() {
    local cur want drift id
    get /api/v1/config/host || { log "  FAIL  read host config (HTTP $HTTP)"; return 1; }
    cur="$(body)"; want="$(want_host)"; drift="$(host_drift "$cur" "$want")"
    if [[ -z "$drift" ]] && login_ok; then
        log "  login and allowed hosts already set"
        return 0
    fi
    id="$(jq -r .id <<<"$cur")"
    api PUT "/api/v1/config/host/$id" < <(P="$PROWLARR_PASS" jq -c --argjson w "$want" \
        '. + $w + {password: env.P, passwordConfirmation: env.P}' <<<"$cur") \
        || { log "  FAIL  host config (HTTP $HTTP): $(body | jq -r '.[0].errorMessage? // empty' 2>/dev/null)"; return 1; }
    log "  login and allowed hosts set"
}

FLARE_ID=""
apply_flare() {
    local schema cur id
    # Prowlarr answers an existing label with that tag, so this is idempotent.
    api POST /api/v1/tag < <(jq -cn --arg l "$FLARE_TAG" '{label: $l}') \
        || { log "  FAIL  tag (HTTP $HTTP)"; return 1; }
    FLARE_ID="$(body | jq -r .id)"

    get /api/v1/indexerProxy || { log "  FAIL  read proxies (HTTP $HTTP)"; return 1; }
    cur="$(body | jq -c '[.[] | select(.implementation == "FlareSolverr")][0] // empty')"
    if [[ -z "$cur" ]]; then
        get /api/v1/indexerProxy/schema || { log "  FAIL  proxy schema (HTTP $HTTP)"; return 1; }
        schema="$(body | jq -c '.[] | select(.implementation == "FlareSolverr")')"
        api POST /api/v1/indexerProxy < <(jq -c --arg h "$FLARESOLVERR_URL" --argjson t "$FLARE_ID" \
            '.name = "FlareSolverr" | .tags = [$t] | (.fields[] | select(.name == "host") | .value) = $h' <<<"$schema") \
            || { log "  FAIL  add FlareSolverr proxy (HTTP $HTTP): $(body | jq -r '.[0].errorMessage? // empty' 2>/dev/null)"; return 1; }
        log "  FlareSolverr proxy added ($FLARESOLVERR_URL, tag $FLARE_TAG)"
    elif proxy_differs "$cur" "$FLARESOLVERR_URL" "$FLARE_ID"; then
        id="$(jq -r .id <<<"$cur")"
        api PUT "/api/v1/indexerProxy/$id" < <(jq -c --arg h "$FLARESOLVERR_URL" --argjson t "$FLARE_ID" \
            '.tags = [$t] | (.fields[] | select(.name == "host") | .value) = $h' <<<"$cur") \
            || { log "  FAIL  update FlareSolverr proxy (HTTP $HTTP)"; return 1; }
        log "  FlareSolverr proxy updated"
    else
        log "  FlareSolverr proxy already set"
    fi
}

tags_for() { [[ "$1" == flare ]] && printf '[%s]' "$FLARE_ID" || printf '[]'; }

apply_indexers() {
    local schema existing profile entry def route tags cur
    get /api/v1/indexer/schema || { log "  FAIL  indexer schema (HTTP $HTTP)"; return 1; }
    schema="$(body)"
    get /api/v1/indexer || { log "  FAIL  read indexers (HTTP $HTTP)"; return 1; }
    existing="$(body)"
    get /api/v1/appprofile || { log "  FAIL  app profiles (HTTP $HTTP)"; return 1; }
    profile="$(body | jq -r '.[0].id')"

    for entry in "${INDEXERS[@]}"; do
        def="${entry%%|*}"; route="${entry#*|}"; tags="$(tags_for "$route")"
        cur="$(jq -c --arg d "$def" '[.[] | select(.definitionName == $d)][0] // empty' <<<"$existing")"
        if [[ -z "$cur" ]]; then
            local s
            s="$(jq -c --arg d "$def" '.[] | select(.definitionName == $d)' <<<"$schema")"
            [[ -n "$s" ]] || { log "  FAIL  $def: no such indexer definition in Prowlarr"; return 1; }
            api POST /api/v1/indexer < <(indexer_new "$s" "$profile" "$tags") \
                || { log "  FAIL  add $def (HTTP $HTTP): $(body | jq -r '.[0].errorMessage? // empty' 2>/dev/null)"; return 1; }
            log "  $def added ($route)"
        elif indexer_differs "$cur" "$tags"; then
            api PUT "/api/v1/indexer/$(jq -r .id <<<"$cur")" < <(indexer_fix "$cur" "$tags") \
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
    local rc=0 cur drift proxy existing entry def route tags ix name
    get /api/v1/config/host || { log "  FAIL  read host config (HTTP $HTTP)"; return 1; }
    cur="$(body)"; drift="$(host_drift "$cur" "$(want_host)")"
    if [[ -z "$drift" ]]; then log "  ok       host: forms login, not required locally; allowed hosts $(jq -r .allowedHosts <<<"$cur")"
    else log "  DRIFT    host: $(tr '\n' ' ' <<<"$drift")"; rc=1; fi
    if login_ok; then log "  ok       login as $PROWLARR_USER"
    else log "  DRIFT    login as $PROWLARR_USER is refused"; rc=1; fi

    get /api/v1/tag || { log "  FAIL  read tags"; return 1; }
    FLARE_ID="$(body | jq -r --arg l "$FLARE_TAG" '[.[] | select(.label == $l)][0].id // empty')"
    get /api/v1/indexerProxy || { log "  FAIL  read proxies"; return 1; }
    proxy="$(body | jq -c '[.[] | select(.implementation == "FlareSolverr")][0] // empty')"
    if [[ -n "$FLARE_ID" && -n "$proxy" ]] && ! proxy_differs "$proxy" "$FLARESOLVERR_URL" "$FLARE_ID"; then
        if api POST /api/v1/indexerProxy/test < <(printf '%s' "$proxy"); then
            log "  ok       FlareSolverr proxy $FLARESOLVERR_URL answers"
        else
            log "  WARN     FlareSolverr proxy set, but its test fails (HTTP $HTTP)"
        fi
    else
        log "  DRIFT    FlareSolverr proxy or '$FLARE_TAG' tag missing or changed"; rc=1
    fi

    get /api/v1/indexer || { log "  FAIL  read indexers"; return 1; }
    existing="$(body)"
    for entry in "${INDEXERS[@]}"; do
        def="${entry%%|*}"; route="${entry#*|}"; tags="$(tags_for "$route")"
        ix="$(jq -c --arg d "$def" '[.[] | select(.definitionName == $d)][0] // empty' <<<"$existing")"
        if [[ -z "$ix" ]]; then log "  DRIFT    $def missing"; rc=1; continue; fi
        name="$(jq -r .name <<<"$ix")"
        if indexer_differs "$ix" "$tags"; then log "  DRIFT    $name disabled or tags changed (want $route)"; rc=1; continue; fi
        if api POST /api/v1/indexer/test < <(printf '%s' "$ix"); then
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
        apply_host && apply_flare && apply_indexers || exit 1
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
