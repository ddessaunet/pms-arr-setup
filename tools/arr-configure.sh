#!/usr/bin/env bash
# arr-configure.sh — apply Radarr's and Sonarr's settings through their APIs,
# then read them back and test the connections. Idempotent.
#
#   tools/arr-configure.sh [radarr|sonarr|all]            apply, then verify
#   tools/arr-configure.sh [radarr|sonarr|all] --check    verify only; changes nothing
#
# Normally reached through npm: `npm run arr:configure` / `npm run arr:check`.
#
# The API keys are not set here: compose passes RADARR_API_KEY / SONARR_API_KEY
# from .env as <APP>__AUTH__APIKEY, so they are fixed before the first start and
# Prowlarr can push indexers to both (prowlarr-configure.sh, APPLICATIONS).
# Indexers are therefore NOT managed here.
#
# What this deliberately never does: import the existing library, or run a
# rename. Until pms-local's plex-watch is retired (Phase 7) any move under
# /mnt/data/streaming reads as a Plex deletion and costs a native torrent; the
# library is cleaned up in Phase 8. Renaming below applies to NEW imports only.
#
# Exit: 0 applied and verified (or no drift; a FAILING connection test only
# warns) · 1 drift, or a step failed · 2 usage · 3 unreachable/not configured.

set -uo pipefail

REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
# shellcheck source=SCRIPTDIR/lib/servarr.sh
. "$REPO/tools/lib/servarr.sh" || { echo "cannot load tools/lib/servarr.sh" >&2; exit 3; }

ARR_USER="${ARR_USER:-$(env_get ARR_USER)}"
ARR_PASS="${ARR_PASS:-$(env_get ARR_PASS)}"
QBT_ARR_USER="${QBT_ARR_USER:-$(env_get QBT_ARR_USER)}"
QBT_ARR_PASS="${QBT_ARR_PASS:-$(env_get QBT_ARR_PASS)}"
PLEX_TOKEN="${PLEX_TOKEN:-$(env_get PLEX_TOKEN)}"
ARR_TIMEOUT="${ARR_TIMEOUT:-60}"
ARR_WAIT="${ARR_WAIT:-90}"

# ─── the settings ─────────────────────────────────────────────────────────────
# Per app: port, root folder, and the field names that differ between the two.
app_port()     { case "$1" in radarr) echo 7878 ;; sonarr) echo 8989 ;; esac; }
app_root()     { case "$1" in radarr) echo /mnt/data/streaming/movies ;; sonarr) echo /mnt/data/streaming/series ;; esac; }
app_key_var()  { case "$1" in radarr) echo RADARR_API_KEY ;; sonarr) echo SONARR_API_KEY ;; esac; }
app_url()      { local v="${1^^}_URL"; printf '%s' "${!v:-http://127.0.0.1:$(app_port "$1")}"; }

# Plex-friendly names for new imports. Existing files are never renamed.
want_naming() {
    case "$1" in
        radarr) jq -cn '{
            renameMovies:       true,
            movieFolderFormat:  "{Movie Title} ({Release Year})",
            standardMovieFormat:"{Movie Title} ({Release Year})"
        }' ;;
        sonarr) jq -cn '{
            renameEpisodes:        true,
            seriesFolderFormat:    "{Series Title}",
            seasonFolderFormat:    "Season {season:00}",
            standardEpisodeFormat: "{Series Title} - S{season:00}E{episode:00}"
        }' ;;
    esac
}

# recycleBin empty: a recycle is a MOVE under streaming/, which pms-local's
# plex-watch reads as a deletion. Deleted-in-Plex media is unmonitored, never
# re-grabbed. 10 GB floor: /mnt/data runs near full.
want_media() {
    local unmon
    case "$1" in
        radarr) unmon=autoUnmonitorPreviouslyDownloadedMovies ;;
        sonarr) unmon=autoUnmonitorPreviouslyDownloadedEpisodes ;;
    esac
    jq -cn --arg u "$unmon" '{
        copyUsingHardlinks:            true,
        recycleBin:                    "",
        deleteEmptyFolders:            false,
        importExtraFiles:              true,
        extraFileExtensions:           "srt",
        minimumFreeSpaceWhenImporting: 10000
    } + {($u): true}'
}

