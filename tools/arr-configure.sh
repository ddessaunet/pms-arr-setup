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
# What this deliberately never does: import or rename media. Phase 8 did that
# once for the existing library (branch feat/library-import); renaming below
# applies to each new import.
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

# Size caps, in MB per minute of runtime (the unit both apps use), as
# quality<TAB>max<TAB>preferred. /mnt/data runs near full: the defaults let
# Radarr take Bluray-1080p and Remux-1080p at ANY size (the 10 GB Night of the
# Living Dead grab) and offered a 31.5 GB Iron Man 2 pack.
#   1080p  40 / 25   ~4.8 GB max, ~3 GB preferred for a 2-hour film; ~1.8 GB
#                    max for a 45-minute episode
#   2160p 150 / 100  ~18 GB max, ~12 GB preferred for a 2-hour film: most 4K
#                    HDR WEB-DLs, not the 30-60 GB 4K Bluray encodes
# Sizes are owned here, not by Recyclarr (its quality_definition is omitted).
size_caps() {
    case "$1" in
        radarr) printf '%s\t%s\t%s\n' \
                    HDTV-1080p 40 25   WEBDL-1080p 40 25   WEBRip-1080p 40 25   Bluray-1080p 40 25 \
                    HDTV-2160p 150 100 WEBDL-2160p 150 100 WEBRip-2160p 150 100 Bluray-2160p 150 100 ;;
        sonarr) printf '%s\t%s\t%s\n' \
                    HDTV-1080p 40 25   WEBRip-1080p 40 25  WEBDL-1080p 40 25    Bluray-1080p 40 25 ;;
    esac
}
size_capped() { size_caps "$1" | cut -f1; }

# The default profile for new adds (created by Recyclarr, recyclarr/recyclarr.yml;
# seerr-configure.sh points requests at the same one), and the profiles allowed
# to upgrade — every other profile is kept at no-upgrade.
default_profile() { case "$1" in radarr) echo "UHD Bluray + WEB" ;; sonarr) echo "WEB-1080p" ;; esac; }
upgrade_profiles() { case "$1" in radarr) echo "UHD Bluray + WEB" ;; sonarr) : ;; esac; }

# ─── pure helpers (tests/arr-configure.test.sh) ───────────────────────────────

# Quality definitions (a /qualitydefinition list) whose caps differ from ours,
# returned already capped — ready to PUT to /qualitydefinition/update.
sizes_to_fix() { # definitions-json caps(title<TAB>max<TAB>preferred lines)
    jq -c --arg c "$2" '
        ($c | split("\n") | map(select(. != "") | split("\t"))
            | map({key: .[0], value: {max: (.[1] | tonumber), pref: (.[2] | tonumber)}}) | from_entries) as $caps
        | [.[] | select($caps[.title]) | . as $d | $caps[$d.title] as $w
               | select($d.maxSize != $w.max or $d.preferredSize != $w.pref)
               | .maxSize = $w.max | .preferredSize = $w.pref]' <<<"$1"
}

# Profiles whose upgradeAllowed differs from what we want, already corrected:
# true for the names in $2 (newline-separated), false for every other profile.
upgrades_to_fix() { # profiles-json allowed-names
    jq -c --arg a "$2" '($a | split("\n") | map(select(. != ""))) as $ok
        | [.[] | (.name as $n | $ok | index($n) != null) as $want
               | select(.upgradeAllowed != $want) | .upgradeAllowed = $want]' <<<"$1"
}

# A quality profile with every Remux quality disallowed, at any depth (groups
# included). Remux-1080p is a 15-40 GB rip of the disc: never on this disk.
profile_without_remux() {
    jq -c 'walk(if type == "object" and ((.quality.name? // "") | test("Remux"))
                then .allowed = false else . end)' <<<"$1"
}
profile_allows_remux() {
    [[ "$(jq '[.. | objects | select(.allowed == true and ((.quality.name? // "") | test("Remux")))] | length' <<<"$1")" -gt 0 ]]
}

# The distinct "Minimum Seeders" of an /indexer list, e.g. "5" or "1,5" while a
# Prowlarr sync is still on its way (MIN_SEEDERS, prowlarr-configure.sh).
indexer_min_seeders() { # indexers-json
    jq -r '[.[] | .fields[]? | select(.name == "minimumSeeders") | .value // "unset"
            | tostring] | unique | join(",") | if . == "" then "unset" else . end' <<<"$1"
}

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
# Upgrades only where upgrade_profiles says (the 4K movie profile); an upgrade
# replaces a library file, so everything else stays single-grab.
apply_profiles() { # app
    local p n=0
    get /qualityprofile || { log "  FAIL  read quality profiles (HTTP $HTTP)"; return 1; }
    while IFS= read -r p; do
        [[ -n "$p" ]] || continue
        api PUT "/qualityprofile/$(jq -r .id <<<"$p")" < <(printf '%s' "$p") \
            || { log "  FAIL  profile $(jq -r .name <<<"$p") (HTTP $HTTP)"; return 1; }
        log "  upgrades $(jq -r 'if .upgradeAllowed then "on" else "off" end' <<<"$p") for $(jq -r .name <<<"$p")"
        n=$((n + 1))
    done < <(upgrades_to_fix "$(body)" "$(upgrade_profiles "$1")" | jq -c '.[]')
    [[ "$n" -gt 0 ]] || log "  upgrades already only on: $(upgrade_profiles "$1" | paste -sd, - | sed 's/^$/(none)/')"
}

