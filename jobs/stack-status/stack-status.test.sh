#!/usr/bin/env bash
# jobs/stack-status/stack-status.test.sh — fixtures for jobs/stack-status/stack-status.sh,
# and the names it shares with the rest of the repo.
#
#   jobs/stack-status/stack-status.test.sh
#   UPDATE_GOLDEN=1 jobs/stack-status/stack-status.test.sh   rewrite testdata/status.golden.json
#
# Offline, and changes nothing outside a scratch folder: sourced with
# STACK_STATUS_LIB=1, with docker, systemctl, journalctl, df, ip and the HTTP
# calls stood in for. testdata/status.golden.json is also what the docs site's
# own test parses: the contract between this job and the page.

cd "$(dirname "$0")/../.." || exit 1
export TZ=UTC

export STACK_STATUS_LIB=1
# shellcheck source=SCRIPTDIR/stack-status.sh
. ./jobs/stack-status/stack-status.sh || { echo "cannot source jobs/stack-status/stack-status.sh"; exit 1; }

PASS=0; FAIL=0
ok_eq() { # label want got
    if [[ "$2" == "$3" ]]; then
        PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"
    else
        FAIL=$((FAIL + 1)); printf '  FAIL  %s\n          want: %q\n          got:  %q\n' "$1" "$2" "$3"
    fi
}
SCRATCH="$(mktemp -d)"; trap 'rm -rf "$SCRATCH"' EXIT
WORK="$SCRATCH/work"; mkdir -p "$WORK"
NOW=1791500000   # 2026-10-08T22:53:20Z

# ─── secrets ─────────────────────────────────────────────────────────────────
echo "secrets"
ENV_TEXT='PUID=1000
TZ=America/Argentina/Buenos_Aires
APPDATA=/opt/appdata
RADARR_API_KEY=abc123def456
QBT_ARR_USER=dario
QBT_ARR_PASS=p@ss/w+rd&x
PLEX_CLAIM="claim-xyz"
SHORT_KEY=ab
MYSTERY=some-long-value-here
MYSTERY_SHORT=true'
ok_eq "unclassified keys are reported"   $'MYSTERY\nMYSTERY_SHORT' "$(unclassified_keys "$ENV_TEXT")"
ok_eq "values masked: named 4+, unknown 8+, quotes stripped" \
    $'abc123def456\np@ss/w+rd&x\nclaim-xyz\nsome-long-value-here' "$(env_secret_values "$ENV_TEXT")"
SJ="$(env_secret_values "$ENV_TEXT" | secrets_json)"
ok_eq "with URL-encoded forms, longest first" \
    '["some-long-value-here","p%40ss%2Fw%2Brd%26x","abc123def456","p@ss/w+rd&x","claim-xyz"]' "$SJ"
ok_eq "every .env.example key is classified (secret by name, or public)" "" \
    "$(unclassified_keys "$(cat .env.example)")"
ok_eq "passwords and keys are secret by name" "QBT_ARR_PASS RADARR_API_KEY PLEX_TOKEN PLEX_CLAIM" \
    "$(for k in QBT_ARR_PASS RADARR_API_KEY PLEX_TOKEN PLEX_CLAIM; do is_named_secret "$k" && printf '%s ' "$k"; done | sed 's/ $//')"

# ─── redaction ───────────────────────────────────────────────────────────────
echo
echo "redact / leaks"
printf '%s' "$SJ" >"$SCRATCH/secrets.json"; jq -r '.[]' "$SCRATCH/secrets.json" >"$SCRATCH/secrets.txt"
DOC='{"a":"key abc123def456 in a line","b":["url ?pw=p%40ss%2Fw%2Brd%26x&x=1",{"c":"pass p@ss/w+rd&x here"}],
 "d":"GET /library?X-Plex-Token=tok123abc&x=1","e":"apikey=zzz999 and api_key: yyy888","f":"{\"password\":\"hunter22\"}",
 "g":"Authorization: Bearer eyJabc.def","h":"The WebUI temporary password is provided for this session: Tmp9pass",
 "i":"proxy http://user:pw@host:8080/x","j":"PlexOnlineToken=\"ptok-1\"","k":"Cookie: SID=abc; other",
 "l":"token bucket full, /opt/appdata/plex, claim-xyz","m":"some-long-value-here"}'
