#!/usr/bin/env bash
# jobs/stack-status/stack-status.sh — gather the stack's status and recent logs
# for the docs site's front page, as JSON files nginx serves at /live/.
#
#   jobs/stack-status/stack-status.sh            fast run: status.json and logs.json
#   jobs/stack-status/stack-status.sh --drift    settings drift: drift.json (slow)
#   jobs/stack-status/stack-status.sh --stdout   print the documents; writes nothing
#   jobs/stack-status/stack-status.sh --audit    redaction counts only; writes nothing
#
# Normally run by stack-status.timer (every 2 min) and stack-status-drift.timer
# (hourly) beside it, or as `task stack-status:run` / `:dry` / `:drift` / `:audit`.
#
# The files are readable by anyone on the LAN (no login, like the apps
# themselves), so every string goes through redact() and then a leak guard
# before anything is written. Secrets from .env (by key name; a key nobody
# classified counts as secret), Seerr's and Bazarr's API keys and Plex's token
# are masked literally, and token/key/password shapes by pattern. If a secret is
# still in a document, nothing is published.
#
# Exit: 0 written (a degraded stack is still 0: a failure means the checker
# broke), or skipped because another run holds the lock · 1 cannot write, or the
# leak guard refused · 2 usage · 3 preflight (no jq, docker, curl or .env).

set -uo pipefail

REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"
# shellcheck source=SCRIPTDIR/../../stack/lib/servarr.sh
. "$REPO/stack/lib/servarr.sh" || { echo "cannot load stack/lib/servarr.sh" >&2; exit 3; }

# ─── what is checked (stack-status.test.sh pins these against the repo) ──────
# Every apps/<app>, in that order. recyclarr runs on demand: no container to check.
STATUS_APPS=(bazarr decluttarr docs flaresolverr plex prowlarr qbittorrent radarr recyclarr seerr sonarr)
ON_DEMAND_APPS=(recyclarr)
# Host ports the probes use: the published ones in apps/<app>/compose.yaml
# (plex runs on the host network).
declare -A APP_PORT=([bazarr]=6767 [docs]=8088 [plex]=32400 [prowlarr]=9696
                     [qbittorrent]=8081 [radarr]=7878 [seerr]=5055 [sonarr]=8989)
FLARESOLVERR_PORT=8191   # on the arr network only, reached at the container's IP
PLEX_IDENTITY=f3860770aca2ec05cf2566b02ff81a83d4dbb157
# The jobs whose journal is shown, and the timers whose state is.
LOG_UNITS=(lan-address arr-reclaim pms-update arr-fallback-search stack-status stack-status-drift)
TIMERS=(pms-update arr-fallback-search lan-address stack-status stack-status-drift)
# The apps with a configure.sh, as Taskfile.yml's CONFIGURED.
DRIFT_APPS=(qbittorrent prowlarr radarr sonarr seerr bazarr)
# .env keys that are never secret. User names are listed here on purpose: the
# box's user is one of them, and masking it would blank every /home path. Any
# other key is masked: by name when it matches SECRET_KEY_RE, and, fail-safe,
# when nobody classified it (8+ characters). The test fails on an
# .env.example key in neither group.
PUBLIC_ENV_KEYS=(PUID PGID TZ APPDATA UPDATE_SERVICES UPDATE_HEALTH_WAIT DECLUTTARR_TEST_RUN
                 QBT_ARR_USER PROWLARR_USER ARR_USER OPENSUBTITLES_USER)
SECRET_KEY_RE='_(KEY|PASS|PASSWORD|TOKEN|SECRET|CLAIM)$'

DISK_PATH="${STACK_STATUS_DISK:-/mnt/data}"
DISK_WARN=95             # % used; /mnt/data runs at ~90%
STALE_AFTER=360          # s: the page marks everything stale past this (3 missed runs)
DRIFT_STALE=10800        # s: an hourly drift result older than this is itself a problem
RESTART_WINDOW=900       # s: a Docker restart this recent marks the app degraded
QBT_BACKOFF=3600         # s: after a refused login, so qBittorrent's IP ban never trips
LOG_SCAN=300             # lines read per source
LOG_KEEP=50              # lines kept per view
LINE_MAX=500             # characters per line
T_HTTP="${STACK_STATUS_T_HTTP:-5}"    # s per HTTP request
T_CMD=10                 # s per docker/systemctl/journalctl call
T_CONFIGURE=600          # s per configure.sh --check in the drift run

REDACTED='‹redacted›'

# ─── commands, as functions so the test can stand in for them ────────────────
run_docker()     { timeout "$T_CMD" docker "$@"; }
run_systemctl()  { timeout "$T_CMD" systemctl "$@"; }
run_journalctl() { timeout "$T_CMD" journalctl "$@"; }
run_df()         { timeout "$T_CMD" df "$@"; }
run_ip()         { timeout "$T_CMD" ip "$@"; }
now_epoch()      { date +%s; }

# url out [header-file] → "code seconds"; code 000 when nothing answered.
fetch() {
    local args=(-s -o "$2" -w '%{http_code} %{time_total}' --max-time "$T_HTTP")
    [[ -n "${3:-}" ]] && args+=(-H "@$3")
    curl "${args[@]}" "$1" 2>/dev/null || true
}

