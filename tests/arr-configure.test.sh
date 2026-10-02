#!/usr/bin/env bash
# arr-configure.test.sh — unit fixtures for tools/arr-configure.sh and the
# shared tools/lib/servarr.sh it runs on.
#
#   tests/arr-configure.test.sh
#
# Offline, and changes nothing: sourced with ARR_CONFIGURE_LIB=1 so main()
# never runs; hostname is stubbed. The live behaviour — keys fixed by
# <APP>__AUTH__APIKEY, 400 on a root folder that does not exist, secrets
# masked on read, allowedHosts only enforced after a restart, history filtered
# by eventType=3 only — was checked on throwaway Radarr 6.4.4 / Sonarr 4.0.20.

cd "$(dirname "$0")/.." || exit 1

export ARR_CONFIGURE_LIB=1 QBT_ARR_USER=qbtuser
# shellcheck source=SCRIPTDIR/../tools/arr-configure.sh
. ./tools/arr-configure.sh || { echo "cannot source tools/arr-configure.sh"; exit 1; }

PASS=0; FAIL=0
ok_eq() { # label want got
    if [[ "$2" == "$3" ]]; then
        PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"
    else
        FAIL=$((FAIL + 1)); printf '  FAIL  %s\n          want: %q\n          got:  %q\n' "$1" "$2" "$3"
    fi
}

# shellcheck disable=SC2329  # stub, called indirectly
hostname() { [[ "${1:-}" == -I ]] && echo "192.168.0.86 172.18.0.1" || echo pms; }

# ─── per-app differences ──────────────────────────────────────────────────────
echo "per app"
ok_eq "radarr root"   /mnt/data/streaming/movies "$(app_root radarr)"
ok_eq "sonarr root"   /mnt/data/streaming/series "$(app_root sonarr)"
ok_eq "radarr port"   7878 "$(app_port radarr)"
ok_eq "sonarr port"   8989 "$(app_port sonarr)"
ok_eq "default URL is local" http://127.0.0.1:7878 "$(app_url radarr)"
ok_eq "overridable for rehearsals" http://127.0.0.1:17878 "$(RADARR_URL=http://127.0.0.1:17878 app_url radarr)"

# ─── naming: new imports only, the names Plex expects ────────────────────────
echo
echo "want_naming"
ok_eq "radarr renames new imports"   true "$(want_naming radarr | jq .renameMovies)"
ok_eq "radarr folder"   "{Movie Title} ({Release Year})" "$(want_naming radarr | jq -r .movieFolderFormat)"
ok_eq "radarr file"     "{Movie Title} ({Release Year})" "$(want_naming radarr | jq -r .standardMovieFormat)"
ok_eq "sonarr renames new imports"   true "$(want_naming sonarr | jq .renameEpisodes)"
ok_eq "sonarr season folder zero-padded" "Season {season:00}" "$(want_naming sonarr | jq -r .seasonFolderFormat)"
ok_eq "sonarr episode" "{Series Title} - S{season:00}E{episode:00}" "$(want_naming sonarr | jq -r .standardEpisodeFormat)"

# ─── media management: the rules that keep plex-watch quiet ──────────────────
echo
echo "want_media"
for app in radarr sonarr; do
    M="$(want_media "$app")"
    ok_eq "$app: hardlinks"                 true "$(jq .copyUsingHardlinks <<<"$M")"
    ok_eq "$app: no recycle bin (a move)"   ""   "$(jq -r .recycleBin <<<"$M")"
    ok_eq "$app: never deletes folders"     false "$(jq .deleteEmptyFolders <<<"$M")"
    ok_eq "$app: 10 GB floor"               10000 "$(jq .minimumFreeSpaceWhenImporting <<<"$M")"
done
ok_eq "radarr unmonitors deleted movies" true "$(want_media radarr | jq .autoUnmonitorPreviouslyDownloadedMovies)"
ok_eq "sonarr unmonitors deleted episodes" true "$(want_media sonarr | jq .autoUnmonitorPreviouslyDownloadedEpisodes)"
ok_eq "and not the other app's key" false "$(want_media radarr | jq 'has("autoUnmonitorPreviouslyDownloadedEpisodes")')"

# ─── download client ──────────────────────────────────────────────────────────
echo
echo "want_client_fields / want_client_top"
ok_eq "radarr: the :8081 qBittorrent, category radarr" \
    '{"host":"qbittorrent","movieCategory":"radarr","port":8081,"useSsl":false,"username":"qbtuser"}' \
    "$(want_client_fields radarr | jq -cS .)"
