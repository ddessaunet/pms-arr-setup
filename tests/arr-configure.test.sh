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
F="$(sizes_to_fix "$D" "$(size_capped radarr)")"
ok_eq "uncapped 1080p ones are fixed" "20 22" "$(jq -r '[.[].id] | join(" ")' <<<"$F")"
ok_eq "to 40 max, 25 preferred" "40/25 40/25" "$(jq -r '[.[] | "\(.maxSize)/\(.preferredSize)"] | join(" ")' <<<"$F")"
ok_eq "min and everything else kept" "0 WEBDL-1080p" "$(jq -r '.[0] | "\(.minSize) \(.title)"' <<<"$F")"
ok_eq "Remux and 720p are not in the list" "0" "$(jq '[.[] | select(.title|test("Remux|720p"))] | length' <<<"$F")"
ok_eq "already capped → nothing to fix" "0" "$(sizes_to_fix "$(jq -c 'map(.maxSize = 40 | .preferredSize = 25)' <<<"$D")" "$(size_capped radarr)" | jq length)"
ok_eq "40 MB/min is ~4.8 GB for a 2-hour film" "4800" "$((SIZE_MAX * 120))"
P='{"id":4,"name":"HD-1080p","items":[
    {"quality":{"id":7,"name":"Bluray-1080p"},"allowed":true},
    {"quality":{"id":30,"name":"Remux-1080p"},"allowed":true},
    {"name":"WEB 1080p","allowed":true,"items":[{"quality":{"id":3,"name":"WEBDL-1080p"},"allowed":true}]}]}'
if profile_allows_remux "$P"; then PASS=$((PASS+1)); echo "  ok    a profile allowing Remux is seen"; else FAIL=$((FAIL+1)); echo "  FAIL  Remux not seen"; fi
NR="$(profile_without_remux "$P")"
if profile_allows_remux "$NR"; then FAIL=$((FAIL+1)); echo "  FAIL  Remux still allowed"; else PASS=$((PASS+1)); echo "  ok    Remux disallowed"; fi
ok_eq "and nothing else changed" "true true" "$(jq -r '"\(.items[0].allowed) \(.items[2].items[0].allowed)"' <<<"$NR")"

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