printf '%s' "$DOC" >"$SCRATCH/doc.json"
redact "$SCRATCH/secrets.json" <"$SCRATCH/doc.json" >"$SCRATCH/red.json"
R="$(cat "$SCRATCH/red.json")"
for s in abc123def456 'p%40ss%2Fw%2Brd%26x' 'p@ss/w+rd&x' tok123abc zzz999 yyy888 hunter22 eyJabc Tmp9pass 'user:pw' ptok-1 'SID=abc' claim-xyz some-long-value-here; do
    ok_eq "masked: $s" "0" "$(grep -cF -- "$s" <<<"$R")"
done
ok_eq "benign text survives"     "1" "$(jq -r .l <<<"$R" | grep -c 'token bucket full, /opt/appdata/plex')"
ok_eq "still valid JSON, same shape" "a b d e f g h i j k l m" "$(jq -r 'keys | join(" ")' <<<"$R")"
ok_eq "no leaks after redaction" "0" "$(leaks "$SCRATCH/red.json" "$SCRATCH/secrets.txt")"
ok_eq "leaks are counted before it" "true" "$( (( $(leaks "$SCRATCH/doc.json" "$SCRATCH/secrets.txt") > 0 )) && echo true)"
: >"$SCRATCH/empty.txt"
ok_eq "no secrets → no leaks (grep -F with no patterns)" "0" "$(leaks "$SCRATCH/doc.json" "$SCRATCH/empty.txt")"

# ─── containers ──────────────────────────────────────────────────────────────
echo
echo "containers_json"
INSPECT='[
 {"Name":"/radarr","RestartCount":0,"Config":{"Image":"x"},"State":{"Status":"running","Running":true,"Restarting":false,"StartedAt":"2026-10-08T18:00:00.123456789Z","ExitCode":0},"NetworkSettings":{"Networks":{"arr":{"IPAddress":"172.19.0.5"}}}},
 {"Name":"/sonarr","RestartCount":2,"Config":{"Image":"x"},"State":{"Status":"running","Running":true,"Restarting":false,"StartedAt":"2026-10-08T22:50:00Z","ExitCode":0},"NetworkSettings":{"Networks":{}}},
 {"Name":"/seerr","RestartCount":0,"Config":{"Image":"x"},"State":{"Status":"exited","Running":false,"Restarting":false,"StartedAt":"2026-10-08T18:00:00Z","ExitCode":137},"NetworkSettings":{"Networks":{}}},
 {"Name":"/decluttarr","RestartCount":0,"Config":{"Image":"x"},"State":{"Status":"running","Running":true,"Restarting":false,"StartedAt":"2026-10-08T18:00:00Z","ExitCode":0,"Health":{"Status":"unhealthy"}},"NetworkSettings":{"Networks":{}}},
 {"Name":"/bazarr","RestartCount":5,"Config":{"Image":"x"},"State":{"Status":"restarting","Running":true,"Restarting":true,"StartedAt":"2026-10-08T22:53:00Z","ExitCode":1},"NetworkSettings":{"Networks":{}}}
]'
C="$(containers_json "$INSPECT")"
ok_eq "keyed by name"             "bazarr decluttarr radarr seerr sonarr" "$(jq -r 'keys | join(" ")' <<<"$C")"
ok_eq "health and IPs"            "unhealthy 172.19.0.5" "$(jq -r '"\(.decluttarr.health) \(.radarr.ips[0])"' <<<"$C")"
ok_eq "garbage → {}"              "{}" "$(containers_json 'not json')"

# ─── probes ──────────────────────────────────────────────────────────────────
echo
echo "probes"
H='[{"source":"IndexerStatusCheck","type":"warning","message":"Indexers unavailable: 1337x"},
    {"source":"UpdateCheck","type":"notice","message":"New update"},{"source":"X","type":"ok","message":"fine"}]'
P="$(servarr_probe 200 0.041 "$H" '{"version":"6.4.4"}' 7878)"
ok_eq "servarr: warning degrades, notice informs, ok is dropped" \
    'degraded:IndexerStatusCheck: Indexers unavailable: 1337x|notice:UpdateCheck: New update' \
    "$(jq -r '[.reasons[] | "\(.level):\(.text)"] | join("|")' <<<"$P")"
ok_eq "servarr: version and ms"    "6.4.4 41" "$(jq -r '"\(.version) \(.ms)"' <<<"$P")"
ok_eq "servarr: 401 → key refused" "degraded" "$(servarr_probe 401 0 '' '' 7878 | jq -r '.reasons[0].level')"
ok_eq "servarr: nothing answering → down" "not answering on :7878" "$(servarr_probe 000 0 '' '' 7878 | jq -r .down)"
ok_eq "servarr: 503 → down"        "HTTP 503" "$(servarr_probe 503 0 '' '' 7878 | jq -r .down)"
ok_eq "bazarr: each issue degrades" "degraded:radarr: not reachable" \
    "$(bazarr_probe 200 0 '{"data":[{"object":"radarr","issue":"not reachable"}]}' '{"data":{"bazarr_version":"1.6.2"}}' | jq -r '.reasons[] | "\(.level):\(.text)"')"
