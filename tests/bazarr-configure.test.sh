#!/usr/bin/env bash
# bazarr-configure.test.sh — unit fixtures for tools/bazarr-configure.sh
#
#   tests/bazarr-configure.test.sh
#
# Offline, and changes nothing: sourced with BAZARR_CONFIGURE_LIB=1 so main()
# never runs. The live behaviour was checked on a throwaway Bazarr 1.6.2
# (linuxserver v1.6.2-ls366) against the real Radarr, Sonarr and Plex:
# - the API key is generated into /config/config/config.yaml (auth.apikey) and
#   works as X-API-KEY with form login on; GET /api/system/settings returns
#   every section with secrets in clear, except auth.password (md5) and the Plex
#   token (encrypted, set through POST /api/plex/apikey)
# - POST /api/system/settings takes a form: settings-<section>-<key>, one pair
#   per list item, languages-enabled, and languages-profiles as JSON, which
#   REPLACES the whole profile list; a written base_url "/" is stored as ""
# - Radarr/Sonarr count as connected once /system/status reports their
#   versions; GET /api/plex/webhook/list succeeds only with a valid Plex token
# - podnapisi no longer exists, and subdivx became subx (API key required)
# - POST /api/movies (radarrid, profileid pairs) gives titles a profile

cd "$(dirname "$0")/.." || exit 1

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export BAZARR_CONFIGURE_LIB=1 RADARR_API_KEY=rk SONARR_API_KEY=sk ARR_USER=admin ARR_PASS='p&ss=1' PLEX_TOKEN=pt
export OPENSUBTITLES_USER="" OPENSUBTITLES_PASS=""
# shellcheck source=SCRIPTDIR/../tools/bazarr-configure.sh
. ./tools/bazarr-configure.sh || { echo "cannot source tools/bazarr-configure.sh"; exit 1; }

PASS=0; FAIL=0
ok_eq() { # label want got
    if [[ "$2" == "$3" ]]; then
        PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"
    else
        FAIL=$((FAIL + 1)); printf '  FAIL  %s\n          want: %q\n          got:  %q\n' "$1" "$2" "$3"
    fi
}

# ─── the API key ──────────────────────────────────────────────────────────────
echo "bazarr_key"
cat > "$TMP/config.yaml" <<'EOF'
---
assrt:
  token: ''
auth:
  apikey: 059777b50de7e69b9a20dbeb07b4deda
  password: ''
  type: null
backup:
  apikey: not-this-one
EOF
ok_eq "auth.apikey from config.yaml"       "059777b50de7e69b9a20dbeb07b4deda" "$(bazarr_key "$TMP/config.yaml")"
printf 'auth:\n  apikey: "abc"\n' > "$TMP/quoted.yaml"
ok_eq "quotes stripped"                    "abc" "$(bazarr_key "$TMP/quoted.yaml")"
printf 'plex:\n  apikey: wrong\n' > "$TMP/noauth.yaml"
ok_eq "another section's apikey → empty"   ""    "$(bazarr_key "$TMP/noauth.yaml")"
ok_eq "missing file → empty, no error"     ""    "$(bazarr_key "$TMP/none.yaml")"

# ─── the wanted settings ──────────────────────────────────────────────────────
echo
echo "want_settings"
W="$(want_settings)"
ok_eq "radarr by container name and port"  "radarr 7878 rk" "$(jq -r '"\(.["radarr.ip"]) \(.["radarr.port"]) \(.["radarr.apikey"])"' <<<"$W")"
ok_eq "sonarr by container name and port"  "sonarr 8989 sk" "$(jq -r '"\(.["sonarr.ip"]) \(.["sonarr.port"]) \(.["sonarr.apikey"])"' <<<"$W")"
ok_eq "unmonitored titles covered (most of the library is)" "false false" \
    "$(jq -r '"\(.["radarr.only_monitored"]) \(.["sonarr.only_monitored"])"' <<<"$W")"
ok_eq "base_url not owned (a written / reads back as \"\")" "false" "$(jq 'has("radarr.base_url") or has("sonarr.base_url")' <<<"$W")"
ok_eq "the one profile is the default for both" "true 1 true 1" \
    "$(jq -r '"\(.["general.movie_default_enabled"]) \(.["general.movie_default_profile"]) \(.["general.serie_default_enabled"]) \(.["general.serie_default_profile"])"' <<<"$W")"
ok_eq "subtitles beside the video"          "current" "$(jq -r '.["general.subfolder"]' <<<"$W")"
ok_eq "embedded es/en tracks count"         "true"    "$(jq -r '.["general.use_embedded_subs"]' <<<"$W")"
ok_eq "Plex through the host gateway"       "host.docker.internal:32400" "$(jq -r '"\(.["plex.ip"]):\(.["plex.port"])"' <<<"$W")"
ok_eq "Plex libraries by name"              '["Movies"] ["TV Shows"]' "$(jq -c '.["plex.movie_library"], .["plex.series_library"]' <<<"$W" | paste -sd' ' -)"
ok_eq "Plex refreshed, added dates untouched" "true true false false" \
    "$(jq -r '"\(.["plex.update_movie_library"]) \(.["plex.update_series_library"]) \(.["plex.set_movie_added"]) \(.["plex.set_episode_added"])"' <<<"$W")"
ok_eq "form login as ARR_USER"              "form admin" "$(jq -r '"\(.["auth.type"]) \(.["auth.username"])"' <<<"$W")"
ok_eq "password compared as Bazarr's md5"   "$(printf '%s' 'p&ss=1' | md5sum | cut -d' ' -f1)" "$(jq -r '.["auth.password"]' <<<"$W")"
ok_eq "no OpenSubtitles without an account" '["subtis","yifysubtitles","subtitulamostv","gestdown"]' \
    "$(jq -c '.["general.enabled_providers"]' <<<"$W")"