ok_eq "sonarr: tvCategory sonarr" "sonarr" "$(want_client_fields sonarr | jq -r .tvCategory)"
ok_eq "never carries the password (masked on read, sent separately)" false "$(want_client_fields radarr | jq 'has("password")')"
ok_eq "Remove Completed and Remove Failed" "true true" \
    "$(want_client_top | jq -r '"\(.removeCompletedDownloads) \(.removeFailedDownloads)"')"

# ─── Plex connection ──────────────────────────────────────────────────────────
echo
echo "want_plex_*"
ok_eq "through the host gateway" "host.docker.internal:32400" "$(want_plex_fields | jq -r '"\(.host):\(.port)"')"
ok_eq "never carries the token"  false "$(want_plex_fields | jq 'has("authToken")')"
ok_eq "radarr refreshes on delete too" true "$(want_plex_top radarr | jq .onMovieFileDelete)"
ok_eq "sonarr refreshes on delete too" true "$(want_plex_top sonarr | jq .onEpisodeFileDelete)"

# ─── size caps and no Remux ───────────────────────────────────────────────────
echo
echo "sizes_to_fix / profile_*_remux"
D='[{"id":20,"title":"WEBDL-1080p","minSize":0,"preferredSize":95,"maxSize":100},
    {"id":22,"title":"Bluray-1080p","minSize":0,"preferredSize":null,"maxSize":null},
    {"id":23,"title":"Remux-1080p","minSize":0,"preferredSize":null,"maxSize":null},
    {"id":3,"title":"HDTV-720p","minSize":0,"preferredSize":95,"maxSize":100}]'
F="$(sizes_to_fix "$D" "$(size_caps radarr)")"
ok_eq "uncapped 1080p ones are fixed" "20 22" "$(jq -r '[.[].id] | join(" ")' <<<"$F")"
ok_eq "to 40 max, 25 preferred" "40/25 40/25" "$(jq -r '[.[] | "\(.maxSize)/\(.preferredSize)"] | join(" ")' <<<"$F")"
ok_eq "min and everything else kept" "0 WEBDL-1080p" "$(jq -r '.[0] | "\(.minSize) \(.title)"' <<<"$F")"
ok_eq "Remux and 720p are not in the list" "0" "$(jq '[.[] | select(.title|test("Remux|720p"))] | length' <<<"$F")"
ok_eq "already capped → nothing to fix" "0" "$(sizes_to_fix "$(jq -c 'map(.maxSize = 40 | .preferredSize = 25)' <<<"$D")" "$(size_caps radarr)" | jq length)"
ok_eq "1080p 40 MB/min is ~4.8 GB for a 2-hour film" "4800" "$(( $(size_caps radarr | awk -F'\t' '$1=="Bluray-1080p"{print $2}') * 120 ))"
D4='[{"id":24,"title":"WEBDL-2160p","minSize":0,"preferredSize":null,"maxSize":null},
     {"id":27,"title":"Bluray-2160p","minSize":0,"preferredSize":null,"maxSize":null},
     {"id":28,"title":"Remux-2160p","minSize":0,"preferredSize":null,"maxSize":null}]'
F4="$(sizes_to_fix "$D4" "$(size_caps radarr)")"
ok_eq "radarr 2160p capped at 150, preferred 100" "150/100 150/100" "$(jq -r '[.[] | "\(.maxSize)/\(.preferredSize)"] | join(" ")' <<<"$F4")"
ok_eq "2160p 150 MB/min is ~18 GB for a 2-hour film" "18000" "$(( $(size_caps radarr | awk -F'\t' '$1=="WEBDL-2160p"{print $2}') * 120 ))"
ok_eq "Remux-2160p is never capped into eligibility" "0" "$(jq '[.[] | select(.title=="Remux-2160p")] | length' <<<"$F4")"
ok_eq "sonarr has no 2160p caps (series stay 1080p)" "0" "$(size_caps sonarr | grep -c 2160p)"
ok_eq "summary line" "1080p 40/25, 2160p 150/100 MB/min" "$(sizes_summary radarr)"
DS='[{"id":15,"title":"WEBDL-1080p","minSize":4,"preferredSize":25,"maxSize":40},
     {"id":16,"title":"Bluray-1080p","minSize":4,"preferredSize":95,"maxSize":null},
     {"id":12,"title":"WEBDL-720p","minSize":3,"preferredSize":95,"maxSize":130}]'