ok_eq "seerr: restartRequired degrades" "degraded 3.5.0" \
    "$(seerr_probe 200 0 '{"version":"3.5.0","restartRequired":true}' | jq -r '"\(.reasons[0].level) \(.version)"')"
ID_OK="<MediaContainer size=\"0\" apiVersion=\"1.0\" machineIdentifier=\"$PLEX_IDENTITY\" version=\"1.43.4\"></MediaContainer>"
ok_eq "plex: right identity, server version (not apiVersion)" "null 1.43.4" "$(plex_probe 200 0 "$ID_OK" | jq -r '"\(.down) \(.version)"')"
ok_eq "plex: another identity is down" "identity 00000000…, expected f3860770…: a fresh database?" \
    "$(plex_probe 200 0 '<MediaContainer machineIdentifier="0000000000000000" version="1"/>' | jq -r .down)"
ok_eq "plex: not answering" "not answering on :32400" "$(plex_probe 000 0 '' | jq -r .down)"
ok_eq "qbt: connected"   "[] v5.2.4 connected" \
    "$(qbt_probe 204 '' 200 '{"connection_status":"connected","dht_nodes":300}' v5.2.4 0 "$NOW" | jq -c -r '"\(.reasons) \(.version) \(.facts.connection)"')"
ok_eq "qbt: firewalled degrades" "connection firewalled" \
    "$(qbt_probe 204 '' 200 '{"connection_status":"firewalled"}' v5 0 "$NOW" | jq -r '.reasons[0].text')"
ok_eq "qbt: refused login degrades, backs off" "true login refused (wrong user or password); next try in 1 h" \
    "$(qbt_probe 200 'Fails.' 0 '' '' 0 "$NOW" | jq -r '"\(.facts.loginRefused) \(.reasons[0].text)"')"
ok_eq "qbt: banned (403)" "login refused (banned); next try in 1 h" "$(qbt_probe 403 '' 0 '' '' 0 "$NOW" | jq -r '.reasons[0].text')"
ok_eq "qbt: during backoff, no login, next try shown" "degraded login refused earlier; next try 23:53" \
    "$(qbt_probe 0 '' 0 '' '' "$((NOW + 3600))" "$NOW" | jq -r '"\(.reasons[0].level) \(.reasons[0].text)"')"

# ─── classify_app ────────────────────────────────────────────────────────────
echo
echo "classify_app"
app() { # id container-json probe-json [drift-json] [onDemand]
    jq -nc --arg id "$1" --argjson c "$2" --argjson p "$3" --argjson d "${4:-null}" --argjson od "${5:-false}" --argjson now "$NOW" \
        '{id: $id, onDemand: $od, container: $c, probe: $p, drift: $d, now: $now}' | classify_app
}
OKP="$(servarr_probe 200 0.01 '[]' '{"version":"6.4.4"}' 7878)"
DOWNP="$(servarr_probe 000 0 '' '' 7878)"
lv() { jq -r '"\(.level) | \(.summary)"'; }
ok_eq "running, healthy → ok, uptime and version" "ok | up 4 h · 6.4.4"  "$(app radarr "$(jq .radarr <<<"$C")" "$OKP" | lv)"
ok_eq "no container → down"            "down | no container"            "$(app radarr null "$OKP" | lv)"
ok_eq "exited → down (probe ignored)"  "down | not running (exited, exit 137)" "$(app seerr "$(jq .seerr <<<"$C")" "$DOWNP" | lv)"
ok_eq "restart loop → down"            "down | restarting (Docker restart loop)" "$(app bazarr "$(jq .bazarr <<<"$C")" "$OKP" | lv)"
ok_eq "unhealthy → down"               "down | health check: unhealthy" "$(app decluttarr "$(jq .decluttarr <<<"$C")" null | lv)"
ok_eq "restarted 3 min ago → degraded" "degraded | restarted by Docker 2 time(s); up 3 min" "$(app sonarr "$(jq .sonarr <<<"$C")" "$OKP" | lv)"
ok_eq "running but not answering → down" "down | not answering on :7878" "$(app radarr "$(jq .radarr <<<"$C")" "$DOWNP" | lv)"
DR='{"id":"radarr","result":"drift","lines":["DRIFT  host: allowedHosts"],"checkedAtEpoch":1791498200}'
ok_eq "settings drift → degraded"      "degraded | settings drift (checked 30 min ago): DRIFT  host: allowedHosts" \
    "$(app radarr "$(jq .radarr <<<"$C")" "$OKP" "$DR" | lv)"
