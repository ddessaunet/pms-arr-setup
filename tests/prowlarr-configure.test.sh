#!/usr/bin/env bash
# prowlarr-configure.test.sh — unit fixtures for tools/prowlarr-configure.sh
#
#   tests/prowlarr-configure.test.sh
#
# Offline, and changes nothing: the script is sourced with
# PROWLARR_CONFIGURE_LIB=1 so main() never runs, and hostname is stubbed.
#
# The live behaviour — the API key fixed by PROWLARR__AUTH__APIKEY, allowedHosts
# being required for "not required for local addresses", 400 on a duplicate
# indexer, the forms-login 302 targets, proxies tested before they are saved,
# 1337x/EZTV challenged by Cloudflare and passing through FlareSolverr — was
# checked against throwaway Prowlarr 2.6.5 and FlareSolverr 3.5.2 containers.

cd "$(dirname "$0")/.." || exit 1

export PROWLARR_CONFIGURE_LIB=1
export PROWLARR_USER=dario
# shellcheck source=SCRIPTDIR/../tools/prowlarr-configure.sh
. ./tools/prowlarr-configure.sh || { echo "cannot source tools/prowlarr-configure.sh"; exit 1; }

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

# shellcheck disable=SC2329  # stub, called indirectly by the script
hostname() {
    case "${1:-}" in
        -I) echo "192.168.0.86 192.168.0.66 172.17.0.1 172.18.0.1 fd73:5731::1" ;;
        *)  echo "pms" ;;
    esac
}

# ─── the indexer list ─────────────────────────────────────────────────────────
echo "INDEXERS"
ok_eq "six indexers"                  "6" "${#INDEXERS[@]}"
bad=0
for e in "${INDEXERS[@]}"; do [[ "${e#*|}" == flare || "${e#*|}" == direct ]] || bad=$((bad + 1)); done
ok_eq "every route is flare or direct" "0" "$bad"
ok_eq "only Cloudflare-blocked ones go through FlareSolverr" "1337x eztv" \
    "$(printf '%s\n' "${INDEXERS[@]}" | sed -n 's/|flare$//p' | paste -sd' ')"

# ─── host config ──────────────────────────────────────────────────────────────
echo
echo "allowed_hosts / want_host"
ok_eq "service name, loopback, host, LAN; no docker bridges or IPv6" \
    "prowlarr,localhost,127.0.0.1,pms,192.168.0.86,192.168.0.66" "$(allowed_hosts)"
W="$(want_host)"
ok_eq "forms login"                    "forms"                     "$(jq -r .authenticationMethod <<<"$W")"
ok_eq "not required from local"        "disabledForLocalAddresses" "$(jq -r .authenticationRequired <<<"$W")"
ok_eq "username from .env"             "dario"                     "$(jq -r .username <<<"$W")"
ok_eq "never carries the password"     "false"                     "$(jq 'has("password")' <<<"$W")"

echo
echo "host_drift"
GOT="$(jq -c '. + {id: 1, apiKey: "k", port: 9696}' <<<"$W")"
ok_eq "extra keys Prowlarr has are ignored" "" "$(host_drift "$GOT" "$W")"
ok_eq "a changed key is named"         "allowedHosts" \
    "$(host_drift "$(jq -c '.allowedHosts = "localhost"' <<<"$GOT")" "$W")"
ok_eq "several changes, one per line"  "username allowedHosts" \
    "$(host_drift "$(jq -c '.username = "x" | .allowedHosts = ""' <<<"$GOT")" "$W" | paste -sd' ')"

# ─── indexers ─────────────────────────────────────────────────────────────────
echo
echo "indexer_new / indexer_fix / indexer_differs"
SCHEMA='{"definitionName":"1337x","name":"1337x","enable":false,"appProfileId":0,"tags":[],"fields":[{"name":"baseUrl","value":null}]}'
N="$(indexer_new "$SCHEMA" 1 '[3]')"
ok_eq "new: enabled"                   "true"  "$(jq .enable <<<"$N")"
ok_eq "new: app profile set"           "1"     "$(jq .appProfileId <<<"$N")"
ok_eq "new: tags set"                  "[3]"   "$(jq -c .tags <<<"$N")"
ok_eq "new: schema fields kept"        "baseUrl" "$(jq -r '.fields[0].name' <<<"$N")"

IX='{"id":7,"definitionName":"eztv","enable":true,"tags":[3],"priority":25}'
ok_rc "as wanted → no change"          1 indexer_differs "$IX" '[3]'
ok_rc "tag order does not matter"      1 indexer_differs "$(jq -c '.tags=[5,3]' <<<"$IX")" '[3,5]'
ok_rc "disabled → differs"             0 indexer_differs "$(jq -c '.enable=false' <<<"$IX")" '[3]'
ok_rc "flare tag missing → differs"    0 indexer_differs "$(jq -c '.tags=[]' <<<"$IX")" '[3]'
ok_rc "flare tag unwanted → differs"   0 indexer_differs "$IX" '[]'
F="$(indexer_fix "$(jq -c '.enable=false | .tags=[]' <<<"$IX")" '[3]')"
ok_eq "fix: enabled and tagged, id and priority kept" '{"id":7,"enable":true,"tags":[3],"priority":25}' \
    "$(jq -c '{id,enable,tags,priority}' <<<"$F")"

# ─── sync profile ─────────────────────────────────────────────────────────────
echo
echo "syncprofile_fix / syncprofile_differs"
SP='{"name":"Standard","enableRss":true,"enableAutomaticSearch":true,"enableInteractiveSearch":true,"minimumSeeders":1,"id":1}'
ok_eq "floor is 5"                     "5"     "$MIN_SEEDERS"
ok_rc "Prowlarr's default 1 → differs" 0 syncprofile_differs "$SP" 5
ok_rc "at the floor → no change"       1 syncprofile_differs "$(jq -c '.minimumSeeders=5' <<<"$SP")" 5
ok_rc "raised by hand → differs"       0 syncprofile_differs "$(jq -c '.minimumSeeders=20' <<<"$SP")" 5
ok_eq "fix: only minimumSeeders changes" \
    '{"name":"Standard","enableRss":true,"enableAutomaticSearch":true,"enableInteractiveSearch":true,"minimumSeeders":5,"id":1}' \
    "$(syncprofile_fix "$SP" 5)"

# ─── proxy ────────────────────────────────────────────────────────────────────
echo
echo "proxy_differs"
PX='{"id":1,"implementation":"FlareSolverr","tags":[3],"fields":[{"name":"host","value":"http://flaresolverr:8191/"},{"name":"requestTimeout","value":60}]}'
ok_rc "as wanted → no change"          1 proxy_differs "$PX" "http://flaresolverr:8191/" 3
ok_rc "host changed → differs"         0 proxy_differs "$PX" "http://elsewhere:8191/" 3
ok_rc "tag changed → differs"          0 proxy_differs "$(jq -c '.tags=[]' <<<"$PX")" "http://flaresolverr:8191/" 3

# ─── login ────────────────────────────────────────────────────────────────────
echo
echo "login_redirect_ok"
ok_rc "302 to the return URL → accepted" 0 login_redirect_ok "http://127.0.0.1:9696/"
ok_rc "302 to loginFailed → refused"     1 login_redirect_ok "http://127.0.0.1:9696/login?returnUrl=/&loginFailed=true"
ok_rc "no redirect at all → refused"     1 login_redirect_ok ""

# ─── summary ──────────────────────────────────────────────────────────────────
echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
