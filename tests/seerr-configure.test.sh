#!/usr/bin/env bash
# seerr-configure.test.sh — unit fixtures for tools/seerr-configure.sh
#
#   tests/seerr-configure.test.sh
#
# Offline, and changes nothing: sourced with SEERR_CONFIGURE_LIB=1 so main()
# never runs; hostname is stubbed. The live behaviour was checked on a
# throwaway Seerr 3.5.0 against the real Plex, Radarr and Sonarr: the API key
# refused (403) until an admin exists, read-only fields (apiKey, machineId, id)
# rejected in writes, libraries synced by POST /settings/plex/library/sync and
# toggled by PUT /settings/plex/library/{id}, and the Plex server recorded as
# f3860770… — the Phase 1b server.

cd "$(dirname "$0")/.." || exit 1

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export SEERR_CONFIGURE_LIB=1 RADARR_API_KEY=rk SONARR_API_KEY=sk
# shellcheck source=SCRIPTDIR/../tools/seerr-configure.sh
. ./tools/seerr-configure.sh || { echo "cannot source tools/seerr-configure.sh"; exit 1; }

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

# ─── the API key ──────────────────────────────────────────────────────────────
echo "seerr_key"
printf '{"main":{"apiKey":"MTc5MDk=","newPlexLogin":true}}' > "$TMP/settings.json"
ok_eq "read from settings.json"     "MTc5MDk=" "$(seerr_key "$TMP/settings.json")"
ok_eq "missing file → empty"        ""         "$(seerr_key "$TMP/none.json")"
printf 'not json' > "$TMP/bad.json"
ok_eq "garbage → empty, no error"   ""         "$(seerr_key "$TMP/bad.json")"

# ─── the profile id comes from the app ────────────────────────────────────────
echo
echo "profile_id"
T='{"profiles":[{"id":1,"name":"Any"},{"id":4,"name":"HD-1080p"},{"id":5,"name":"Ultra-HD"}],"rootFolders":[]}'
ok_eq "HD-1080p → 4"                "4" "$(profile_id "$T" HD-1080p)"
ok_eq "missing profile → empty"     ""  "$(profile_id "$T" "Remux-2160p")"
ok_eq "no profiles at all → empty"  ""  "$(profile_id '{}' HD-1080p)"

# ─── the server payloads ──────────────────────────────────────────────────────
echo
echo "want_server"
R="$(want_server radarr 4)"
ok_eq "radarr: container name and port" "radarr:7878" "$(jq -r '"\(.hostname):\(.port)"' <<<"$R")"
ok_eq "radarr: its .env key"            "rk"          "$(jq -r .apiKey <<<"$R")"
ok_eq "radarr: HD-1080p by the given id" "4 HD-1080p" "$(jq -r '"\(.activeProfileId) \(.activeProfileName)"' <<<"$R")"
ok_eq "radarr: movies root"   "/mnt/data/streaming/movies" "$(jq -r .activeDirectory <<<"$R")"
ok_eq "radarr: default, not 4K" "true false" "$(jq -r '"\(.isDefault) \(.is4k)"' <<<"$R")"
ok_eq "radarr: released only"   "released"  "$(jq -r .minimumAvailability <<<"$R")"
ok_eq "radarr: LAN link"   "http://192.168.0.86:7878" "$(jq -r .externalUrl <<<"$R")"
ok_eq "radarr: never an id (read-only in writes)" "false" "$(jq 'has("id")' <<<"$R")"
S="$(want_server sonarr 4)"
ok_eq "sonarr: container name and port" "sonarr:8989" "$(jq -r '"\(.hostname):\(.port)"' <<<"$S")"
ok_eq "sonarr: series root"   "/mnt/data/streaming/series" "$(jq -r .activeDirectory <<<"$S")"
ok_eq "sonarr: anime uses the same profile and root" "4 /mnt/data/streaming/series" \
    "$(jq -r '"\(.activeAnimeProfileId) \(.activeAnimeDirectory)"' <<<"$S")"
ok_eq "sonarr: season folders"  "true" "$(jq -r .enableSeasonFolders <<<"$S")"
ok_eq "sonarr: no radarr-only key" "false" "$(jq 'has("minimumAvailability")' <<<"$S")"

# ─── drift ────────────────────────────────────────────────────────────────────
echo
echo "server_drift"
GOT="$(jq -c '. + {id: 1, apiKey: "masked-or-other"}' <<<"$R")"
ok_eq "equal apart from id and apiKey → no drift" "" "$(server_drift "$GOT" "$R")"
ok_eq "profile id changed, name kept → named" "activeProfileId" \
    "$(server_drift "$(jq -c '.activeProfileId = 5' <<<"$GOT")" "$R")"
ok_eq "moved to 4K → named"  "is4k" "$(server_drift "$(jq -c '.is4k = true' <<<"$GOT")" "$R")"

# ─── libraries and sign-in ────────────────────────────────────────────────────
echo
echo "libraries / main / plex"
L='[{"id":"2","name":"Movies","type":"movie","enabled":true},
    {"id":"3","name":"TV Shows","type":"show","enabled":true},
    {"id":"4","name":"Other Videos","type":"movie","enabled":false}]'
ok_eq "enabled = wanted"  "$(wanted_libraries)" "$(enabled_libraries "$L")"
ok_eq "Other Videos is not wanted" "0" "$(wanted_libraries | grep -c 'Other Videos')"
ok_eq "a disabled TV library is visible" "Movies" \
    "$(enabled_libraries "$(jq -c '(.[] | select(.name == "TV Shows") | .enabled) = false' <<<"$L")")"
ok_eq "only the admin signs in" '{"newPlexLogin":false}' "$(want_main)"
ok_eq "Plex through the host gateway, no read-only fields" '{"ip":"host.docker.internal","port":32400,"useSsl":false}' "$(want_plex)"

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