WR='{"id":"prowlarr","result":"warn","lines":["FAILING  1337x"],"checkedAtEpoch":1791498200}'
ok_eq "a check warning stays ok, counted" "ok | up 4 h · 6.4.4 · 1 notice(s)" "$(app radarr "$(jq .radarr <<<"$C")" "$OKP" "$WR" | lv)"
ok_eq "on demand → n/a"                "n/a | runs on demand (task recyclarr:sync)" "$(app recyclarr null null null true | lv)"
ok_eq "health warning → degraded"      "degraded | IndexerStatusCheck: Indexers unavailable: 1337x" \
    "$(app radarr "$(jq .radarr <<<"$C")" "$P" | lv)"

# ─── host ────────────────────────────────────────────────────────────────────
echo
echo "host items"
SHOW='Id=lan-address.timer
ActiveState=active
UnitFileState=enabled

Id=lan-address.service
ActiveState=inactive
Result=success
ExecMainStatus=0

Id=pms-update.timer
ActiveState=active
UnitFileState=enabled

Id=pms-update.service
ActiveState=inactive
Result=exit-code
ExecMainStatus=9

Id=stack-status.timer
ActiveState=inactive
UnitFileState=

Id=stack-status.service
ActiveState=activating
Result=success
ExecMainStatus=0

Id=arr-reclaim.service
ActiveState=active
SubState=running
ActiveEnterTimestamp=@1791489200'
SJSON="$(parse_show <<<"$SHOW")"
ok_eq "parse_show keys by Id"  "exit-code 9" "$(jq -r '."pms-update.service" | "\(.Result) \(.ExecMainStatus)"' <<<"$SJSON")"
LT='{"lan-address.timer":{"next":1791500300000000,"last":1791500000000000}}'
ok_eq "armed timer → last and next" "ok | last Thu 22:53 · next Thu 22:58" "$(classify_timer lan-address "$SJSON" "$LT" "$NOW" | lv)"
ok_eq "failed run, with the updater's meaning" \
    "degraded | last run failed: exit-code (an update was rolled back; the old image is serving)" \
    "$(classify_timer pms-update "$SJSON" '{}' "$NOW" | lv)"
ok_eq "not installed → degraded"    "degraded | timer not armed (not installed): task deploy" "$(classify_timer stack-status "$SJSON" '{}' "$NOW" | lv)"
ok_eq "unknown unit → degraded"     "degraded" "$(classify_timer nothing "$SJSON" '{}' "$NOW" | jq -r .level)"
ok_eq "watcher running"             "ok | watching the library, up 3 h" "$(classify_watcher "$SJSON" "$NOW" | lv)"
ok_eq "watcher stopped → down"      "down" "$(classify_watcher '{}' "$NOW" | jq -r .level)"
DF90='/dev/x 753118085120 645078695936 76393869312 90% /mnt/data'
DF96='/dev/x 753118085120 723000000000 30118085120 96% /mnt/data'
ok_eq "disk 90% → ok"               "ok | 90% used, 76 GB free" "$(classify_disk /mnt/data "$DF90" 95 | lv)"
ok_eq "disk 96% → degraded"         "degraded | 96% used, 30 GB free" "$(classify_disk /mnt/data "$DF96" 95 | lv)"
ok_eq "no df → unknown"             "unknown" "$(classify_disk /mnt/data '' 95 | jq -r .level)"
IPJ='[{"ifname":"lo","addr_info":[{"family":"inet","local":"127.0.0.1","scope":"host"}]},
      {"ifname":"eno1","addr_info":[{"family":"inet","local":"192.168.0.86","scope":"global"},{"family":"inet6","local":"fd00::1","scope":"global"}]},
      {"ifname":"wlp2s0","addr_info":[{"family":"inet","local":"192.168.0.66","scope":"global"}]},
      {"ifname":"docker0","addr_info":[{"family":"inet","local":"172.17.0.1","scope":"global"}]}]'
