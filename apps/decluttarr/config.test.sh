#!/usr/bin/env bash
# apps/decluttarr/config.test.sh — guards apps/decluttarr/config.yaml and its compose service
#
#   apps/decluttarr/config.test.sh
#
# Offline, and changes nothing: reads the two files as text.
#
# Decluttarr turns a job ON as soon as its key is listed under `jobs:`, even with
# no value, and the jobs left out (remove_orphans, remove_unmonitored, ...) would
# remove torrents that are seeding or that arr-reclaim is meant to judge. So the
# enabled set is pinned here, exactly. The behaviour — a listed job with no value
# enabled, three strikes then removal on the fourth check, the removal going
# through the arr queue as blocklist + downloadFailed + a new search, !ENV for
# secrets and test_run, remove_slow reading qBittorrent's dl_rate_limit, and the
# detect_deletions watcher starting even when unlisted — was checked against a
# throwaway Decluttarr v2.1.0 with a throwaway Radarr and qBittorrent 5.2.

cd "$(dirname "$0")/../.." || exit 1

CONF=apps/decluttarr/config.yaml
PASS=0; FAIL=0

ok_eq() { # label want got
    if [[ "$2" == "$3" ]]; then
        PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"
    else
        FAIL=$((FAIL + 1)); printf '  FAIL  %s\n          want: %q\n          got:  %q\n' "$1" "$2" "$3"
    fi
}

# Keys directly under a top-level section, comments and blank lines skipped.
section_keys() { # section
    awk -v s="$1:" '
        /^[^ #]/          { in_s = ($1 == s); next }
        in_s && /^  [a-z_]+:/ { k = $1; sub(/:$/, "", k); print k }
    ' "$CONF"
}

# The value of "  key: value" inside a top-level section (first match).
section_value() { # section key
    awk -v s="$1:" -v k="$2:" '
        /^[^ #]/ { in_s = ($1 == s); next }
        in_s && $1 == k { $1 = ""; sub(/^ /, ""); sub(/[ ]+#.*$/, ""); print; exit }
    ' "$CONF"
}

# The decluttarr service block of apps/decluttarr/compose.yaml.
compose_block() {
    awk '/^  decluttarr:/ { on = 1; print; next }
         on && /^[^ #]/   { exit }
         on               { print }' apps/decluttarr/compose.yaml
}

[[ -f "$CONF" ]] || { echo "missing $CONF"; exit 1; }

# ─── jobs ─────────────────────────────────────────────────────────────────────
echo "jobs"
ok_eq "exactly stalled, slow and missing metadata — nothing else" \
    "remove_metadata_missing remove_slow remove_stalled" "$(section_keys jobs | sort | paste -sd' ')"
for j in remove_orphans remove_unmonitored remove_missing_files remove_failed_imports \
         remove_failed_downloads remove_bad_files remove_done_seeding \
         search_missing search_unmet_cutoff detect_deletions; do
    ok_eq "$j is not listed (listed = on)" "0" "$(grep -cE "^[[:space:]]+$j:" "$CONF")"
done
ok_eq "slow means under 500 KB/s"        "500" \
    "$(awk '/^  remove_slow:/ {on=1; next} on && /^  [a-z]/ {exit} on && $1 == "min_speed:" {print $2}' "$CONF")"
ok_eq "three strikes before a removal"   "3"   "$(section_value job_defaults max_strikes)"

# ─── general ──────────────────────────────────────────────────────────────────
echo
echo "general"
ok_eq "test mode comes from the environment" "!ENV DECLUTTARR_TEST_RUN" "$(section_value general test_run)"
ok_eq "a check every 10 minutes"             "10" "$(section_value general timer)"

# ─── instances and secrets ────────────────────────────────────────────────────
echo
echo "instances"
ok_eq "radarr and sonarr, by service name" "http://radarr:7878 http://sonarr:8989" \
    "$(grep -oE 'base_url: "http://(radarr|sonarr):[0-9]+"' "$CONF" | sed 's/.*"\(.*\)"/\1/' | paste -sd' ')"
ok_eq "the :8081 qBittorrent, by its allowlisted name" "1" \
    "$(grep -c 'base_url: "http://qbittorrent:8081"' "$CONF")"
ok_eq "named as the arrs know it" "1" "$(grep -c 'name: "qBittorrent"' "$CONF")"
ok_eq "every secret is !ENV, none inline" "4 0" \
    "$(grep -cE '(api_key|username|password): !ENV [A-Z_]+$' "$CONF") $(grep -E '(api_key|username|password):' "$CONF" | grep -vc '!ENV')"

# ─── compose ──────────────────────────────────────────────────────────────────
echo
echo "compose service"
B="$(compose_block)"
ok_eq "service exists"                    "1" "$(grep -c '^  decluttarr:' <<<"$B")"
ok_eq "pinned to a v2 release, not latest" "1" "$(grep -cE 'image: ghcr.io/manimatter/decluttarr:v2\.[0-9]+\.[0-9]+$' <<<"$B")"
ok_eq "config mounted read-only"          "1" "$(grep -c '\./config.yaml:/app/config/config.yaml:ro' <<<"$B")"
# detect_deletions runs whether listed or not; without the library mounted it
# has nothing to watch.
ok_eq "no /mnt/data mount"                "0" "$(grep -c '/mnt/data' <<<"$B")"
# shellcheck disable=SC2016  # the literal compose interpolation is what is matched
ok_eq "test mode off unless asked"        "1" "$(grep -cF 'DECLUTTARR_TEST_RUN: ${DECLUTTARR_TEST_RUN:-false}' <<<"$B")"

# ─── summary ──────────────────────────────────────────────────────────────────
echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
