#!/usr/bin/env bash
# servarr.sh — the API plumbing shared by the Servarr configure scripts
# (prowlarr-configure.sh, arr-configure.sh). Sourced, never run.
#
# Prowlarr, Radarr and Sonarr are one code base underneath: the same API-key
# header, the same forms login, the same /config/host object. Only the API
# version differs (Prowlarr v1, Radarr/Sonarr v3). A caller sets:
#
#   REPO         the repo root, for env_get
#   SVC_NAME     compose service name (prowlarr, radarr, sonarr) — also the
#                hostname other containers reach it by, so it goes into
#                allowedHosts
#   SVC_URL      e.g. http://127.0.0.1:9696
#   SVC_KEY      API key
#   SVC_API      v1 or v3
#   SVC_USER / SVC_PASS      WebUI login
#   SVC_TIMEOUT / SVC_WAIT   seconds per request / for the API to come up
#
# and makes BODY a temp file before the first api() call.

# Reads one KEY from .env without sourcing it.
env_get() {
    [[ -f "$REPO/.env" ]] || return 0
    sed -n "s/^$1=//p" "$REPO/.env" | tail -n1
}

log() { printf '%s\n' "$*"; }

# The host's own IPv4 addresses, minus loopback and Docker's bridges.
lan_ips() {
    local ip
    for ip in $(hostname -I 2>/dev/null); do
        [[ "$ip" == *:* ]] && continue
        [[ "$ip" == 127.* ]] && continue
        [[ "$ip" =~ ^172\.(1[6-9]|2[0-9]|3[01])\. ]] && continue
        printf '%s\n' "$ip"
    done
}