STATE_OK=$'qbittorrent 192.168.0.66 192.168.0.86\nradarr 192.168.0.66 192.168.0.86'
ok_eq "LAN: addresses, docker bridges and IPv6 left out" "ok | 192.168.0.86 (eno1), 192.168.0.66 (wlp2s0)" \
    "$(classify_lan "$IPJ" "$STATE_OK" "qbittorrent radarr" | lv)"
ok_eq "LAN: an app still on old addresses → degraded" "address settings not applied yet: sonarr (lan-address runs every 5 min)" \
    "$(classify_lan "$IPJ" "$STATE_OK" "qbittorrent radarr sonarr" | jq -r '.reasons[0].text')"
ok_eq "LAN: no address → down"      "down" "$(classify_lan '[]' '' "qbittorrent" | jq -r .level)"

# ─── drift ───────────────────────────────────────────────────────────────────
echo
echo "classify_drift"
dr() { classify_drift "$1" "$2" | jq -r '"\(.result) \(.lines | join("|"))"'; }
ok_eq "clean"                      "ok " "$(dr 0 $'Read-back:\n  ok       naming\nNo drift.')"
ok_eq "an indexer down is a warning, not a failure" "warn FAILING  1337x (flare) — test fails" \
    "$(dr 0 $'  ok   x\n  FAILING  1337x (flare) — test fails\nNo drift.')"
ok_eq "bazarr's warn lines too"    "warn warn     health: x" "$(dr 0 $'  warn     health: x\nNo drift.')"
ok_eq "drift"                      "drift DRIFT    host: allowedHosts" "$(dr 1 $'  DRIFT    host: allowedHosts\nTo apply: task arr:configure')"
ok_eq "a failed step is failed"    "failed FAIL  indexer sync still started after 90s" "$(dr 1 $'  FAIL  indexer sync still started after 90s')"
ok_eq "drift and a failure → failed" "failed" "$(classify_drift 1 $'  DRIFT  a\n  FAIL  b' | jq -r .result)"
ok_eq "cannot log in (3), last line kept" "failed cannot log in" "$(dr 3 $'Seerr at x\ncannot log in')"
ok_eq "timed out (124)"            "failed timed out" "$(dr 124 '')"
ok_eq "deploy clean"               "ok" "$(classify_deploy_drift 0 $'ok: x\nchecked' | jq -r .result)"
ok_eq "deploy drift keeps the problem lines" "drift SYSTEM MISSING: /etc/systemd/system/x.timer" \
    "$(classify_deploy_drift 1 $'ok: a\nSYSTEM MISSING: /etc/systemd/system/x.timer\n\nTo apply: task deploy' | jq -r '"\(.result) \(.lines | join("|"))"')"

# ─── logs ────────────────────────────────────────────────────────────────────
echo
echo "log_source"
JRAW=$'-- No entries --\n2026-10-08T18:31:24-03:00 pms systemd[1]: Started lan-address.service.\n2026-10-08T18:31:25-03:00 pms lan-address.sh[9]:     No drift.\n2026-10-08T18:31:26-03:00 pms arr-reclaim.sh[8]: reclaim: WARN: could not record'
J="$(log_source journal unit:x x "$JRAW" '')"
ok_eq "journal: time and message, host dropped" "2026-10-08T18:31:24-03:00|systemd[1]: Started lan-address.service." \
    "$(jq -r '.tail[0] | "\(.t)|\(.msg)"' <<<"$J")"
ok_eq "journal: only the WARN line is a problem" "1 reclaim" "$(jq -r '"\(.problemCount) \(.problems[0].msg | split(": ")[1])"' <<<"$J")"
DRAW=$'2026-10-09T01:03:59.927366728Z [Info] RssSyncService: Processing 166 releases\n2026-10-09T01:04:00.5Z \e[31m[Warn]\e[0m IndexerStatus: 1337x failing\nStarting Plex Media Server. . . (you can ignore the libusb_init error)\nCritical: libusb_init failed\n2026-10-09T01:05:00Z [Fatal] ConsoleApp: Failed to bind to address\n2026-10-09T01:06:00Z token bucket refilled\n2026-10-09T01:07:00Z   DRIFT  web_ui_domain_list'
D="$(log_source docker container:x x "$DRAW" '')"
ok_eq "docker: nanoseconds cut to ms"    "2026-10-09T01:03:59.927Z" "$(jq -r '.tail[0].t' <<<"$D")"
ok_eq "docker: ANSI colour stripped"     "[Warn] IndexerStatus: 1337x failing" "$(jq -r '.tail[1].msg' <<<"$D")"
ok_eq "docker: a line without a time"    "null" "$(jq -r '.tail[2].t' <<<"$D")"
ok_eq "problems: Warn, Fatal, DRIFT — not libusb, not benign" \
    "[Warn] IndexerStatus: 1337x failing|[Fatal] ConsoleApp: Failed to bind to address|  DRIFT  web_ui_domain_list" \
    "$(jq -r '[.problems[].msg] | join("|")' <<<"$D")"