# The capped definitions, each read by id. Radarr 6.4 reports quality sizes a
# few seconds late after a write — both the list and by-id reads — which made
# a successful update read back as DRIFT; verify_sizes waits that out.
capped_definitions() { # app
    local ids id out="["
    get /qualitydefinition || return 1
    ids="$(body | jq -r --arg t "$(size_capped "$1")" \
        '($t | split("\n") | map(select(. != ""))) as $ts | .[] | select(.title as $x | $ts | index($x)) | .id')"
    for id in $ids; do
        get "/qualitydefinition/$id" || return 1
        out+="$(body),"
    done
    printf '%s' "${out%,}]"
}

# Up to SIZE_SETTLE re-reads, 2 s apart, before a difference counts as drift.
SIZE_SETTLE="${SIZE_SETTLE:-5}"
verify_sizes() { # app
    local defs n try=0
    while :; do
        defs="$(capped_definitions "$1")" || { log "  FAIL  read quality definitions"; return 1; }
        n="$(sizes_to_fix "$defs" "$(size_caps "$1")" | jq length)"
        [[ "$n" -eq 0 ]] && { log "  ok       sizes capped: $(sizes_summary "$1")"; return 0; }
        (( ++try < SIZE_SETTLE )) || break
        sleep 2
    done
    log "  DRIFT    $n quality size(s) not capped ($(sizes_summary "$1"))"
    return 1
}

# "1080p 40/25, 2160p 150/100 MB/min" for the log.
sizes_summary() {
    size_caps "$1" | awk -F'\t' '{r=$1; sub(/.*-/, "", r); if (!(r in s)) {s[r]=$2"/"$3; o[++n]=r}}
        END {for (i=1; i<=n; i++) printf "%s%s %s", (i>1 ? ", " : ""), o[i], s[o[i]]; printf " MB/min"}'
}

apply_sizes() { # app
    local fix n
    local defs
    defs="$(capped_definitions "$1")" || { log "  FAIL  read quality definitions (HTTP $HTTP)"; return 1; }
    fix="$(sizes_to_fix "$defs" "$(size_caps "$1")")"
    n="$(jq length <<<"$fix")"
    if [[ "$n" -eq 0 ]]; then log "  sizes already capped ($(sizes_summary "$1"))"; return 0; fi
    api PUT /qualitydefinition/update < <(printf '%s' "$fix") \
        || { log "  FAIL  quality sizes (HTTP $HTTP): $(api_error)"; return 1; }
    log "  sizes capped: $(sizes_summary "$1") ($n quality/ies changed)"
}

apply_no_remux() { # app
    local p name; name="$(default_profile "$1")"
    get /qualityprofile || { log "  FAIL  read quality profiles (HTTP $HTTP)"; return 1; }
    p="$(body | jq -c --arg n "$name" '.[] | select(.name == $n)')"
    # Recyclarr creates it; say so rather than fail the rest of the settings.
    [[ -n "$p" ]] || { log "  WARN  no '$name' profile yet — run npm run recyclarr:sync first"; return 0; }
    if ! profile_allows_remux "$p"; then log "  $name already without Remux"; return 0; fi
    api PUT "/qualityprofile/$(jq -r .id <<<"$p")" < <(profile_without_remux "$p") \
        || { log "  FAIL  $name profile (HTTP $HTTP): $(api_error)"; return 1; }
    log "  Remux removed from $name"
}

apply_app() { # app
    apply_host &&
    apply_config "$1" naming "$(want_naming "$1")" &&
    apply_config "$1" mediamanagement "$(want_media "$1")" &&
    apply_root "$1" &&
    apply_profiles "$1" &&
    apply_no_remux "$1" &&
    apply_sizes "$1" &&
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
    local profiles allowed p dp
    profiles="$(body)"; allowed="$(upgrade_profiles "$1")"
    n="$(upgrades_to_fix "$profiles" "$allowed" | jq length)"
    if [[ "$n" -eq 0 ]]; then log "  ok       upgrades only on: $(paste -sd, - <<<"$allowed" | sed 's/^$/(none)/')"
    else log "  DRIFT    $n profile(s) with upgrades set the wrong way: $(upgrades_to_fix "$profiles" "$allowed" | jq -r '[.[].name] | join(", ")')"; rc=1; fi

    dp="$(default_profile "$1")"
    p="$(jq -c --arg n "$dp" '.[] | select(.name == $n)' <<<"$profiles")"
    if [[ -z "$p" ]]; then log "  DRIFT    default profile '$dp' missing — npm run recyclarr:sync"; rc=1
    elif profile_allows_remux "$p"; then log "  DRIFT    '$dp' allows Remux"; rc=1
    else log "  ok       default profile '$dp' exists, no Remux"; fi

    verify_sizes "$1" || rc=1

    verify_resource "download client" downloadclient QBittorrent "$(want_client_top)" "$(want_client_fields "$1")" || rc=1
    verify_resource "Plex connection" notification PlexServer "$(want_plex_top "$1")" "$(want_plex_fields)" || rc=1

    # Pushed by Prowlarr, not by this script: only reported.
    get /indexer || { log "  FAIL  read indexers"; return 1; }
    n="$(body | jq length)"
    if [[ "$n" -gt 0 ]]; then log "  ok       $n indexer(s), synced from Prowlarr, minimum seeders $(indexer_min_seeders "$(body)")"
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
