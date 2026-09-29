#!/usr/bin/env bash
# qbt-configure.test.sh — unit fixtures for tools/qbt-configure.sh
#
#   tests/qbt-configure.test.sh
#
# Offline, and changes nothing: the script is sourced with QBT_CONFIGURE_LIB=1
# so main() never runs; curl, docker and hostname are stubbed.
#
# The live behaviour (first-run bootstrap from the temporary password, 204/401
# logins, 409 on an existing category, host header validation) was checked
# against a throwaway linuxserver/qbittorrent 5.2.3 container; the stubs below
# answer the way it did.

cd "$(dirname "$0")/.." || exit 1

export QBT_CONFIGURE_LIB=1
# shellcheck source=SCRIPTDIR/../tools/qbt-configure.sh
. ./tools/qbt-configure.sh || { echo "cannot source tools/qbt-configure.sh"; exit 1; }

log() { :; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
JAR="$TMP/jar"; BODY="$TMP/body"; CALLS="$TMP/calls"

PASS=0; FAIL=0

ok_eq() { # label want got
    if [[ "$2" == "$3" ]]; then
        PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"
    else
        FAIL=$((FAIL + 1)); printf '  FAIL  %s\n          want: %q\n          got:  %q\n' "$1" "$2" "$3"
    fi
}

ok_rc() { # label want-rc cmd...
    local label="$1" want="$2"; shift 2
    "$@" >/dev/null 2>&1; local got=$?
    if [[ "$got" == "$want" ]]; then
        PASS=$((PASS + 1)); printf '  ok    %s\n' "$label"
    else
        FAIL=$((FAIL + 1)); printf '  FAIL  %s\n          want rc %s, got rc %s\n' "$label" "$want" "$got"
    fi
}

# shellcheck disable=SC2329  # stubs, called indirectly by the script
hostname() {
    case "${1:-}" in
        -I) echo "192.168.0.86 192.168.0.66 172.17.0.1 172.18.0.1 fd73:5731::1" ;;
        *)  echo "pms" ;;
    esac
}

# ─── domain list ──────────────────────────────────────────────────────────────
echo "domain_list"
ok_eq "LAN IPv4 only: no docker bridges, no IPv6" "192.168.0.86 192.168.0.66" "$(lan_ips | paste -sd' ')"
ok_eq "service name, loopback, host, LAN" \
    "qbittorrent;localhost;127.0.0.1;pms;192.168.0.86;192.168.0.66" "$(domain_list)"
case ";$(domain_list);" in
    *";127.0.0.1;"*) PASS=$((PASS + 1)); echo "  ok    127.0.0.1 is always in it (else the script locks itself out)" ;;
    *)               FAIL=$((FAIL + 1)); echo "  FAIL  127.0.0.1 missing from the domain list" ;;
esac

# ─── wanted preferences ───────────────────────────────────────────────────────
echo
echo "want_prefs"
W="$(want_prefs)"
for k in save_path temp_path_enabled temp_path auto_tmm_enabled autorun_enabled listen_port \
         upnp max_ratio_enabled max_ratio max_seeding_time_enabled max_seeding_time max_ratio_act \
         web_ui_host_header_validation_enabled web_ui_domain_list; do
    ok_eq "sets $k" "true" "$(jq --arg k "$k" 'has($k)' <<<"$W")"
done
ok_eq "never the hook"           "false" "$(jq '.autorun_enabled' <<<"$W")"
ok_eq "peer port is not native's" "13762" "$(jq '.listen_port' <<<"$W")"
ok_eq "incomplete stays on the same volume" "/mnt/data/torrents/.incomplete-arr" "$(jq -r '.temp_path' <<<"$W")"
ok_eq "seeding: ratio 2.0"                 "2"     "$(jq '.max_ratio' <<<"$W")"
ok_eq "seeding: or 14 days"                "20160" "$(jq '.max_seeding_time' <<<"$W")"
ok_eq "both limits on"                     "true true" "$(jq -r '"\(.max_ratio_enabled) \(.max_seeding_time_enabled)"' <<<"$W")"
# 0 is Stop. 1 (Remove) or 3 (RemoveWithContent) would pull the torrent out from
# under Radarr/Sonarr before their "Remove Completed" tidies the queue.
ok_eq "then STOP, never remove"            "0"     "$(jq '.max_ratio_act' <<<"$W")"