MANY="$(for i in $(seq 1 60); do echo "2026-10-09T01:00:00Z line $i"; done)"
ok_eq "keeps the last 50 lines"         "50 line 11 line 60" \
    "$(log_source docker c c "$MANY" '' | jq -r '"\(.tail | length) \(.tail[0].msg) \(.tail[-1].msg)"')"
LONG="$(printf 'x%.0s' $(seq 1 700))"
ok_eq "cuts a line at 500 characters"   "500" "$(log_source docker c c "$LONG" '' | jq -r '.tail[0].msg | length')"
ok_eq "keeps the error of a failed read" "docker logs exit 1" "$(log_source docker c c '' 'docker logs exit 1' | jq -r .error)"

# ─── publish ─────────────────────────────────────────────────────────────────
echo
echo "publish"
OUT="$SCRATCH/out"; mkdir -p "$OUT"
SECRETS_JSON="$SCRATCH/secrets.json"; SECRETS_TXT="$SCRATCH/secrets.txt"; MODE_OUT="file"
log() { :; }
echo '{"x":"key abc123def456"}' >"$SCRATCH/p.json"
publish t.json "$SCRATCH/p.json"; rc=$?
ok_eq "written, redacted"               "0 {\"x\":\"key $REDACTED\"}" "$rc $(cat "$OUT/t.json")"
ok_eq "mode 644 for nginx"              "644" "$(stat -c %a "$OUT/t.json")"
ok_eq "no temp files left"              "t.json" "$(ls -A "$OUT")"
echo '{"x":"new"}' >"$SCRATCH/p.json"; publish t.json "$SCRATCH/p.json"
ok_eq "replaced"                        '{"x":"new"}' "$(cat "$OUT/t.json")"
echo 'not json' >"$SCRATCH/bad.json"; publish t.json "$SCRATCH/bad.json"; rc=$?
ok_eq "invalid JSON refused, old kept"  '1 {"x":"new"}' "$rc $(cat "$OUT/t.json")"
# A secret the masking list does not know but the guard does: refused.
echo 'never-masked-secret' >>"$SCRATCH/secrets.txt"
echo '{"x":"never-masked-secret"}' >"$SCRATCH/p.json"; publish t.json "$SCRATCH/p.json"; rc=$?
ok_eq "leak guard refuses, old kept"    '1 {"x":"new"}' "$rc $(cat "$OUT/t.json")"
sed -i '$d' "$SCRATCH/secrets.txt"
MODE_OUT="stdout"
echo '{"x":"new"}' >"$SCRATCH/p.json"
ok_eq "--stdout prints, writes nothing" '"new" no-file' "$(publish u.json "$SCRATCH/p.json" | jq .x) $([[ -e "$OUT/u.json" ]] && echo file || echo no-file)"

