#!/usr/bin/env bash
# jobs/arr-fallback-search/arr-fallback-search.test.sh — unit fixtures for jobs/arr-fallback-search/arr-fallback-search.sh,
# and the one name it shares with recyclarr.yml and arr-configure.sh.
#
#   jobs/arr-fallback-search/arr-fallback-search.test.sh
#
# Offline, and changes nothing: sourced with ARR_FALLBACK_SEARCH_LIB=1 so main()
# never runs. The movie fields (qualityProfileId, monitored, isAvailable,
# movieFile.quality.quality.resolution) are Radarr 6's /api/v3/movie.

cd "$(dirname "$0")/../.." || exit 1

export ARR_FALLBACK_SEARCH_LIB=1
# shellcheck source=SCRIPTDIR/arr-fallback-search.sh
. ./jobs/arr-fallback-search/arr-fallback-search.sh || { echo "cannot source jobs/arr-fallback-search/arr-fallback-search.sh"; exit 1; }

PASS=0; FAIL=0
ok_eq() { # label want got
    if [[ "$2" == "$3" ]]; then
        PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"
    else
        FAIL=$((FAIL + 1)); printf '  FAIL  %s\n          want: %q\n          got:  %q\n' "$1" "$2" "$3"
    fi
}

# ─── which movies get searched ────────────────────────────────────────────────
echo "fallback_ids / fallback_titles"
M='[
  {"id":1,"title":"Inception","year":2010,"qualityProfileId":8,"monitored":true,"isAvailable":true,
   "movieFile":{"quality":{"quality":{"name":"WEBDL-1080p","resolution":1080}}}},
  {"id":2,"title":"Dune","year":2021,"qualityProfileId":8,"monitored":true,"isAvailable":true,
   "movieFile":{"quality":{"quality":{"name":"WEBDL-2160p","resolution":2160}}}},
  {"id":3,"title":"Air","year":2023,"qualityProfileId":7,"monitored":true,"isAvailable":true,
   "movieFile":{"quality":{"quality":{"name":"WEBDL-1080p","resolution":1080}}}},
  {"id":4,"title":"Heat","year":1995,"qualityProfileId":8,"monitored":false,"isAvailable":true,
   "movieFile":{"quality":{"quality":{"name":"Bluray-1080p","resolution":1080}}}},
  {"id":5,"title":"Brick","year":2005,"qualityProfileId":8,"monitored":true,"isAvailable":true},
  {"id":6,"title":"Soon","year":2027,"qualityProfileId":8,"monitored":true,"isAvailable":false}
]'
ok_eq "1080p and no-file movies on the profile, nothing else" "[1,5]" "$(fallback_ids "$M" 8)"
ok_eq "a 4K file is left to RSS"            "false" "$(fallback_ids "$M" 8 | jq 'index(2) != null')"
ok_eq "another profile is never touched"    "false" "$(fallback_ids "$M" 8 | jq 'index(3) != null')"
ok_eq "unmonitored is never searched"       "false" "$(fallback_ids "$M" 8 | jq 'index(4) != null')"
ok_eq "not released yet is not searched"    "false" "$(fallback_ids "$M" 8 | jq 'index(6) != null')"
ok_eq "empty library → empty list"          "[]"    "$(fallback_ids '[]' 8)"
ok_eq "titles for the log" $'Inception (2010) — WEBDL-1080p\nBrick (2005) — no file' "$(fallback_titles "$M" "[1,5]")"

echo
echo "profile_id_of"
P='[{"id":7,"name":"UHD Bluray + WEB"},{"id":8,"name":"4K HDR or 1080p"}]'
ok_eq "found by exact name" "8" "$(profile_id_of "$P" "$FALLBACK_PROFILE")"
ok_eq "missing → empty"     ""  "$(profile_id_of '[{"id":7,"name":"UHD Bluray + WEB"}]' "$FALLBACK_PROFILE")"

# ─── one name, three owners ───────────────────────────────────────────────────
# Recyclarr creates the profile, arr-configure.sh keeps its upgrades on, and this
# script finds it — all by name. A rename in one place must fail here.
echo
echo "the profile name across files"
ok_eq "recyclarr.yml creates it" "1" \
    "$(grep -cxF "        name: $FALLBACK_PROFILE" apps/recyclarr/recyclarr.yml)"
ok_eq "arr-configure.sh lets it upgrade" "$FALLBACK_PROFILE" \
    "$(ARR_CONFIGURE_LIB=1 bash -c '. ./stack/lib/arr-configure.sh && upgrade_profiles radarr' | grep -xF "$FALLBACK_PROFILE")"
ok_eq "the timer runs this script" "/home/dario/repositories/pms-arr-setup/jobs/arr-fallback-search/arr-fallback-search.sh" \
    "$(sed -n 's/^ExecStart=//p' jobs/arr-fallback-search/arr-fallback-search.service)"

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