FS="$(sizes_to_fix "$DS" "$(size_caps sonarr)")"
ok_eq "sonarr 1080p gets no max, 25 preferred" "15:null/25 16:null/25" "$(jq -r '[.[] | "\(.id):\(.maxSize)/\(.preferredSize)"] | join(" ")' <<<"$FS")"
ok_eq "a 22-minute episode at 1 GB is not capped" "null" "$(jq -c '.[] | select(.id==15) | .maxSize' <<<"$FS")"
ok_eq "sonarr already uncapped → nothing to fix" "0" "$(sizes_to_fix "$(jq -c 'map(.maxSize = null | .preferredSize = 25)' <<<"$DS")" "$(size_caps sonarr)" | jq length)"
ok_eq "sonarr summary line" "1080p no max/25 MB/min" "$(sizes_summary sonarr)"
P='{"id":4,"name":"HD-1080p","items":[
    {"quality":{"id":7,"name":"Bluray-1080p"},"allowed":true},
    {"quality":{"id":30,"name":"Remux-1080p"},"allowed":true},
    {"name":"WEB 1080p","allowed":true,"items":[{"quality":{"id":3,"name":"WEBDL-1080p"},"allowed":true}]}]}'
if profile_allows_remux "$P"; then PASS=$((PASS+1)); echo "  ok    a profile allowing Remux is seen"; else FAIL=$((FAIL+1)); echo "  FAIL  Remux not seen"; fi
NR="$(profile_without_remux "$P")"
if profile_allows_remux "$NR"; then FAIL=$((FAIL+1)); echo "  FAIL  Remux still allowed"; else PASS=$((PASS+1)); echo "  ok    Remux disallowed"; fi
ok_eq "and nothing else changed" "true true" "$(jq -r '"\(.items[0].allowed) \(.items[2].items[0].allowed)"' <<<"$NR")"

# Recyclarr merges the 4K qualities into one group (recyclarr.yml), so the
# profile's allowed items sit one level down: the Remux walk must still see them.
UHD='{"id":7,"name":"UHD Bluray + WEB","items":[
    {"quality":{"id":31,"name":"Remux-2160p"},"allowed":true},
    {"id":1003,"name":"UHD 2160p","allowed":true,"items":[
        {"quality":{"id":19,"name":"Bluray-2160p"},"allowed":true},
        {"quality":{"id":18,"name":"WEBDL-2160p"},"allowed":true}]}]}'
UNR="$(profile_without_remux "$UHD")"
ok_eq "merged 4K group: Remux off, group and members kept" "false true true true" \
    "$(jq -r '"\(.items[0].allowed) \(.items[1].allowed) \(.items[1].items[0].allowed) \(.items[1].items[1].allowed)"' <<<"$UNR")"

# The fallback variant adds a 1080p group under the 4K one; Remux-1080p beside
# it is the mistake that matters there.
FB='{"id":8,"name":"4K HDR or 1080p","items":[
    {"quality":{"id":30,"name":"Remux-1080p"},"allowed":true},
    {"id":1004,"name":"HD 1080p","allowed":true,"items":[
        {"quality":{"id":7,"name":"Bluray-1080p"},"allowed":true}]},
    {"id":1003,"name":"UHD 2160p","allowed":true,"items":[
        {"quality":{"id":19,"name":"Bluray-2160p"},"allowed":true}]}]}'
if profile_allows_remux "$FB"; then PASS=$((PASS+1)); echo "  ok    fallback with Remux-1080p is caught"; else FAIL=$((FAIL+1)); echo "  FAIL  fallback Remux-1080p missed"; fi
ok_eq "fallback: Remux off, both groups kept" "false true true true true" \
    "$(profile_without_remux "$FB" | jq -r '"\(.items[0].allowed) \(.items[1].allowed) \(.items[1].items[0].allowed) \(.items[2].allowed) \(.items[2].items[0].allowed)"')"

# ─── minimum seeders, as pushed by Prowlarr ──────────────────────────────────
echo
echo "indexer_min_seeders"
IXS='[{"name":"YTS (Prowlarr)","fields":[{"name":"minimumSeeders","value":5},{"name":"seedCriteria.seedRatio","value":null}]},
      {"name":"1337x (Prowlarr)","fields":[{"name":"minimumSeeders","value":5}]}]'
ok_eq "all at the floor"             "5"     "$(indexer_min_seeders "$IXS")"
ok_eq "a sync still on its way"      "1,5"   "$(indexer_min_seeders "$(jq -c '.[0].fields[0].value=1' <<<"$IXS")")"
ok_eq "field missing → unset"        "unset" "$(indexer_min_seeders '[{"name":"x","fields":[]}]')"