# ─── a whole fast run, everything stood in for ───────────────────────────────
echo
echo "fast_run"
# Every container: bazarr in a restart loop, decluttarr unhealthy, seerr exited,
# sonarr restarted 3 min ago with an indexer warning, the rest fine.
run_ok() { printf '{"Name":"/%s","RestartCount":0,"State":{"Status":"running","Running":true,"Restarting":false,"StartedAt":"2026-10-08T18:00:00Z","ExitCode":0},"NetworkSettings":{"Networks":{"arr":{"IPAddress":"%s"}}}}' "$1" "${2:-}"; }
INSPECT_ALL="$(jq -c --argjson more "[$(run_ok docs),$(run_ok flaresolverr 172.19.0.4),$(run_ok plex),$(run_ok prowlarr),$(run_ok qbittorrent)]" '. + $more' <<<"$INSPECT")"
SHOW_ALL="$SHOW"$'\n\nId=arr-fallback-search.timer\nActiveState=active\nUnitFileState=enabled\n\nId=arr-fallback-search.service\nActiveState=inactive\nResult=success\nExecMainStatus=0\n\nId=stack-status-drift.timer\nActiveState=active\nUnitFileState=enabled\n\nId=stack-status-drift.service\nActiveState=inactive\nResult=success\nExecMainStatus=0'
SHOW_ALL="${SHOW_ALL/$'Id=stack-status.timer\nActiveState=inactive\nUnitFileState='/$'Id=stack-status.timer\nActiveState=active\nUnitFileState=enabled'}"
now_epoch() { echo "$NOW"; }
run_docker() {
    case "$1" in
        inspect) echo "$INSPECT_ALL" ;;
        logs)    echo "2026-10-09T01:00:00Z [Info] fine"; echo "2026-10-09T01:00:01Z [Warn] something with apikey=zzz999" ;;
    esac
}
run_systemctl() {
    case "$1" in
        show)        printf '%s\n' "$SHOW_ALL" ;;
        list-timers) echo '[{"unit":"lan-address.timer","next":1791500300000000,"last":1791500000000000}]' ;;
    esac
}
run_journalctl() { echo "2026-10-08T18:31:24-03:00 pms x[1]: ok"; }
run_df() { printf 'Filesystem 1-blocks Used Available Capacity Mounted\n%s\n' "$DF90"; }
run_ip() { echo "$IPJ"; }
fetch() { # url out
    case "$1" in
        *:7878/api/v3/health|*:9696/api/v1/health) echo '[]' >"$2"; echo "200 0.010" ;;
        *:7878/*/status)      echo '{"version":"6.4.4"}' >"$2"; echo "200 0.010" ;;
        *:9696/*/status)      echo '{"version":"2.6.5"}' >"$2"; echo "200 0.010" ;;
        *:8989/api/v3/health) echo "$H" >"$2"; echo "200 0.020" ;;
        *:8989/*/status)      echo '{"version":"4.0.20"}' >"$2"; echo "200 0.010" ;;
        *:32400/identity)     echo "$ID_OK" >"$2"; echo "200 0.005" ;;
        *:8088/)              echo '<html>' >"$2"; echo "200 0.002" ;;
        http://172.19.0.4:8191/) echo '{"msg":"FlareSolverr is ready!","version":"3.5.2"}' >"$2"; echo "200 0.003" ;;
        *)                    : >"$2"; echo "000 0.000" ;;
    esac
}
probe_qbittorrent() { qbt_probe 204 '' 200 '{"connection_status":"connected","dht_nodes":300}' v5.2.4 0 "$NOW"; }
bazarr_api_key() { echo bazarr-key-123; }
APPDATA="$SCRATCH/appdata"; mkdir -p "$APPDATA"
printf '%s 192.168.0.66 192.168.0.86\n' qbittorrent prowlarr radarr sonarr seerr >"$APPDATA/.lan-address"
printf '%s' '{"schema":1,"generatedAtEpoch":1791498200,"apps":[{"id":"radarr","result":"ok","lines":[]},{"id":"prowlarr","result":"warn","lines":["FAILING  1337x (flare)"]}],"deploy":{"result":"ok","lines":[]}}' >"$OUT/drift.json"
rm -f "$OUT/status.json"
MODE_OUT="file"
fast_run; rc=$?
ok_eq "fast_run exits 0 on a degraded stack" "0" "$rc"
S="$(cat "$OUT/status.json")"
ok_eq "schema, overall, counts" '1 down {"degraded":2,"down":3,"n/a":1,"ok":14}' \
    "$(jq -c -r '"\(.schema) \(.overall) \(.counts | tojson)"' <<<"$S")"
ok_eq "one item per app, in order" "${STATUS_APPS[*]}" "$(jq -r '[.apps[].id] | join(" ")' <<<"$S")"
ok_eq "apps' levels" "bazarr:down decluttarr:down docs:ok flaresolverr:ok plex:ok prowlarr:ok qbittorrent:ok radarr:ok recyclarr:n/a seerr:down sonarr:degraded" \
    "$(jq -r '[.apps[] | "\(.id):\(.level)"] | join(" ")' <<<"$S")"
ok_eq "host levels" "service:arr-reclaim:ok timer:pms-update:degraded timer:arr-fallback-search:ok timer:lan-address:ok timer:stack-status:ok timer:stack-status-drift:ok disk:/mnt/data:ok lan:ok drift:ok" \
    "$(jq -r '[.host[] | "\(.id):\(.level)"] | join(" ")' <<<"$S")"
ok_eq "the drift warning reaches its app as a notice" "ok | up 4 h · 2.6.5 · 1 notice(s)" \
    "$(jq -r '.apps[] | select(.id == "prowlarr") | "\(.level) | \(.summary)"' <<<"$S")"
ok_eq "LAN addresses for the page" "192.168.0.86 192.168.0.66" "$(jq -r '[.lan[].addr] | join(" ")' <<<"$S")"
L="$(cat "$OUT/logs.json")"
ok_eq "logs: every unit and container (not recyclarr)" "16" "$(jq '.sources | length' <<<"$L")"
ok_eq "logs: secrets in log lines masked" "0" "$(grep -c zzz999 <<<"$L")"
ok_eq "the documents are mode 644"     "644 644" "$(stat -c %a "$OUT/status.json" "$OUT/logs.json" | paste -sd' ')"
GOLD=jobs/stack-status/testdata/status.golden.json
if [[ "${UPDATE_GOLDEN:-0}" == 1 ]]; then jq . <<<"$S" >"$GOLD"; echo "  wrote $GOLD"; fi
ok_eq "matches testdata/status.golden.json (UPDATE_GOLDEN=1 to rewrite)" "$(jq -S . "$GOLD" 2>/dev/null)" "$(jq -S . <<<"$S")"

# ─── one name, several owners ────────────────────────────────────────────────
echo
echo "pinned against the repo"
ok_eq "STATUS_APPS is every apps/<app>" "$(for d in apps/*/; do d="${d%/}"; printf '%s ' "${d#apps/}"; done | sed 's/ $//')" "${STATUS_APPS[*]}"
ok_eq "DRIFT_APPS is Taskfile.yml's CONFIGURED" "$(sed -n 's/^  CONFIGURED: //p' Taskfile.yml)" "${DRIFT_APPS[*]}"
for a in "${!APP_PORT[@]}"; do
    if [[ "$a" == plex ]]; then
        ok_eq "plex runs on the host network (32400)" "1" "$(grep -c 'network_mode: host' apps/plex/compose.yaml)"
    else
        ok_eq "$a probes its published port ${APP_PORT[$a]}" "1" "$(grep -cE "^\s+- \"${APP_PORT[$a]}:[0-9]+\"" "apps/$a/compose.yaml")"
    fi