ok_eq "…and its login not owned"            "false" "$(jq 'has("opensubtitlescom.username")' <<<"$W")"
WO="$(OPENSUBTITLES_USER=me OPENSUBTITLES_PASS=pw want_settings)"
ok_eq "OpenSubtitles first with an account" "opensubtitlescom" "$(jq -r '.["general.enabled_providers"][0]' <<<"$WO")"
ok_eq "…with its login"                     "me pw" "$(jq -r '"\(.["opensubtitlescom.username"]) \(.["opensubtitlescom.password"])"' <<<"$WO")"
ok_eq "only one of the account fields → off" "false" \
    "$(OPENSUBTITLES_USER=me OPENSUBTITLES_PASS='' want_settings | jq 'has("opensubtitlescom.username")')"

# ─── drift ────────────────────────────────────────────────────────────────────
echo
echo "settings_drift"
# A GET /system/settings response that matches: nest the flat keys.
GOT="$(jq -c 'reduce to_entries[] as $e ({}; setpath($e.key | split("."); $e.value))
    | .general.auto_update = true | .radarr.base_url = ""' <<<"$W")"
ok_eq "match, unowned keys ignored → no drift" "" "$(settings_drift "$GOT" "$W")"
ok_eq "a changed port → named" "radarr.port" "$(settings_drift "$(jq -c '.radarr.port = 7879' <<<"$GOT")" "$W")"
ok_eq "providers reordered → named" "general.enabled_providers" \
    "$(settings_drift "$(jq -c '.general.enabled_providers |= reverse' <<<"$GOT")" "$W")"
ok_eq "a missing section → its keys named" "auth.type auth.username auth.password" \
    "$(settings_drift "$(jq -c 'del(.auth)' <<<"$GOT")" "$W" | paste -sd' ' -)"
ok_eq "fresh install (defaults) → drift" "1" \
    "$(settings_drift '{"general":{"use_radarr":false}}' "$W" | grep -cx general.use_radarr)"

# ─── the form ─────────────────────────────────────────────────────────────────
echo
echo "form_body"
F="$(form_body "$W" "$(printf '%s\n' auth.password general.enabled_providers radarr.port general.use_radarr plex.series_library)")"
ok_eq "plain password, url-encoded (Bazarr hashes it)" "1" "$(tr '&' '\n' <<<"$F" | grep -cx 'settings-auth-password=p%26ss%3D1')"
ok_eq "one pair per list item" "4" "$(tr '&' '\n' <<<"$F" | grep -c '^settings-general-enabled_providers=')"
ok_eq "numbers and booleans as text" "settings-radarr-port=7878 settings-general-use_radarr=true" \
    "$(tr '&' '\n' <<<"$F" | grep -E 'radarr-port|use_radarr' | paste -sd' ' -)"
ok_eq "only the first dot becomes a dash; spaces encoded" "settings-plex-series_library=TV%20Shows" \
    "$(tr '&' '\n' <<<"$F" | grep series_library)"
ok_eq "nothing drifted → empty body" "" "$(form_body "$W" "")"

# ─── languages ────────────────────────────────────────────────────────────────
echo
echo "languages and profiles"
P="$(want_profiles)"
ok_eq "one profile, id 1, es then en" '1 Spanish + English es,en' \
    "$(jq -r '.[] | "\(.profileId) \(.name) \([.items[].language] | join(","))"' <<<"$P")"
ok_eq "plain subtitles: not forced, not hearing-impaired" "False" \
    "$(jq -r '[.[0].items[] | .forced, .hi] | unique | join(",")' <<<"$P")"
# As GET returns it: originalFormat 0, items as stored.
STORED="$(jq -c '.[0].originalFormat = 0' <<<"$P")"
if profiles_drift "$STORED"; then r=drift; else r=same; fi
ok_eq "stored form (originalFormat 0) → same" "same" "$r"
if profiles_drift '[]'; then r=drift; else r=same; fi
ok_eq "no profiles (fresh) → drift" "drift" "$r"
if profiles_drift "$(jq -c '. + [.[0] | .profileId = 2 | .name = "Extra"]' <<<"$P")"; then r=drift; else r=same; fi
ok_eq "an extra profile from the WebUI → drift (the script owns all)" "drift" "$r"
if profiles_drift "$(jq -c '.[0].items |= reverse' <<<"$P")"; then r=drift; else r=same; fi
ok_eq "en before es → drift" "drift" "$r"
L='[{"code2":"en","enabled":true},{"code2":"es","enabled":true},{"code2":"fr","enabled":false}]'
ok_eq "enabled = wanted" "$(wanted_langs)" "$(enabled_langs "$L")"
ok_eq "a third enabled language is visible" "en es fr" \
    "$(enabled_langs "$(jq -c '.[2].enabled = true' <<<"$L")" | paste -sd' ' -)"

# ─── titles without a profile ─────────────────────────────────────────────────
echo
echo "unprofiled"
M='{"data":[{"radarrId":4,"profileId":1},{"radarrId":9,"profileId":null},{"radarrId":12,"profileId":null}]}'
ok_eq "movies with none, by radarrId" "9 12" "$(unprofiled "$M" radarrId | paste -sd' ' -)"
ok_eq "all profiled → none" "" "$(unprofiled '{"data":[{"sonarrSeriesId":1,"profileId":1}]}' sonarrSeriesId)"

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