# ─── defaults and the upgrade allow-list ─────────────────────────────────────
echo
echo "default_profile / upgrade_profiles / remux_free_profiles / upgrades_to_fix"
ok_eq "movies default to 4K HDR"   "UHD Bluray + WEB" "$(default_profile radarr)"
ok_eq "series default to 1080p"    "WEB-1080p"        "$(default_profile sonarr)"
ok_eq "only the two 4K movie profiles upgrade" $'UHD Bluray + WEB\n4K HDR or 1080p' "$(upgrade_profiles radarr)"
ok_eq "no series profile upgrades" "" "$(upgrade_profiles sonarr)"
ok_eq "radarr: no Remux on the default, the variant or UHD Fallback" $'UHD Bluray + WEB\n4K HDR or 1080p\nUHD Fallback' "$(remux_free_profiles radarr)"
ok_eq "sonarr: no Remux on the default" "WEB-1080p" "$(remux_free_profiles sonarr)"
PR='[{"id":4,"name":"HD-1080p","upgradeAllowed":true},{"id":7,"name":"UHD Bluray + WEB","upgradeAllowed":false},
     {"id":1,"name":"Any","upgradeAllowed":false},{"id":8,"name":"4K HDR or 1080p","upgradeAllowed":false}]'
UF="$(upgrades_to_fix "$PR" "$(upgrade_profiles radarr)")"
ok_eq "HD-1080p off, both 4K profiles on, Any untouched" \
    '[{"name":"HD-1080p","u":false},{"name":"UHD Bluray + WEB","u":true},{"name":"4K HDR or 1080p","u":true}]' \
    "$(jq -c '[.[] | {name, u: .upgradeAllowed}]' <<<"$UF")"
ok_eq "already right → nothing to fix" "0" "$(upgrades_to_fix "$(jq -c '(.[0].upgradeAllowed)=false | (.[1].upgradeAllowed)=true | (.[3].upgradeAllowed)=true' <<<"$PR")" "$(upgrade_profiles radarr)" | jq length)"
ok_eq "sonarr: every upgrading profile turned off" '["HD-1080p"]' "$(upgrades_to_fix "$PR" "$(upgrade_profiles sonarr)" | jq -c '[.[].name]')"
# The hand-picked UHD Fallback (recyclarr.yml) never upgrades.
PRF="$(jq -c '. + [{"id":8,"name":"UHD Fallback","upgradeAllowed":true}]' <<<"$PR")"
ok_eq "fallback upgrading → turned off" "false" \
    "$(upgrades_to_fix "$PRF" "$(upgrade_profiles radarr)" | jq -c '.[] | select(.name == "UHD Fallback") | .upgradeAllowed')"

# ─── resources (tools/lib/servarr.sh) ─────────────────────────────────────────
echo
echo "fields_set / fields_drift / resource_want / resource_drift"
R='{"id":3,"name":"qBittorrent","enable":true,"removeCompletedDownloads":true,
    "fields":[{"name":"host","value":"qbittorrent"},{"name":"port","value":8081},
              {"name":"password","value":"********"},{"name":"movieCategory","value":"radarr"}]}'
ok_eq "set replaces only named fields" '["qb2",8081,"********","radarr"]' \
    "$(fields_set "$R" '{"host":"qb2"}' | jq -c '[.fields[].value]')"
ok_eq "set ignores names the resource lacks" '4' \
    "$(fields_set "$R" '{"nope":1}' | jq '.fields | length')"
ok_eq "no field drift when equal" "" "$(fields_drift "$R" '{"host":"qbittorrent","port":8081}')"
ok_eq "field drift is named" "movieCategory" "$(fields_drift "$R" '{"movieCategory":"other"}')"
ok_eq "resource drift: top-level and fields together" "removeCompletedDownloads movieCategory" \
    "$(resource_drift "$R" '{"removeCompletedDownloads":false}' '{"movieCategory":"other"}' | paste -sd' ')"
ok_eq "resource_want: top-level merged, fields set, id kept" '{"enable":false,"host":"x","id":3}' \
    "$(resource_want "$R" '{"enable":false}' '{"host":"x"}' | jq -cS '{id,enable,host:(.fields[0].value)}')"

# ─── shared host config (tools/lib/servarr.sh) ────────────────────────────────
echo
echo "allowed_hosts / want_host"
# shellcheck disable=SC2034  # read by the sourced library
SVC_NAME=radarr SVC_USER=dario
ok_eq "service name first, LAN IPv4 only" "radarr,localhost,127.0.0.1,pms,192.168.0.86" "$(allowed_hosts)"
ok_eq "rehearsal names appended when asked" "radarr,localhost,127.0.0.1,pms,192.168.0.86,probe-radarr" \
    "$(ALLOWED_HOSTS_EXTRA=probe-radarr allowed_hosts)"
ok_eq "unset extra is fine under set -u" "radarr,localhost,127.0.0.1,pms,192.168.0.86" \
    "$(unset ALLOWED_HOSTS_EXTRA; set -u; allowed_hosts)"
ok_eq "forms, not required locally, no password" '{"authenticationMethod":"forms","authenticationRequired":"disabledForLocalAddresses","has_pw":false}' \
    "$(want_host | jq -c '{authenticationMethod,authenticationRequired,has_pw: has("password")}')"

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