# The :8081 qBittorrent (Phase 2), one category per app. Remove Completed:
# once qBittorrent stops a torrent at its seeding limit, the app removes it
# with its data — the library keeps its own hardlink.
want_client_fields() {
    local cat
    case "$1" in radarr) cat=movieCategory ;; sonarr) cat=tvCategory ;; esac
    jq -cn --arg c "$cat" --arg v "$1" --arg u "$QBT_ARR_USER" \
        '{host: "qbittorrent", port: 8081, useSsl: false, username: $u} + {($c): $v}'
}
want_client_top() { jq -cn '{name: "qBittorrent", enable: true, removeCompletedDownloads: true, removeFailedDownloads: true}'; }

# Plex on the host network, reached through the host gateway.
want_plex_fields() { jq -cn '{host: "host.docker.internal", port: 32400, useSsl: false, updateLibrary: true}'; }
want_plex_top() {
    case "$1" in
        radarr) jq -cn '{name: "Plex", onDownload: true, onUpgrade: true, onRename: true,
                         onMovieDelete: true, onMovieFileDelete: true, onMovieFileDeleteForUpgrade: true}' ;;
        sonarr) jq -cn '{name: "Plex", onDownload: true, onUpgrade: true, onRename: true, onImportComplete: true,
                         onSeriesDelete: true, onEpisodeFileDelete: true, onEpisodeFileDeleteForUpgrade: true}' ;;
    esac
}

# ─── pure helpers (tests/arr-configure.test.sh) ───────────────────────────────

# fields_set, fields_drift, resource_want, resource_drift: tools/lib/servarr.sh

# ─── apply ────────────────────────────────────────────────────────────────────
apply_config() { # app section want-json
    local cur drift
    get "/config/$2" || { log "  FAIL  read $2 config (HTTP $HTTP)"; return 1; }
    cur="$(body)"; drift="$(host_drift "$cur" "$3")"
    if [[ -z "$drift" ]]; then log "  $2 already set"; return 0; fi
    api PUT "/config/$2/$(jq -r .id <<<"$cur")" < <(jq -c --argjson w "$3" '. + $w' <<<"$cur") \
        || { log "  FAIL  $2 config (HTTP $HTTP): $(api_error)"; return 1; }
    log "  $2 set ($(tr '\n' ' ' <<<"$drift"| sed 's/ $//'))"
}

apply_root() { # app
    local root; root="$(app_root "$1")"
    get /rootfolder || { log "  FAIL  read root folders (HTTP $HTTP)"; return 1; }
    if body | jq -e --arg p "$root" 'any(.[]; .path == $p or .path == ($p + "/"))' >/dev/null; then
        log "  root folder $root already set"; return 0
    fi
    api POST /rootfolder < <(jq -cn --arg p "$root" '{path: $p}') \
        || { log "  FAIL  root folder $root (HTTP $HTTP): $(api_error)"; return 1; }
    log "  root folder $root added"
}

# No upgrades on any profile until Recyclarr (Phase 6): an upgrade deletes
# the old library file, which plex-watch reads as a Plex deletion.
apply_profiles() {
    local p n=0
    get /qualityprofile || { log "  FAIL  read quality profiles (HTTP $HTTP)"; return 1; }
    while IFS= read -r p; do
        [[ -n "$p" ]] || continue
        api PUT "/qualityprofile/$(jq -r .id <<<"$p")" < <(jq -c '.upgradeAllowed = false' <<<"$p") \
            || { log "  FAIL  profile $(jq -r .name <<<"$p") (HTTP $HTTP)"; return 1; }
        n=$((n + 1))
    done < <(body | jq -c '.[] | select(.upgradeAllowed == true)')
    if [[ "$n" -eq 0 ]]; then log "  quality profiles already without upgrades"
    else log "  upgrades turned off on $n profile(s)"; fi
}

apply_app() { # app
    apply_host &&
    apply_config "$1" naming "$(want_naming "$1")" &&
    apply_config "$1" mediamanagement "$(want_media "$1")" &&
    apply_root "$1" &&
    apply_profiles &&
    apply_resource "download client" downloadclient QBittorrent \
        "$(want_client_top)" "$(want_client_fields "$1")" password "$QBT_ARR_PASS" &&
    apply_resource "Plex connection" notification PlexServer \
        "$(want_plex_top "$1")" "$(want_plex_fields)" authToken "$PLEX_TOKEN"
}

