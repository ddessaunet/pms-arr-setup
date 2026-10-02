#!/usr/bin/env bash
# arr-fallback-search.sh — ask Radarr to search again for the movies on the
# "4K HDR or 1080p" profile that have no 4K file yet.
#
#   tools/arr-fallback-search.sh              queue one search for them
#   tools/arr-fallback-search.sh --dry-run    list them; changes nothing
#
# Normally reached through npm (`npm run arr:fallback-search` / `:dry`) or the
# daily systemd/arr-fallback-search.timer.
#
# Radarr searches a movie in full only when it is added; after that it sees new
# releases through RSS alone, every 30 minutes. A 4K HDR release that was turned
# away at the time (too few seeders), was posted while the box was down, or sits
# on an indexer with a poor feed is never found. This closes that gap for the
# fallback profile only: monitored, released movies with a 1080p file, or none.
# Movies already in 4K are left to RSS, as on the default profile.
#
# Exit: 0 searched, or nothing to search · 1 the profile is missing, or the
# search was refused · 2 usage · 3 unreachable/not configured.

set -uo pipefail

REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
# shellcheck source=SCRIPTDIR/lib/servarr.sh
. "$REPO/tools/lib/servarr.sh" || { echo "cannot load tools/lib/servarr.sh" >&2; exit 3; }

# Created by Recyclarr (recyclarr/recyclarr.yml); arr-configure.sh keeps its
# upgrades on (upgrade_profiles).
FALLBACK_PROFILE="4K HDR or 1080p"

# ─── pure helpers (tests/arr-fallback-search.test.sh) ─────────────────────────

# The id of a quality profile by name, from a /qualityprofile list.
profile_id_of() { # profiles-json name
    jq -r --arg n "$2" '[.[] | select(.name == $n) | .id][0] // empty' <<<"$1"
}

# Ids of the monitored, released movies on profile $2 without a 2160p file. A
# movie with no file at all counts: it is the case "always get something" is for.
fallback_ids() { # movies-json profile-id
    jq -c --argjson p "$2" '[.[] | select(.qualityProfileId == $p and .monitored and .isAvailable)
        | select((.movieFile.quality.quality.resolution // 0) < 2160) | .id]' <<<"$1"
}

# "Title (Year) — 1080p" lines for the log, for the ids in $2.
fallback_titles() { # movies-json ids-json
    jq -r --argjson ids "$2" '.[] | select(.id as $i | $ids | index($i))
        | "\(.title) (\(.year)) — \(.movieFile.quality.quality.name // "no file")"' <<<"$1"
}

# ─── main ─────────────────────────────────────────────────────────────────────
main() {
    local dry=0 arg
    for arg in "$@"; do
        case "$arg" in
            --dry-run) dry=1 ;;
            -h|--help) sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
            *)         echo "usage: ${0##*/} [--dry-run]" >&2; exit 2 ;;
        esac
    done

    # shellcheck disable=SC2034  # read by the sourced library
    SVC_NAME=radarr SVC_API=v3 SVC_URL="${RADARR_URL:-http://127.0.0.1:7878}" \
        SVC_TIMEOUT="${ARR_TIMEOUT:-60}" SVC_WAIT="${ARR_WAIT:-90}"
    SVC_KEY="${RADARR_API_KEY:-$(env_get RADARR_API_KEY)}"
    [[ -n "$SVC_KEY" ]] || { log "RADARR_API_KEY is not set in $REPO/.env"; exit 3; }

    BODY="$(mktemp)"; trap 'rm -f "$BODY"' EXIT

    if ! wait_ready; then
        log "Radarr at $SVC_URL is not answering with RADARR_API_KEY (HTTP $HTTP)"
        exit 3
    fi

    get /qualityprofile || { log "FAIL  read quality profiles (HTTP $HTTP)"; exit 1; }
    local pid
    pid="$(profile_id_of "$(body)" "$FALLBACK_PROFILE")"
    [[ -n "$pid" ]] || { log "No '$FALLBACK_PROFILE' profile in Radarr — npm run recyclarr:sync"; exit 1; }

    get /movie || { log "FAIL  read movies (HTTP $HTTP)"; exit 1; }
    local movies ids n
    movies="$(body)"
    ids="$(fallback_ids "$movies" "$pid")"
    n="$(jq length <<<"$ids")"
    if [[ "$n" -eq 0 ]]; then
        log "Nothing to search: no monitored '$FALLBACK_PROFILE' movie is without a 4K file."
        exit 0
    fi

    log "$n '$FALLBACK_PROFILE' movie(s) without a 4K file:"
    fallback_titles "$movies" "$ids" | sed 's/^/  /'
    if [[ "$dry" == 1 ]]; then log "Dry run: nothing searched."; exit 0; fi

    api POST /command < <(jq -cn --argjson ids "$ids" '{name: "MoviesSearch", movieIds: $ids}') \
        || { log "FAIL  queue the search (HTTP $HTTP): $(api_error)"; exit 1; }
    log "Search queued (Radarr command $(body | jq -r .id)); grabs show in Radarr's queue."
}

[[ "${ARR_FALLBACK_SEARCH_LIB:-0}" == "1" ]] || main "$@"