done
ok_eq "plex identity is CLAUDE.md's" "1" "$(grep -c "identity \`${PLEX_IDENTITY:0:8}…\`" CLAUDE.md)"
for u in "${LOG_UNITS[@]}"; do ok_eq "log unit $u exists" "1" "$(compgen -G "jobs/*/$u.service" | wc -l | tr -d ' ')"; done
for t in "${TIMERS[@]}"; do ok_eq "timer $t exists" "1" "$(compgen -G "jobs/*/$t.timer" | wc -l | tr -d ' ')"; done
# shellcheck disable=SC2016  # the literal text in the files is what is matched
ok_eq "the docs container mounts the output directory at /live" "1" \
    "$(grep -cF '${APPDATA:?set APPDATA in .env}/docs-status:/live:ro' apps/docs/compose.yaml)"
ok_eq "nginx serves /live/ from it" "1" "$(grep -cE '^\s+alias /live/;' apps/docs/nginx.conf)"
# shellcheck disable=SC2016
ok_eq "the script writes there by default" "1" "$(grep -cF 'OUT="${STACK_STATUS_DIR:-$APPDATA/docs-status}"' jobs/stack-status/stack-status.sh)"
for u in stack-status stack-status-drift; do
    ok_eq "$u.service allows netlink" "1" "$(grep -c '^RestrictAddressFamilies=.*AF_NETLINK' "jobs/stack-status/$u.service")"
done
ok_eq "fast unit runs the script"  "/home/dario/repositories/pms-arr-setup/jobs/stack-status/stack-status.sh" \
    "$(sed -n 's/^ExecStart=//p' jobs/stack-status/stack-status.service)"
ok_eq "drift unit runs it with --drift" "/home/dario/repositories/pms-arr-setup/jobs/stack-status/stack-status.sh --drift" \
    "$(sed -n 's/^ExecStart=//p' jobs/stack-status/stack-status-drift.service)"
ok_eq "every 2 minutes after a minute"  $'OnBootSec=1min\nOnUnitActiveSec=2min' "$(grep -E '^On(Boot|UnitActive)Sec=' jobs/stack-status/stack-status.timer)"
ok_eq "drift hourly"                    "OnUnitActiveSec=1h" "$(grep -E '^OnUnitActiveSec=' jobs/stack-status/stack-status-drift.timer)"
ok_eq "the page calls stale what the job calls stale" "1" \
    "$(grep -c "staleAfterSeconds" site/src/lib/status-view.ts 2>/dev/null | awk '{print ($1 > 0)}')"

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