# ─── verify ───────────────────────────────────────────────────────────────────
verify_config() { # section want-json
    local drift
    get "/config/$1" || { log "  FAIL  read $1 config (HTTP $HTTP)"; return 1; }
    drift="$(host_drift "$(body)" "$2")"
    if [[ -z "$drift" ]]; then log "  ok       $1"
    else log "  DRIFT    $1: $(tr '\n' ' ' <<<"$drift")"; return 1; fi
}

verify_app() { # app
    local rc=0 root n
    verify_host || rc=1
    verify_config naming "$(want_naming "$1")" || rc=1
    verify_config mediamanagement "$(want_media "$1")" || rc=1

    root="$(app_root "$1")"
    get /rootfolder || { log "  FAIL  read root folders"; return 1; }
    if body | jq -e --arg p "$root" 'any(.[]; .path == $p or .path == ($p + "/"))' >/dev/null; then
        log "  ok       root folder $root"
    else log "  DRIFT    root folder $root missing"; rc=1; fi

    get /qualityprofile || { log "  FAIL  read quality profiles"; return 1; }
    n="$(body | jq '[.[] | select(.upgradeAllowed == true)] | length')"
    if [[ "$n" -eq 0 ]]; then log "  ok       no quality profile allows upgrades"
    else log "  DRIFT    $n quality profile(s) allow upgrades"; rc=1; fi

    verify_resource "download client" downloadclient QBittorrent "$(want_client_top)" "$(want_client_fields "$1")" || rc=1
    verify_resource "Plex connection" notification PlexServer "$(want_plex_top "$1")" "$(want_plex_fields)" || rc=1

    # Pushed by Prowlarr, not by this script: only reported.
    get /indexer || { log "  FAIL  read indexers"; return 1; }
    n="$(body | jq length)"
    if [[ "$n" -gt 0 ]]; then log "  ok       $n indexer(s), synced from Prowlarr"
    else log "  WARN     no indexers yet — npm run prowlarr:configure pushes them"; fi
    return "$rc"
}

# ─── main ─────────────────────────────────────────────────────────────────────
run_app() { # app mode
    local app="$1" mode="$2" keyvar
    keyvar="$(app_key_var "$app")"
    SVC_NAME="$app" SVC_API=v3 SVC_URL="$(app_url "$app")"
    SVC_KEY="${!keyvar:-$(env_get "$keyvar")}"
    SVC_USER="$ARR_USER" SVC_PASS="$ARR_PASS" SVC_TIMEOUT="$ARR_TIMEOUT" SVC_WAIT="$ARR_WAIT"
    [[ -n "$SVC_KEY" ]] || { log "$app: $keyvar is not set in .env"; return 3; }

    log "${app^} at $SVC_URL ($mode)"
    if ! wait_ready; then
        log "  FAIL  not answering with $keyvar (HTTP $HTTP) — is it running, and started with this key?"
        return 3
    fi
    log "  API up: $(body | jq -r .version)"
    if [[ "$mode" == apply ]]; then apply_app "$app" || return 1; fi
    log "Read-back:"
    verify_app "$app" || return 1
    log "No drift."
}

main() {
    local mode=apply target=all arg
    for arg in "$@"; do
        case "$arg" in
            --check)             mode=check ;;
            radarr|sonarr|all)   target="$arg" ;;
            -h|--help)           sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
            *)                   echo "usage: ${0##*/} [radarr|sonarr|all] [--check]" >&2; exit 2 ;;
        esac
    done

    local k missing=()
    for k in ARR_USER ARR_PASS QBT_ARR_USER QBT_ARR_PASS PLEX_TOKEN; do [[ -n "${!k}" ]] || missing+=("$k"); done
    if [[ ${#missing[@]} -gt 0 ]]; then echo "Set ${missing[*]} in $REPO/.env." >&2; exit 3; fi

    BODY="$(mktemp)"; trap 'rm -f "$BODY"' EXIT

    local apps=(radarr sonarr) rc=0 worst=0 a
    [[ "$target" == all ]] || apps=("$target")
    for a in "${apps[@]}"; do
        run_app "$a" "$mode"; rc=$?
        (( rc > worst )) && worst=$rc
        echo
    done
    [[ "$worst" -eq 1 && "$mode" == check ]] && log "To apply: npm run arr:configure"
    exit "$worst"
}

[[ "${ARR_CONFIGURE_LIB:-0}" == "1" ]] || main "$@"