# ─── secrets ─────────────────────────────────────────────────────────────────
env_keys() { sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' <<<"$1"; }
env_value() { # env-text key
    sed -n "s/^$2=//p" <<<"$1" | tail -n1 | sed 's/^"\(.*\)"$/\1/; s/^'\''\(.*\)'\''$/\1/'
}
is_public_key() { local k; for k in "${PUBLIC_ENV_KEYS[@]}"; do [[ "$1" == "$k" ]] && return 0; done; return 1; }
is_named_secret() { [[ "$1" =~ $SECRET_KEY_RE ]]; }
# Keys neither named secret nor listed public: masked anyway, and reported.
unclassified_keys() { # env-text
    local k; while read -r k; do
        [[ -n "$k" ]] && ! is_named_secret "$k" && ! is_public_key "$k" && printf '%s\n' "$k"
    done < <(env_keys "$1")
}
# The literal values to mask, one per line: named secrets of 4+ characters,
# unclassified values of 8+ (fail-safe, but "true" or "1000" stay readable).
env_secret_values() { # env-text
    local k v; while read -r k; do
        [[ -n "$k" ]] || continue
        v="$(env_value "$1" "$k")"
        if is_named_secret "$k"; then (( ${#v} >= 4 )) && printf '%s\n' "$v"
        elif ! is_public_key "$k"; then (( ${#v} >= 8 )) && printf '%s\n' "$v"
        fi
    done < <(env_keys "$1")
}
# newline list → JSON array: unique, with each value's URL-encoded form, longest first.
secrets_json() {
    jq -R -s -c 'split("\n") | map(select(length >= 4)) | (. + map(@uri)) | unique | sort_by(-length)'
}
# Seerr's and Bazarr's API keys, read by their configure scripts' own helpers,
# in a child process so sourcing them changes nothing here.
seerr_api_key() {
    SEERR_CONFIGURE_LIB=1 bash -c '. "$1/apps/seerr/configure.sh" >/dev/null 2>&1 && seerr_key "$2"' \
        _ "$REPO" "$APPDATA/seerr/settings.json" 2>/dev/null
}
bazarr_api_key() {
    BAZARR_CONFIGURE_LIB=1 bash -c '. "$1/apps/bazarr/configure.sh" >/dev/null 2>&1 && bazarr_key "$2"' \
        _ "$REPO" "$APPDATA/bazarr/config/config.yaml" 2>/dev/null
}
plex_online_token() {
    sed -n 's/.*PlexOnlineToken="\([^"]*\)".*/\1/p' \
        "$APPDATA/plex/Library/Application Support/Plex Media Server/Preferences.xml" 2>/dev/null | head -1
}
# Every secret this box has, as a JSON array in $1 and plain lines in $2 (grep -F).
load_secrets() { # json-out lines-out
    local env_text="" list="$WORK/secrets.list"
    [[ -f "$REPO/.env" ]] && env_text="$(cat "$REPO/.env")"
    { env_secret_values "$env_text"; seerr_api_key; echo; bazarr_api_key; echo; plex_online_token; } >"$list"
    secrets_json <"$list" >"$1"
    rm -f "$list"
    jq -r '.[]' "$1" >"$2"
}

# The masking filter: literal secrets first, then the shapes that carry one.
# shellcheck disable=SC2016  # jq program, not shell
JQ_REDACT='
def mask($s):
  (reduce $s[] as $x (.; if index($x) then split($x) | join($r) else . end))
  | gsub("(?<k>x-plex-token[=:]\\s*)[^&\\s\"'\''<>]+"; "\(.k)\($r)"; "i")
  | gsub("(?<k>plexonlinetoken=\")[^\"]*"; "\(.k)\($r)"; "i")
  | gsub("(?<k>(api[_-]?key|access[_-]?token|token|passw(or)?d|pwd|secret)[\"'\'']?\\s*[:=]\\s*[\"'\'']?)[^&\\s\"'\'',;<>]+"; "\(.k)\($r)"; "i")
  | gsub("(?<k>authorization:\\s*)\\S+(\\s+[^\\s,;]+)?"; "\(.k)\($r)"; "i")
  | gsub("(?<k>temporary password is provided for this session:\\s*)\\S+"; "\(.k)\($r)"; "i")
  | gsub("(?<k>://)[^/\\s:@]+:[^/\\s@]+@"; "\(.k)\($r)@")
  | gsub("(?<k>\\bSID=)[^;\\s]+"; "\(.k)\($r)")
  | gsub("(?<k>\\bcookie:\\s*).+"; "\(.k)\($r)"; "i");
walk(if type == "string" then mask($secrets) else . end)'

redact() { # secrets-json-file < doc → doc
    jq -c --slurpfile s "$1" --arg r "$REDACTED" "def _s: \$s[0]; ${JQ_REDACT//\$secrets/_s}"
}
# How many secrets are still in a document (0 = safe to publish).
leaks() { # doc-file secrets-lines-file
    [[ -s "$2" ]] || { echo 0; return; }
    grep -F -o -f "$2" "$1" 2>/dev/null | wc -l | tr -d ' '
}

# ─── containers ──────────────────────────────────────────────────────────────
containers_json() { # docker-inspect-json → {name: {...}}
    jq -c 'map({key: (.Name | ltrimstr("/")), value: {
        state: .State.Status, running: .State.Running, restarting: .State.Restarting,
        restartCount: .RestartCount, startedAt: .State.StartedAt,
        health: (.State.Health.Status // null), exitCode: .State.ExitCode,
        ips: [.NetworkSettings.Networks[]?.IPAddress | select(. != "")]}}) | from_entries' \
        <<<"${1:-[]}" 2>/dev/null || echo '{}'
}

# ─── app probes: each prints {http, ms, version, down, reasons, facts} ───────
# A reason is {level: down|degraded|notice, text}.

# code seconds health-body status-body port → probe JSON (Radarr, Sonarr, Prowlarr)
servarr_probe() {
    jq -nc --arg code "$1" --arg t "$2" --arg h "$3" --arg s "$4" --arg port "$5" '
        ($code | tonumber? // 0) as $c | (try ($h | fromjson) catch null) as $hj
        | (try ($s | fromjson) catch null) as $sj
        | {http: $c, ms: (($t | tonumber? // 0) * 1000 | floor), version: ($sj.version? // null),
           down: (if $c == 0 then "not answering on :\($port)" elif $c >= 500 then "HTTP \($c)" else null end),
           reasons: (if $c == 401 then [{level: "degraded", text: "API key refused (HTTP 401): health unknown"}]
                     elif ($hj | type) == "array" then
                        [$hj[] | select(.type != "ok")
                         | {level: (if .type == "notice" then "notice" else "degraded" end),
                            text: "\(.source // "health"): \(.message // "")"}]
                     else [] end),
           facts: {}}'
}
probe_servarr() { # app api-version env-key
    local app=$1 ver=$2 key hdr="$WORK/h.$1" code t scode
    key="$(env_get "$3")"
    printf 'X-Api-Key: %s' "$key" >"$hdr"
    read -r code t < <(fetch "http://127.0.0.1:${APP_PORT[$app]}/api/$ver/health" "$WORK/$app.health" "$hdr")
    read -r scode _ < <(fetch "http://127.0.0.1:${APP_PORT[$app]}/api/$ver/system/status" "$WORK/$app.status" "$hdr")
    : "$scode"
    servarr_probe "${code:-0}" "${t:-0}" "$(cat "$WORK/$app.health" 2>/dev/null)" \
        "$(cat "$WORK/$app.status" 2>/dev/null)" "${APP_PORT[$app]}"
}

bazarr_probe() { # code seconds health-body status-body
    jq -nc --arg code "$1" --arg t "$2" --arg h "$3" --arg s "$4" '
        ($code | tonumber? // 0) as $c | (try ($h | fromjson) catch null) as $hj
        | (try ($s | fromjson) catch null) as $sj
        | {http: $c, ms: (($t | tonumber? // 0) * 1000 | floor), version: ($sj.data.bazarr_version? // null),
           down: (if $c == 0 then "not answering on :6767" elif $c >= 500 then "HTTP \($c)" else null end),
           reasons: (if $c == 401 or $c == 403 then [{level: "degraded", text: "API key refused (HTTP \($c)): health unknown"}]
                     else [($hj.data? // [])[] | {level: "degraded", text: "\(.object // "health"): \(.issue // .)"}] end),
           facts: {}}'
}
probe_bazarr() {
    local key hdr="$WORK/h.bazarr" code t
    key="$(bazarr_api_key)"
    printf 'X-API-KEY: %s' "$key" >"$hdr"
    read -r code t < <(fetch "http://127.0.0.1:${APP_PORT[bazarr]}/api/system/health" "$WORK/bazarr.health" "$hdr")
    fetch "http://127.0.0.1:${APP_PORT[bazarr]}/api/system/status" "$WORK/bazarr.status" "$hdr" >/dev/null
    bazarr_probe "${code:-0}" "${t:-0}" "$(cat "$WORK/bazarr.health" 2>/dev/null)" "$(cat "$WORK/bazarr.status" 2>/dev/null)"
}

seerr_probe() { # code seconds status-body
    jq -nc --arg code "$1" --arg t "$2" --arg s "$3" '
        ($code | tonumber? // 0) as $c | (try ($s | fromjson) catch null) as $sj
        | {http: $c, ms: (($t | tonumber? // 0) * 1000 | floor), version: ($sj.version? // null),
           down: (if $c == 0 then "not answering on :5055" elif $c >= 500 then "HTTP \($c)" else null end),
           reasons: (if $sj.restartRequired? == true then [{level: "degraded", text: "restart required to apply settings"}] else [] end),
           facts: {}}'
}
probe_seerr() {
    local code t
    read -r code t < <(fetch "http://127.0.0.1:${APP_PORT[seerr]}/api/v1/status" "$WORK/seerr.status")
    seerr_probe "${code:-0}" "${t:-0}" "$(cat "$WORK/seerr.status" 2>/dev/null)"
}

plex_probe() { # code seconds identity-xml
    local id ver
    id="$(sed -n 's/.*machineIdentifier="\([^"]*\)".*/\1/p' <<<"$3" | head -1)"
    ver="$(sed -n 's/.* version="\([^"]*\)".*/\1/p' <<<"$3" | head -1)"
    jq -nc --arg code "$1" --arg t "$2" --arg id "$id" --arg ver "$ver" --arg want "$PLEX_IDENTITY" '
        ($code | tonumber? // 0) as $c
        | {http: $c, ms: (($t | tonumber? // 0) * 1000 | floor), version: (if $ver == "" then null else $ver end),
           down: (if $c == 0 then "not answering on :32400"
                  elif $c >= 500 then "HTTP \($c)"
                  elif $id != $want then "identity \(if $id == "" then "missing" else $id[0:8] + "…" end), expected \($want[0:8])…: a fresh database?"
                  else null end),
           reasons: [], facts: {identity: (if $id == "" then null else $id end)}}'
}
probe_plex() {
    local code t
    read -r code t < <(fetch "http://127.0.0.1:${APP_PORT[plex]}/identity" "$WORK/plex.identity")
    plex_probe "${code:-0}" "${t:-0}" "$(tr -d '\n' <"$WORK/plex.identity" 2>/dev/null)"
}

http_probe() { # code seconds port → reachable or down
    jq -nc --arg code "$1" --arg t "$2" --arg port "$3" '
        ($code | tonumber? // 0) as $c
        | {http: $c, ms: (($t | tonumber? // 0) * 1000 | floor), version: null,
           down: (if $c == 0 then "not answering on :\($port)" elif $c >= 500 then "HTTP \($c)" else null end),
           reasons: [], facts: {}}'
}
probe_docs() {
    local code t
    read -r code t < <(fetch "http://127.0.0.1:${APP_PORT[docs]}/" "$WORK/docs.body")
    http_probe "${code:-0}" "${t:-0}" "${APP_PORT[docs]}"
}
probe_flaresolverr() { # container-ip
    local code t
    [[ -n "$1" ]] || { jq -nc '{http: null, ms: null, version: null, down: null, reasons: [], facts: {}}'; return; }
    read -r code t < <(fetch "http://$1:$FLARESOLVERR_PORT/" "$WORK/flaresolverr.body")
    http_probe "${code:-0}" "${t:-0}" "$FLARESOLVERR_PORT" |
        jq -c --arg b "$(cat "$WORK/flaresolverr.body" 2>/dev/null)" '.version = (try ($b | fromjson | .version) catch null)'
}

# qBittorrent: log in, read the connection state, log out. After one refused
# login, wait QBT_BACKOFF before trying again: five refusals ban the address,
# and from here that is the docker bridge arr-reclaim and the configure scripts use.
qbt_probe() { # login-code login-body info-code info-body version-body backoff-until now
    jq -nc --arg lc "$1" --arg lb "$2" --arg ic "$3" --arg ib "$4" --arg vb "$5" \
           --argjson until "${6:-0}" --argjson now "$7" '
        ($lc | tonumber? // 0) as $l | ($ic | tonumber? // 0) as $i
        | (try ($ib | fromjson) catch null) as $info
        | if $until > $now then
            {http: null, ms: null, version: null, down: null,
             reasons: [{level: "degraded", text: "login refused earlier; next try \($until | strflocaltime("%H:%M"))"}],
             facts: {backoffUntil: $until}}
          elif $l == 0 then {http: 0, ms: null, version: null, down: "not answering on :8081", reasons: [], facts: {}}
          elif $l == 401 or $l == 403 or ($lb | test("Fails")) then
            {http: $l, ms: null, version: null, down: null,
             reasons: [{level: "degraded", text: "login refused (\(if $l == 403 then "banned" else "wrong user or password" end)); next try in 1 h"}],
             facts: {loginRefused: true}}
          else
            {http: $i, ms: null, version: (if $vb == "" then null else $vb end),
             down: (if $i >= 500 then "HTTP \($i)" else null end),
             reasons: (($info.connection_status // null) as $cs
                       | if $cs == "connected" or $cs == null then []
                         else [{level: "degraded", text: "connection \($cs)"}] end),
             facts: {connection: ($info.connection_status // null), dhtNodes: ($info.dht_nodes // null)}}
          end'
}
probe_qbittorrent() {
    local state="$APPDATA/.stack-status.state" until now jar="$WORK/qbt.jar" body="$WORK/qbt.login"
    local lc ic ib vb
    now="$(now_epoch)"
    until="$(jq -r '.qbtBackoffUntil // 0' "$state" 2>/dev/null || echo 0)"
    if (( until > now )); then
        qbt_probe 0 "" 0 "" "" "$until" "$now"; return
    fi
    jq -rn --arg u "$(env_get QBT_ARR_USER)" --arg p "$(env_get QBT_ARR_PASS)" \
        '"username=\($u | @uri)&password=\($p | @uri)"' >"$body"
    lc="$(curl -s -c "$jar" -o "$WORK/qbt.lr" -w '%{http_code}' --max-time "$T_HTTP" \
          --data "@$body" "http://127.0.0.1:${APP_PORT[qbittorrent]}/api/v2/auth/login" 2>/dev/null || true)"
    ic=0; ib=""; vb=""
    # 5.x answers a good login with 204 and no body; older versions with 200 "Ok.".
    if [[ "$lc" == 204 ]] || { [[ "$lc" == 200 ]] && grep -q '^Ok' "$WORK/qbt.lr" 2>/dev/null; }; then
        ic="$(curl -s -b "$jar" -o "$WORK/qbt.info" -w '%{http_code}' --max-time "$T_HTTP" \
              "http://127.0.0.1:${APP_PORT[qbittorrent]}/api/v2/transfer/info" 2>/dev/null || true)"
        ib="$(cat "$WORK/qbt.info" 2>/dev/null)"
        vb="$(curl -s -b "$jar" --max-time "$T_HTTP" "http://127.0.0.1:${APP_PORT[qbittorrent]}/api/v2/app/version" 2>/dev/null)"
        curl -s -b "$jar" -o /dev/null --max-time "$T_HTTP" -X POST \
            "http://127.0.0.1:${APP_PORT[qbittorrent]}/api/v2/auth/logout" 2>/dev/null || true
    elif [[ "$lc" == 401 || "$lc" == 403 ]] || grep -q 'Fails' "$WORK/qbt.lr" 2>/dev/null; then
        state_set qbtBackoffUntil "$((now + QBT_BACKOFF))"
    fi
    qbt_probe "${lc:-0}" "$(cat "$WORK/qbt.lr" 2>/dev/null)" "${ic:-0}" "$ib" "$vb" 0 "$now"
}

# The job's private state (backoff), 0600.
state_set() { # key number
    local f="$APPDATA/.stack-status.state" tmp
    tmp="$(mktemp "$f.XXXXXX")" || return 1
    jq -c --arg k "$1" --argjson v "$2" '.[$k] = $v' "$f" 2>/dev/null >"$tmp" \
        || jq -nc --arg k "$1" --argjson v "$2" '{($k): $v}' >"$tmp"
    chmod 600 "$tmp" && mv -f "$tmp" "$f"
}

# ─── classification ──────────────────────────────────────────────────────────
# shellcheck disable=SC2016
JQ_LIB='
def rank: {"ok": 0, "n/a": 0, "unknown": 1, "degraded": 2, "down": 3}[.] // 1;
def worst: (map(select(. != "n/a")) | max_by(rank)) // "ok";
def epoch_of: if . == null or . == "" then null else (sub("\\.[0-9]+"; "") | fromdateiso8601? // null) end;
def ago($now): ($now - .) as $s
  | if $s < 90 then "\($s) s" elif $s < 5400 then "\($s / 60 | floor) min"
    elif $s < 172800 then "\($s / 3600 | floor) h" else "\($s / 86400 | floor) d" end;
def at: strflocaltime("%a %H:%M");
def level_of: [.[] | .level] | if any(. == "down") then "down" elif any(. == "degraded") then "degraded" else "ok" end;
'

# {id, onDemand, container, probe, drift, now} → app item
classify_app() {
    jq -c --argjson window "$RESTART_WINDOW" --argjson dstale "$DRIFT_STALE" "$JQ_LIB"'
      . as $in | $in.now as $now | $in.container as $c | $in.probe as $p | $in.drift as $d
      | if $in.onDemand then
          {id: $in.id, level: "n/a", summary: "runs on demand (task recyclarr:sync)", reasons: [], facts: {}}
        else
          ([ if $c == null then {level: "down", text: "no container"}
             elif $c.restarting then {level: "down", text: "restarting (Docker restart loop)"}
             elif ($c.running | not) then {level: "down", text: "not running (\($c.state), exit \($c.exitCode))"}
             elif $c.health == "unhealthy" then {level: "down", text: "health check: unhealthy"}
             elif $c.health == "starting" then {level: "degraded", text: "health check: starting"}
             else empty end,
             (($c.startedAt // null) | epoch_of) as $st
             | if $c != null and $c.running and ($c.restartCount // 0) > 0 and $st != null and ($now - $st) < $window
               then {level: "degraded", text: "restarted by Docker \($c.restartCount) time(s); up \($st | ago($now))"}
               else empty end,
             if $c != null and $c.running and $p != null and $p.down != null then {level: "down", text: $p.down} else empty end,
             (if $c != null and $c.running then ($p.reasons // [])[] else empty end),
             if $d != null then
               if $d.result == "drift" then {level: "degraded", text: "settings drift (checked \($d.checkedAtEpoch | ago($now)) ago): \($d.lines[0] // "see task check")"}
               elif $d.result == "failed" then {level: "degraded", text: "settings check failed (\($d.checkedAtEpoch | ago($now)) ago): \($d.lines[0] // "see task check")"}
               elif $d.result == "warn" then {level: "notice", text: "settings check warning: \($d.lines[0] // "")"}
               else empty end
             else empty end
           ]) as $reasons
          | ($reasons | level_of) as $lvl
          | (($c.startedAt // null) | epoch_of) as $st
          | {id: $in.id, level: $lvl,
             summary: (if $lvl == "ok" then
                         (["up " + (if $st then ($st | ago($now)) else "?" end)]
                          + (if $p.version then [$p.version] else [] end)
                          + ([$reasons[] | select(.level == "notice")] | if length > 0 then ["\(length) notice(s)"] else [] end)
                          | join(" · "))
                       else ([$reasons[] | select(.level == $lvl)][0].text) end),
             reasons: $reasons,
             facts: ({container: (if $c == null then null else ($c | del(.ips)) end),
                      http: (if $p == null then null else {code: $p.http, ms: $p.ms} end),
                      version: ($p.version // null),
                      drift: (if $d == null then null else {result: $d.result, checkedAt: $d.checkedAtEpoch, lines: $d.lines} end)}
                     + ($p.facts // {}))}
        end'
}

# `systemctl show` text (blank-line separated blocks) → {Id: {key: value}}
parse_show() {
    jq -R -s -c 'split("\n\n") | map(split("\n") | map(select(test("=")) | capture("^(?<k>[^=]+)=(?<v>.*)$")
        | {key: .k, value: .v}) | from_entries | select(.Id != null) | {(.Id): .}) | add // {}'
}

# Meanings of pms-update's exit codes (jobs/pms-update/update-stack.sh).
# shellcheck disable=SC2016
JQ_EXIT_TEXT='def exit_text($unit; $code):
  if $unit == "pms-update.service" then
    {"3": "preflight failed", "4": "Plex token rejected", "5": "Plex not answering", "6": "pull failed",
     "9": "an update was rolled back; the old image is serving",
     "10": "a rollback failed: a service is DOWN"}[$code | tostring] // "exit \($code)"
  else "exit \($code)" end;'

# timer show, service show, list-timers entry, now → host item
classify_timer() { # name show-json timers-json now
    jq -nc --arg n "$1" --argjson show "$2" --argjson lt "$3" --argjson now "$4" "$JQ_LIB$JQ_EXIT_TEXT"'
      ($show["\($n).timer"] // {}) as $t | ($show["\($n).service"] // {}) as $s
      | ($lt["\($n).timer"] // {}) as $l
      | (($l.next // 0) / 1000000 | floor) as $next | (($l.last // 0) / 1000000 | floor) as $last
      | ([ if ($t.UnitFileState != "enabled") or ($t.ActiveState != "active")
           then {level: "degraded", text: "timer not armed (\(if ($t.UnitFileState // "") == "" then "not installed" else "\($t.UnitFileState), \($t.ActiveState)" end)): task deploy"} else empty end,
           if ($s.Result // "success") != "success" or (($s.ExecMainStatus // "0") != "0" and ($s.ActiveState // "") != "activating")
           then {level: "degraded", text: "last run failed: \($s.Result // "?") (\(exit_text("\($n).service"; ($s.ExecMainStatus // "0" | tonumber? // 0))))"} else empty end
         ]) as $reasons
      | {id: "timer:\($n)", kind: "timer", label: $n, level: ($reasons | level_of),
         summary: (if ($reasons | length) > 0 then $reasons[0].text
                   elif ($s.ActiveState // "") == "activating" then "running now"
                   else ([if $last > 0 then "last " + ($last | at) else "not run yet" end]
                         + (if $next > 0 then ["next " + ($next | at)] else [] end) | join(" · ")) end),
         reasons: $reasons,
         facts: {armed: (($t.UnitFileState == "enabled") and ($t.ActiveState == "active")),
                 running: (($s.ActiveState // "") == "activating"),
                 lastRun: (if $last > 0 then $last else null end), nextRun: (if $next > 0 then $next else null end),
                 lastResult: ($s.Result // null), lastExit: ($s.ExecMainStatus // null | tonumber? // null)}}'
}

classify_watcher() { # show-json now
    jq -nc --argjson show "$1" --argjson now "$2" "$JQ_LIB"'
      ($show["arr-reclaim.service"] // {}) as $s
      | (($s.ActiveEnterTimestamp // "") | ltrimstr("@") | tonumber? // null) as $since
      | if $s.ActiveState == "active" and $s.SubState == "running" then
          {id: "service:arr-reclaim", kind: "service", label: "arr-reclaim", level: "ok",
           summary: "watching the library, up \(if $since then ($since | ago($now)) else "?" end)", reasons: [],
           facts: {active: true, since: $since}}
        else
          {id: "service:arr-reclaim", kind: "service", label: "arr-reclaim", level: "down",
           summary: "not running (\($s.ActiveState // "not installed")): deleted media keeps its torrent",
           reasons: [{level: "down", text: "arr-reclaim.service is \($s.ActiveState // "not installed")"}],
           facts: {active: false, since: null}}
        end'
}

classify_disk() { # path df-P-B1-line warn-percent
    jq -nc --arg path "$1" --arg line "$2" --argjson warn "$3" '
      ($line | [splits(" +")]) as $f
      | if ($f | length) < 6 then
          {id: "disk:\($path)", kind: "disk", label: $path, level: "unknown", summary: "df gave no answer", reasons: [], facts: {}}
        else
          ($f[4] | rtrimstr("%") | tonumber) as $pct | ($f[3] | tonumber) as $avail
          | ($avail / 1000000000 | floor) as $gb
          | (if $pct >= $warn then [{level: "degraded", text: "\($pct)% used, \($gb) GB free (warns at \($warn)%)"}] else [] end) as $r
          | {id: "disk:\($path)", kind: "disk", label: $path, level: (if ($r | length) > 0 then "degraded" else "ok" end),
             summary: "\($pct)% used, \($gb) GB free", reasons: $r,
             facts: {usedPercent: $pct, availBytes: $avail, warnAt: $warn}}
        end'
}

# ip -j addr json, lan-address state text → host item (and the addresses for the page)
classify_lan() { # ip-json state-text apps-space-separated
    jq -nc --argjson ip "$1" --arg state "$2" --arg apps "$3" '
      [$ip[] | .ifname as $i | .addr_info[]? | select(.family == "inet" and .scope == "global")
       | select(.local | test("^(127\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.)") | not) | {iface: $i, addr: .local}] as $a
      | ([$a[].addr] | unique | join(" ")) as $now
      | ($state | split("\n") | map(select(length > 0) | capture("^(?<app>\\S+)\\s*(?<addrs>.*)$")) | map({(.app): .addrs}) | add // {}) as $rec
      | [$apps | split(" ")[] | select(length > 0) | select(($rec[.] // "") != $now)] as $pending
      | {id: "lan", kind: "lan", label: "LAN addresses",
         level: (if ($a | length) == 0 then "down" elif ($pending | length) > 0 then "degraded" else "ok" end),
         summary: (if ($a | length) == 0 then "no LAN address"
                   else ([$a[] | "\(.addr) (\(.iface))"] | join(", ")) end),
         reasons: (if ($pending | length) > 0
                   then [{level: "degraded", text: "address settings not applied yet: \($pending | join(", ")) (lan-address runs every 5 min)"}]
                   else [] end),
         facts: {addresses: $a, pending: $pending}}'
}

# ─── drift ───────────────────────────────────────────────────────────────────
classify_drift() { # rc output → {result, lines}
    jq -nc --argjson rc "$1" --arg out "$2" '
      ($out | split("\n")) as $l
      | [$l[] | select(test("^\\s+(DRIFT|FAIL|FAILING|WARN|warn)\\s"))][0:20] as $lines
      | ([$l[] | select(test("^\\s+DRIFT\\s"))] | length) as $drift
      | ([$l[] | select(test("^\\s+FAIL\\s"))] | length) as $fail
      | ([$l[] | select(test("^\\s+(FAILING|WARN|warn)\\s"))] | length) as $warn
      | {result: (if $rc == 124 then "failed"
                  elif $rc == 0 then (if $warn > 0 then "warn" else "ok" end)
                  elif $rc == 1 and $drift > 0 and $fail == 0 then "drift"
                  else "failed" end),
         lines: (if $rc == 124 then ["timed out"] + $lines
                 elif ($lines | length) == 0 and $rc != 0 then [($l | map(select(length > 0)) | last // "exit \($rc)")]
                 else $lines end | map(sub("^\\s+"; "") | .[0:300]))}'
}
classify_deploy_drift() { # rc output
    jq -nc --argjson rc "$1" --arg out "$2" '
      [$out | split("\n")[] | select(length > 0) | select(test("^(ok:|checked|To apply|$)") | not)][0:20] as $lines
      | {result: (if $rc == 0 then "ok" elif $rc == 1 then "drift" else "failed" end), lines: $lines}'
}

# ─── logs ────────────────────────────────────────────────────────────────────
# One log line counts as a problem when it says so: the jobs log everything at
# one journal priority, and the apps each have their own format.
# shellcheck disable=SC2016
JQ_LOG='
def clean: gsub("\u001b\\[[0-9;?]*[A-Za-z]"; "") | gsub("[\\x00-\\x08\\x0b-\\x1f\\x7f]"; "") | .[0:$max];
# Known noise that says error but is not: Plex prints both lines on every start.
def noise: test("libusb_init"; "i");
def problem: (test("\\b(warn(ing)?|err(or|ors)?|fatal|crit(ical)?|exception|panic|fail(ed|ure|ing|s)?|refused|denied|unauthori[sz]ed|timed? ?out|traceback)\\b"; "i")
              or test("\\bDRIFT\\b")) and (noise | not);
def lines($kind):
  split("\n") | map(select(length > 0 and (startswith("-- ") | not)))
  | map(if $kind == "journal" then (capture("^(?<t>\\S+) \\S+ (?<msg>.*)$") // {t: null, msg: .})
        else (capture("^(?<t>[0-9]{4}-[0-9]{2}-[0-9]{2}T\\S+Z) ?(?<msg>.*)$") // {t: null, msg: .})
             | .t |= (if . then sub("(?<a>\\.[0-9]{3})[0-9]*Z$"; "\(.a)Z") else . end) end
        | .msg |= clean);
'
log_source() { # kind id label raw-text error-text → source JSON
    jq -nc --arg kind "$1" --arg id "$2" --arg label "$3" --arg raw "$4" --arg err "$5" \
           --argjson keep "$LOG_KEEP" --argjson max "$LINE_MAX" "$JQ_LOG"'
      ($raw | lines($kind)) as $all | [$all[] | select(.msg | problem)] as $p
      | {id: $id, kind: $kind, label: $label, scanned: ($all | length),
         tail: $all[-$keep:], problems: $p[-$keep:], problemCount: ($p | length),
         error: (if $err == "" then null else $err end)}'
}
collect_logs() { # out-file
    local u c raw rc parts=()
    for u in "${LOG_UNITS[@]}"; do
        raw="$(run_journalctl -u "$u.service" -n "$LOG_SCAN" -o short-iso --no-pager 2>&1)"; rc=$?
        parts+=("$(log_source journal "unit:$u" "$u" "$raw" "$( ((rc)) && echo "journalctl exit $rc")")")
    done
    for c in "${STATUS_APPS[@]}"; do
        is_on_demand "$c" && continue
        raw="$(run_docker logs --timestamps --tail "$LOG_SCAN" "$c" 2>&1)"; rc=$?
        parts+=("$(log_source docker "container:$c" "$c" "$raw" "$( ((rc)) && echo "docker logs exit $rc")")")
    done
    printf '%s\n' "${parts[@]}" | jq -sc '.' >"$1"
}

is_on_demand() { local a; for a in "${ON_DEMAND_APPS[@]}"; do [[ "$1" == "$a" ]] && return 0; done; return 1; }

# ─── documents ───────────────────────────────────────────────────────────────
# Validate, redact, guard, then write atomically (mode 644: nginx is uid 101).
publish() { # name doc-file
    local name=$1 doc=$2 red="$WORK/$1.redacted" n tmp
    jq -e . "$doc" >/dev/null 2>&1 || { log "ERROR: $name is not valid JSON — not published"; return 1; }
    redact "$SECRETS_JSON" <"$doc" >"$red" || { log "ERROR: redaction failed for $name — not published"; return 1; }
    n="$(leaks "$red" "$SECRETS_TXT")"
    if (( n > 0 )); then
        log "ERROR: redaction guard: $n secret occurrence(s) left in $name — not published"
        return 1
    fi
    if [[ "$MODE_OUT" == stdout ]]; then jq . "$red"; return 0; fi
    if [[ "$MODE_OUT" == audit ]]; then
        printf '%-12s %7d bytes, %4d masked, %d leaks\n' "$name" "$(wc -c <"$red")" \
            "$(grep -o -F "$REDACTED" "$red" | wc -l)" "$n"
        return 0
    fi
    tmp="$(mktemp "$OUT/.$name.XXXXXX")" || { log "ERROR: cannot write in $OUT"; return 1; }
    if ! { cp "$red" "$tmp" && chmod 644 "$tmp" && mv -f "$tmp" "$OUT/$name"; }; then
        rm -f "$tmp"; log "ERROR: cannot write $OUT/$name"; return 1
    fi
}

fast_run() {
    local now start inspect containers show timers ipj dfl state apps=() a probe drift_doc pid
    start="$(now_epoch)"; now="$start"
    inspect="$(run_docker inspect "${STATUS_APPS[@]}" 2>/dev/null)"
    containers="$(containers_json "${inspect:-[]}")"

    # Probes in parallel; each request is capped by T_HTTP.
    probe_servarr radarr v3 RADARR_API_KEY >"$WORK/p.radarr" &
    probe_servarr sonarr v3 SONARR_API_KEY >"$WORK/p.sonarr" &
    probe_servarr prowlarr v1 PROWLARR_API_KEY >"$WORK/p.prowlarr" &
    probe_bazarr >"$WORK/p.bazarr" &
    probe_seerr >"$WORK/p.seerr" &
    probe_plex >"$WORK/p.plex" &
    probe_docs >"$WORK/p.docs" &
    probe_qbittorrent >"$WORK/p.qbittorrent" &
    probe_flaresolverr "$(jq -r '.flaresolverr.ips[0] // empty' <<<"$containers")" >"$WORK/p.flaresolverr" &
    collect_logs "$WORK/sources.json" &
    pid=$!

    local units=(arr-reclaim.service)
    for a in "${TIMERS[@]}"; do units+=("$a.timer" "$a.service"); done
    show="$(run_systemctl show "${units[@]}" --timestamp=unix \
        -p Id,UnitFileState,ActiveState,SubState,Result,ExecMainStatus,ActiveEnterTimestamp 2>/dev/null | parse_show)"
    timers="$(run_systemctl list-timers --all --output=json "${TIMERS[@]/%/.timer}" 2>/dev/null |
        jq -c 'map({(.unit): {next, last}}) | add // {}' 2>/dev/null)"
    [[ -n "$show" ]] || show='{}'
    [[ -n "$timers" ]] || timers='{}'
    ipj="$(run_ip -j addr 2>/dev/null)"
    dfl="$(run_df -P -B1 "$DISK_PATH" 2>/dev/null | tail -1)"
    state="$(cat "$APPDATA/.lan-address" 2>/dev/null)"
    drift_doc="$(cat "$OUT/drift.json" 2>/dev/null)"
    jq -e . <<<"$drift_doc" >/dev/null 2>&1 || drift_doc='null'
    wait

    for a in "${STATUS_APPS[@]}"; do
        probe="$(cat "$WORK/p.$a" 2>/dev/null)"; jq -e . <<<"$probe" >/dev/null 2>&1 || probe='null'
        apps+=("$(jq -nc --arg id "$a" --argjson od "$(is_on_demand "$a" && echo true || echo false)" \
            --argjson c "$containers" --argjson p "$probe" --argjson d "$drift_doc" --argjson now "$now" \
            '{id: $id, onDemand: $od, container: $c[$id], probe: $p, now: $now,
              drift: ($d.apps // [] | map(select(.id == $id))[0] // null
                      | if . == null then null else . + {checkedAtEpoch: $d.generatedAtEpoch} end)}' | classify_app)")
    done

    local host=()
    host+=("$(classify_watcher "$show" "$now")")
    for a in "${TIMERS[@]}"; do host+=("$(classify_timer "$a" "$show" "$timers" "$now")"); done
    host+=("$(classify_disk "$DISK_PATH" "$dfl" "$DISK_WARN")")
    host+=("$(classify_lan "${ipj:-[]}" "$state" "qbittorrent prowlarr radarr sonarr seerr")")
    host+=("$(jq -nc --argjson d "$drift_doc" --argjson now "$now" --argjson stale "$DRIFT_STALE" "$JQ_LIB"'
        if $d == null then {id: "drift", kind: "drift", label: "settings check", level: "unknown",
                            summary: "not run yet (hourly)", reasons: [], facts: {}}
        else (($now - $d.generatedAtEpoch) > $stale) as $old
          | ([if $old then {level: "degraded", text: "last settings check \($d.generatedAtEpoch | ago($now)) ago: stack-status-drift.timer"} else empty end,
              if $d.deploy.result == "drift" then {level: "degraded", text: "units differ from the repo: task deploy"}
              elif $d.deploy.result == "failed" then {level: "degraded", text: "deploy check failed"} else empty end]) as $r
          | {id: "drift", kind: "drift", label: "settings check", level: ($r | level_of),
             summary: (if ($r | length) > 0 then $r[0].text
                       else "checked \($d.generatedAtEpoch | ago($now)) ago: \([$d.apps[] | select(.result == "ok" or .result == "warn")] | length)/\($d.apps | length) apps match the repo" end),
             reasons: $r, facts: {checkedAt: $d.generatedAtEpoch, deploy: $d.deploy}}
        end')")

    local notes='[]'
    jq -e '."pms-update.service".ActiveState == "activating"' <<<"$show" >/dev/null 2>&1 &&
        notes='["The weekly update is running: containers may restart."]'

    printf '%s\n' "${apps[@]}" | jq -sc '.' >"$WORK/apps.json"
    printf '%s\n' "${host[@]}" | jq -sc '.' >"$WORK/host.json"
    jq -nc --slurpfile apps "$WORK/apps.json" --slurpfile host "$WORK/host.json" --argjson notes "$notes" \
        --argjson now "$now" --argjson took "$(( $(now_epoch) - start ))" --argjson stale "$STALE_AFTER" "$JQ_LIB"'
        ($apps[0] + $host[0]) as $all
        | {schema: 1, generatedAt: ($now | strflocaltime("%Y-%m-%dT%H:%M:%S%z")), generatedAtEpoch: $now,
           runSeconds: $took, staleAfterSeconds: $stale,
           overall: ([$all[].level] | worst),
           counts: ($all | group_by(.level) | map({(.[0].level): length}) | add),
           notes: $notes,
           lan: ($host[0] | map(select(.id == "lan"))[0].facts.addresses // []),
           apps: $apps[0], host: $host[0]}' >"$WORK/status.json"
    jq -nc --slurpfile s "$WORK/sources.json" --argjson now "$now" '
        {schema: 1, generatedAt: ($now | strflocaltime("%Y-%m-%dT%H:%M:%S%z")), generatedAtEpoch: $now, sources: $s[0]}' \
        >"$WORK/logs.json"
    : "$pid"

    local rc=0
    log_changes "$WORK/status.json"
    publish status.json "$WORK/status.json" || rc=1
    publish logs.json "$WORK/logs.json" || rc=1
    return "$rc"
}

# One journal line when a level changed since the published status, else quiet.
log_changes() { # new-status-file
    [[ "$MODE_OUT" == file ]] || return 0
    local changed
    changed="$(jq -r --slurpfile new "$1" '
        ([.apps[], .host[]] | map({(.id): .level}) | add // {}) as $old
        | [$new[0].apps[], $new[0].host[]] | map(select(($old[.id] // "new") != .level)
          | "\(.id) \($old[.id] // "new")→\(.level)") | join(", ")' "$OUT/status.json" 2>/dev/null)" ||
        changed="first run"
    [[ -n "$changed" ]] && log "overall $(jq -r .overall "$1"): $changed"
    return 0
}

drift_run() {
    local now app out rc start parts=() res dep
    now="$(now_epoch)"
    for app in "${DRIFT_APPS[@]}"; do
        start="$(now_epoch)"
        out="$(timeout "$T_CONFIGURE" "$REPO/apps/$app/configure.sh" --check </dev/null 2>&1)"; rc=$?
        res="$(classify_drift "$rc" "$out")"
        parts+=("$(jq -c --arg id "$app" --argjson rc "$rc" --argjson s "$(( $(now_epoch) - start ))" \
            '{id: $id, rc: $rc, seconds: $s} + .' <<<"$res")")
    done
    out="$(timeout 120 "$REPO/stack/deploy.sh" --check </dev/null 2>&1)"; rc=$?
    dep="$(classify_deploy_drift "$rc" "$out")"
    printf '%s\n' "${parts[@]}" | jq -sc --argjson now "$now" --argjson dep "$dep" '
        {schema: 1, generatedAt: ($now | strflocaltime("%Y-%m-%dT%H:%M:%S%z")), generatedAtEpoch: $now,
         apps: ., deploy: $dep}' >"$WORK/drift.json"
    [[ "$MODE_OUT" == file ]] &&
        log "settings check: $(jq -r '[.apps[] | "\(.id) \(.result)"] + ["deploy \(.deploy.result)"] | join(", ")' "$WORK/drift.json")"
    publish drift.json "$WORK/drift.json"
}

# ─── main ────────────────────────────────────────────────────────────────────
main() {
    local drift=0 arg
    MODE_OUT="file"
    for arg in "$@"; do
        case "$arg" in
            --drift)  drift=1 ;;
            --stdout) MODE_OUT=stdout ;;
            --audit)  MODE_OUT=audit ;;
            -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
            *) echo "usage: ${0##*/} [--drift] [--stdout | --audit]" >&2; exit 2 ;;
        esac
    done
    local cmd
    for cmd in jq curl docker flock timeout; do
        command -v "$cmd" >/dev/null || { log "missing command: $cmd"; exit 3; }
    done
    [[ -f "$REPO/.env" ]] || { log "no $REPO/.env"; exit 3; }
    APPDATA="${APPDATA:-$(env_get APPDATA)}"; APPDATA="${APPDATA:-/opt/appdata}"
    OUT="${STACK_STATUS_DIR:-$APPDATA/docs-status}"

    if [[ "$MODE_OUT" == file ]] && ! [[ -d "$OUT" && -w "$OUT" ]]; then
        log "ERROR: $OUT is missing or not writable — create it as yourself: install -d -m 755 $OUT"
        exit 1
    fi
    WORK="$(mktemp -d)" || exit 1
    chmod 700 "$WORK"
    trap 'rm -rf "$WORK"' EXIT

    if [[ "$MODE_OUT" == file ]]; then
        local lock="$APPDATA/.stack-status.lock"
        ((drift)) && lock="$APPDATA/.stack-status-drift.lock"
        exec 9>>"$lock" || { log "cannot open $lock"; exit 1; }
        flock -n 9 || { log "Another run holds $lock — skipping."; exit 0; }
    fi

    SECRETS_JSON="$WORK/secrets.json"; SECRETS_TXT="$WORK/secrets.txt"
    load_secrets "$SECRETS_JSON" "$SECRETS_TXT"
    if [[ "$MODE_OUT" == audit ]]; then
        printf 'secrets loaded: %s literal value(s); unclassified .env keys (masked): %s\n' \
            "$(jq length "$SECRETS_JSON")" "$(unclassified_keys "$(cat "$REPO/.env")" | paste -sd' ' | sed 's/^$/none/')"
    fi

    if ((drift)); then drift_run || exit 1
    else fast_run || exit 1
    fi
    exit 0
}

[[ "${STACK_STATUS_LIB:-0}" == "1" ]] || main "$@"