# Required whenever auth is not required for local addresses.
#   <service>  — other containers on the arr network reach it by this name
#   127.0.0.1  — these scripts
#   ALLOWED_HOSTS_EXTRA — comma-separated, empty by default; only for
#   rehearsing against throwaway containers, whose names differ.
allowed_hosts() { # [service]
    local h=("${1:-$SVC_NAME}" localhost 127.0.0.1 "$(hostname)") x
    mapfile -t -O "${#h[@]}" h < <(lan_ips)
    for x in ${ALLOWED_HOSTS_EXTRA:+${ALLOWED_HOSTS_EXTRA//,/ }}; do h+=("$x"); done
    local IFS=','
    printf '%s' "${h[*]}"
}

# The host-config keys these scripts own; everything else is left as the app has it.
want_host() {
    jq -cn --arg user "$SVC_USER" --arg hosts "$(allowed_hosts)" '{
        username:               $user,
        authenticationMethod:   "forms",
        authenticationRequired: "disabledForLocalAddresses",
        allowedHosts:           $hosts
    }'
}

# The keys of $want that differ in $got; empty when none do.
host_drift() { # got want
    jq -r --argjson want "$2" '. as $got | $want | to_entries[]
        | select($got[.key] != .value) | .key' <<<"$1"
}

# ─── schema-based resources (download clients, notifications, applications) ───
# Set .fields[].value from a {name: value} map; fields not in the map are kept.
fields_set() { # resource-json map-json
    # .name is bound first: inside `$m | has(...)` a bare .name would read the map.
    jq -c --argjson m "$2" '.fields |= map(.name as $n | if $m | has($n) then .value = $m[$n] else . end)' <<<"$1"
}

# Names in the map whose field value differs; empty when none do.
fields_drift() { # resource-json map-json
    jq -r --argjson m "$2" '[.fields[] | {(.name): .value}] | add // {} | . as $got
        | $m | to_entries[] | select($got[.key] != .value) | .key' <<<"$1"
}

# A whole resource from a schema entry (or an existing one) with our values in.
resource_want() { # base-json top-json fields-json
    fields_set "$(jq -c --argjson t "$2" '. + $t' <<<"$1")" "$3"
}

# Drift in a resource: top-level keys and field values, secrets excluded
# (both apps mask them on read).
resource_drift() { # resource-json top-json fields-json
    { host_drift "$1" "$2"; fields_drift "$1" "$3"; } | sed '/^$/d'
}

# ─── API ──────────────────────────────────────────────────────────────────────
BODY="${BODY:-}"
HTTP=""

# Sets $HTTP, leaves the response in $BODY. Never inside $(...) or at the end
# of a pipe (subshells lose $HTTP); feed JSON with < <(...) — it is read from
# stdin with -d @- whenever a method sends a body. Paths are relative to
# /api/$SVC_API.
api() { # METHOD path
    local method="$1" path="$2" data=()
    [[ "$method" == POST || "$method" == PUT ]] && data=(-H 'Content-Type: application/json' -d @-)
    HTTP="$(curl -s --max-time "$SVC_TIMEOUT" -X "$method" -o "$BODY" -w '%{http_code}' \
        -H "X-Api-Key: $SVC_KEY" "${data[@]}" "$SVC_URL/api/$SVC_API$path")" || HTTP=000
    [[ "$HTTP" == 2* ]]
}
body() { cat "$BODY" 2>/dev/null; }
get() { api GET "$1" </dev/null; }

# The first error message of a failed write, for the log.
api_error() { body | jq -r '.[0].errorMessage? // .message? // empty' 2>/dev/null | head -c 160; }

wait_ready() {
    local deadline=$((SECONDS + SVC_WAIT))
    until get /system/status; do
        [[ "$HTTP" == 401 ]] && return 1        # up, but the key is wrong: waiting will not help
        (( SECONDS < deadline )) || return 1
        sleep 3
    done
}

# 0 when the forms login accepts SVC_USER/SVC_PASS. Success redirects to the
# return URL; failure to /login?…loginFailed=true — both are 302.
login_ok() {
    local to
    to="$(curl -s --max-time "$SVC_TIMEOUT" -o /dev/null -w '%{redirect_url}' \
        --data-urlencode "username=$SVC_USER" --data-urlencode "password@-" \
        "$SVC_URL/login?returnUrl=/" < <(printf '%s' "$SVC_PASS"))" || return 1
    login_redirect_ok "$to"
}
login_redirect_ok() { [[ -n "$1" && "$1" != *loginFailed* ]]; }

# ─── login and allowed hosts ──────────────────────────────────────────────────
# allowedHosts must be set before the app will save a login in
# "not required for local addresses" mode (a 400 otherwise).
apply_host() {
    local cur want drift id
    get /config/host || { log "  FAIL  read host config (HTTP $HTTP)"; return 1; }
    cur="$(body)"; want="$(want_host)"; drift="$(host_drift "$cur" "$want")"
    if [[ -z "$drift" ]] && login_ok; then
        log "  login and allowed hosts already set"
        return 0
    fi
    id="$(jq -r .id <<<"$cur")"
    api PUT "/config/host/$id" < <(P="$SVC_PASS" jq -c --argjson w "$want" \
        '. + $w + {password: env.P, passwordConfirmation: env.P}' <<<"$cur") \
        || { log "  FAIL  host config (HTTP $HTTP): $(api_error)"; return 1; }
    log "  login and allowed hosts set"

    # The host filter reads allowedHosts at startup only: until a restart the
    # app keeps enforcing the previous list (on a fresh install, none). A
    # restart now makes the list that was just verified the one in force —
    # otherwise Prowlarr <-> Radarr/Sonarr calls fail with "Invalid Hostname"
    # after the next unrelated restart, far from this change.
    if grep -qx allowedHosts <<<"$drift"; then
        log "  restarting ${SVC_NAME} so the new allowed hosts take effect"
        api POST /system/restart </dev/null || true
        sleep 5
        wait_ready || { log "  FAIL  ${SVC_NAME} did not come back after the restart"; return 1; }
    fi
}

verify_host() {
    local rc=0 cur drift
    get /config/host || { log "  FAIL  read host config (HTTP $HTTP)"; return 1; }
    cur="$(body)"; drift="$(host_drift "$cur" "$(want_host)")"
    if [[ -z "$drift" ]]; then log "  ok       host: forms login, not required locally; allowed hosts $(jq -r .allowedHosts <<<"$cur")"
    else log "  DRIFT    host: $(tr '\n' ' ' <<<"$drift")"; rc=1; fi
    if login_ok; then log "  ok       login as $SVC_USER"
    else log "  DRIFT    login as $SVC_USER is refused"; rc=1; fi
    return "$rc"
}

# ─── schema-based resources: apply and verify ────────────────────────────────
# A schema-based resource (download client, notification, application), by implementation.
# The secret goes in on every write, since both apps mask it on read.
apply_resource() { # label endpoint implementation top-json fields-json secret-field secret
    local label="$1" ep="$2" impl="$3" top="$4" fields="$5" sname="$6" secret="$7" cur base drift
    get "/$ep" || { log "  FAIL  read $label (HTTP $HTTP)"; return 1; }
    cur="$(body | jq -c --arg i "$impl" '[.[] | select(.implementation == $i)][0] // empty')"
    local with_secret
    with_secret="$(jq -c --arg n "$sname" --arg s "$secret" '. + {($n): $s}' <<<"$fields")"
    if [[ -z "$cur" ]]; then
        get "/$ep/schema" || { log "  FAIL  $label schema (HTTP $HTTP)"; return 1; }
        base="$(body | jq -c --arg i "$impl" '.[] | select(.implementation == $i)')"
        api POST "/$ep" < <(resource_want "$base" "$top" "$with_secret") \
            || { log "  FAIL  add $label (HTTP $HTTP): $(api_error)"; return 1; }
        log "  $label added"
        return 0
    fi
    drift="$(resource_drift "$cur" "$top" "$fields")"
    if [[ -z "$drift" ]]; then log "  $label already set"; return 0; fi
    api PUT "/$ep/$(jq -r .id <<<"$cur")" < <(resource_want "$cur" "$top" "$with_secret") \
        || { log "  FAIL  update $label (HTTP $HTTP): $(api_error)"; return 1; }
    log "  $label updated ($(tr '\n' ' ' <<<"$drift" | sed 's/ $//'))"
}

verify_resource() { # label endpoint implementation top-json fields-json
    local cur drift
    get "/$2" || { log "  FAIL  read $1 (HTTP $HTTP)"; return 1; }
    cur="$(body | jq -c --arg i "$3" '[.[] | select(.implementation == $i)][0] // empty')"
    if [[ -z "$cur" ]]; then log "  DRIFT    $1 missing"; return 1; fi
    drift="$(resource_drift "$cur" "$4" "$5")"
    if [[ -n "$drift" ]]; then log "  DRIFT    $1: $(tr '\n' ' ' <<<"$drift")"; return 1; fi
    # Tests the stored settings, secret included — the one check of the password.
    if api POST "/$2/test" < <(printf '%s' "$cur"); then
        log "  ok       $1 — test passes"
    else
        log "  FAILING  $1 — test fails: $(api_error)"
    fi
}