# ─── temporary password ───────────────────────────────────────────────────────
echo
echo "temp_password"
# shellcheck disable=SC2329
docker() {
    printf '%s\n' "The WebUI administrator username is: admin" \
        "The WebUI administrator password was not set. A temporary password is provided for this session: ZK4tTJDGK" \
        "You should set your own password in program preferences."
}
ok_eq "parsed from the log" "ZK4tTJDGK" "$(temp_password)"
# shellcheck disable=SC2329
docker() { echo "WebUI will be started shortly after internal preparations."; }
ok_eq "none once a password is set" "" "$(temp_password)"

# ─── login ────────────────────────────────────────────────────────────────────
# The stub answers with STUB_CODE and STUB_BODY, and records its stdin so the
# test can check the password went there and not into argv.
echo
echo "login"
# shellcheck disable=SC2329
curl() {
    local out="" a
    for a in "$@"; do [[ "$a" == -o ]] && out=next && continue; [[ "$out" == next ]] && out="$a"; done
    printf '%s' "${STUB_BODY:-}" >"$out"
    { printf 'ARGS:'; printf ' %q' "$@"; printf '\nSTDIN:%s\n' "$(cat)"; } >>"$CALLS"
    printf '%s' "${STUB_CODE:-200}"
}
login_as() { STUB_CODE="$1" STUB_BODY="${2:-}" login u < <(printf '%s' 's3cret pw'); }
ok_rc "5.x success (204)"         0 login_as 204
ok_rc "4.x success (200 Ok.)"     0 login_as 200 "Ok."
ok_rc "4.x wrong password (200 Fails.) is not success" 1 login_as 200 "Fails."
ok_rc "5.x wrong password (401)"  1 login_as 401
: >"$CALLS"; login_as 204
ok_eq "password goes on stdin"     "STDIN:s3cret pw" "$(grep '^STDIN:' "$CALLS")"
ok_eq "password never in argv"     "0" "$(grep '^ARGS:' "$CALLS" | grep -c 's3cret')"
STUB_CODE=401 login u < <(printf x) >/dev/null
ok_eq "HTTP status survives to the caller" "401" "$HTTP"

# ─── categories ───────────────────────────────────────────────────────────────
echo
echo "ensure_category"
# First call (create) answers FIRST, any later call (edit) answers 200.
# shellcheck disable=SC2329
curl() {
    local out="" a
    for a in "$@"; do [[ "$a" == -o ]] && out=next && continue; [[ "$out" == next ]] && out="$a"; done
    : >"$out"
    printf '%s\n' "${*: -1}" >>"$CALLS"
    if [[ "$(wc -l <"$CALLS")" -eq 1 ]]; then printf '%s' "$FIRST"; else printf 200; fi
}
: >"$CALLS"; FIRST=200 ensure_category radarr /x </dev/null
ok_eq "new → created, nothing else" "createCategory" "$(sed 's#.*/##' "$CALLS" | paste -sd' ')"
: >"$CALLS"; FIRST=409 ensure_category radarr /x </dev/null
ok_eq "exists (409) → edited"       "createCategory editCategory" "$(sed 's#.*/##' "$CALLS" | paste -sd' ')"
FIRST=500; : >"$CALLS"
ok_rc "500 → error, no edit attempted" 1 ensure_category radarr /x
ok_eq "…and only one call made"     "1" "$(wc -l <"$CALLS" | tr -d ' ')"

# ─── read-back ────────────────────────────────────────────────────────────────
echo
echo "prefs_report / categories_report"
GOT="$(jq -c '.listen_port = 6881 | .extra = 1' <<<"$W")"
R="$(prefs_report "$GOT" "$W")"
ok_eq "one line per wanted key"     "14" "$(wc -l <<<"$R" | tr -d ' ')"
ok_eq "changed key is DRIFT"        "listen_port	DRIFT	6881	13762" "$(grep '^listen_port' <<<"$R")"
ok_eq "unchanged keys are ok"       "13" "$(grep -c '	ok	' <<<"$R")"
ok_eq "all ok when equal"           "0"  "$(prefs_report "$W" "$W" | grep -c DRIFT)"
C='{"radarr":{"savePath":"/mnt/data/torrents/radarr"},"sonarr":{"savePath":"/wrong"}}'
ok_eq "category ok"      "category radarr	ok"    "$(categories_report "$C" | grep radarr | cut -f1,2)"
ok_eq "category moved"   "category sonarr	DRIFT" "$(categories_report "$C" | grep sonarr | cut -f1,2)"
ok_eq "category missing" "category sonarr	DRIFT	(missing)" "$(categories_report '{}' | grep sonarr | cut -f1-3)"

# ─── summary ──────────────────────────────────────────────────────────────────
echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
