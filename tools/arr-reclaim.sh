#!/usr/bin/env bash
# arr-reclaim.sh — when media Radarr or Sonarr imported is deleted (in Plex,
# or in Radarr/Sonarr with its files), remove its torrent (with its data) from the :8081 qBittorrent, so the space
# comes back right away instead of after the seeding limit.
#
#   tools/arr-reclaim.sh watch      watch the library, reclaim after each burst
#                                   of deletions, record imports while idle
#                                   (run by arr-reclaim.service)
#   tools/arr-reclaim.sh run        reclaim once, now
#   tools/arr-reclaim.sh --audit    report what `run` would do; changes nothing
#
# Ported from pms-local's plex-watch.sh / plex-reconcile.sh, which did this for
# the native qBittorrent until Phase 7a retired both (pms-local itself is left
# exactly as it is). What differs is how a
# torrent is known to be ours and deleted, because here Radarr and Sonarr
# record it:
#
#   imported   the torrent's hash is, or was, in Radarr's or Sonarr's import
#              history (eventType 3, downloadFolderImported). Proof, not
#              inference — so there is no untagged gap, and a download that
#              finished but is not imported yet is never touched.
#   deleted    every library path those imports wrote is gone, AND every media
#              file of the torrent is down to one link. The second half is
#              what keeps a file that was moved or renamed (still linked
#              somewhere) from reading as deleted.
#
# "Or was": deleting a movie in Radarr (a series in Sonarr) deletes its
# history too, before any run can read it. So the imports seen are kept in a
# ledger ($APPDATA/.arr-reclaim.imports), recorded every RECLAIM_RECORD_EVERY
# seconds and on every run. A row the app has forgotten is dropped once
# qBittorrent no longer has its torrent either. A delete within that interval of the import is not in it, and is
# kept like any not-imported torrent.
#
# Some but not all of a torrent's imports gone (one episode of a season pack)
# is `partial`: reported, kept — the same call plex-reconcile makes.
#
# Exit: 0 fine (including nothing to do) · 2 usage · 3 preflight/config ·
# 4 a login or API key was refused · 5 qBittorrent or an app is unreachable.

set -uo pipefail

REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"

env_get() {
    [[ -f "$REPO/.env" ]] || return 0
    sed -n "s/^$1=//p" "$REPO/.env" | tail -n1
}

APPDATA="${APPDATA:-$(env_get APPDATA)}"; APPDATA="${APPDATA:-/opt/appdata}"
LIBRARY="${LIBRARY:-/mnt/data/streaming}"
QBT_ARR_URL="${QBT_ARR_URL:-http://127.0.0.1:8081}"
QBT_ARR_USER="${QBT_ARR_USER:-$(env_get QBT_ARR_USER)}"
QBT_ARR_PASS="${QBT_ARR_PASS:-$(env_get QBT_ARR_PASS)}"
RADARR_URL="${RADARR_URL:-http://127.0.0.1:7878}"
SONARR_URL="${SONARR_URL:-http://127.0.0.1:8989}"
RADARR_API_KEY="${RADARR_API_KEY:-$(env_get RADARR_API_KEY)}"
SONARR_API_KEY="${SONARR_API_KEY:-$(env_get SONARR_API_KEY)}"
RECLAIM_TIMEOUT="${RECLAIM_TIMEOUT:-20}"

# Same defaults and reasons as plex-watch / plex-reconcile.
RECLAIM_DEBOUNCE="${RECLAIM_DEBOUNCE:-60}"          # a deleted season is one event per episode
RECLAIM_FAIL_COOLDOWN="${RECLAIM_FAIL_COOLDOWN:-300}"
RECLAIM_MAX_REMOVALS="${RECLAIM_MAX_REMOVALS:-3}"   # a bug costs a puzzled look, not the seedbox
RECLAIM_LOCK="${RECLAIM_LOCK:-$APPDATA/.arr-reclaim.lock}"
RECLAIM_LEDGER="${RECLAIM_LEDGER:-$APPDATA/.arr-reclaim.imports}"
RECLAIM_RECORD_EVERY="${RECLAIM_RECORD_EVERY:-60}"  # the window a delete in Radarr/Sonarr can slip through
INOTIFYWAIT="${INOTIFYWAIT:-inotifywait}"           # test seam, env-only

# Must agree with plex-watch's list: only a media file going away is worth a run.
MEDIA_EXTS="mkv|mp4|avi|mov|wmv|m4v|ts|flac|mp3|m4a|ogg|opus"

# app|category|url-var|key-var — the category the app's download client uses.
APPS=(
    "radarr|radarr|RADARR_URL|RADARR_API_KEY"
    "sonarr|sonarr|SONARR_URL|SONARR_API_KEY"
)

# Under systemd, stdout is the journal.
log() { printf '[%s] reclaim: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

is_media() { [[ "${1,,}" =~ \.(${MEDIA_EXTS})$ ]]; }

# ─── pure helpers (tests/arr-reclaim.test.sh) ─────────────────────────────────

# Import history → "date<TAB>hash<TAB>importedPath" lines, hash lowercased
# (the apps store qBittorrent's hash uppercase in downloadId). The ISO date
# leads so that a reverse sort is newest first. Never empty: read's tab
# splitting would drop an empty first field.
history_imports() { # history-page-json
    jq -r '.records[]? | select(.downloadId != null and .data.importedPath != null)
        | [(.date // "0"), (.downloadId | ascii_downcase), .data.importedPath] | @tsv' <<<"$1"
}

# Import lines, deduplicated, newest first.
merge_imports() { grep -v '^$' | LC_ALL=C sort -ru; }

# What to do with one torrent.
#   not-imported  keep: not in any import history — not ours to judge
#   in-library    keep: every imported file is still there
#   partial       keep: some imports gone, some not (report)
#   moved         keep: imports gone from where they were written, but the data
#                 is still linked somewhere — a rename or a move, not a delete
#   deleted       REMOVE: imports gone and nothing links to the data any more
#   upgraded      REMOVE: every path it imported has since been imported again
#                 by ANOTHER download (an upgrade lands on the same path) and
#                 nothing links to its data any more. Checked before in-library,
#                 which the unchanged path would otherwise report.
decide() { # n-imports n-imports-present n-media n-media-single-link [superseded 0/1]
    local imp="$1" present="$2" media="$3" single="$4" superseded="${5:-0}"
    if   [[ "$imp" -eq 0 ]];                         then echo not-imported
    elif [[ "$superseded" -eq 1 && "$media" -gt 0 && "$single" -eq "$media" ]]; then echo upgraded
    elif [[ "$present" -eq "$imp" ]];                then echo in-library
    elif [[ "$present" -gt 0 ]];                     then echo partial
    elif [[ "$media" -gt 0 && "$single" -eq "$media" ]]; then echo deleted
    else                                                  echo moved
    fi
}

# qBittorrent up to 5.1 answers a good login 200 "Ok."; 5.2 answers 204 with
# an empty body (and a bad one 401). Anything else is a refusal.
qbt_login_ok() { [[ "$1" == 204 || ( "$1" == 200 && "$2" == "Ok." ) ]]; }

# ─── qBittorrent ──────────────────────────────────────────────────────────────
QBT_JAR=""

qbt_login() {
    local code body
    body="$(mktemp)"
    code="$(curl -s --max-time "$RECLAIM_TIMEOUT" -c "$QBT_JAR" -o "$body" -w '%{http_code}' \
        -H "Referer: $QBT_ARR_URL" --data-urlencode "username=$QBT_ARR_USER" --data-urlencode "password@-" \
        "$QBT_ARR_URL/api/v2/auth/login" < <(printf '%s' "$QBT_ARR_PASS"))" || code=000
    local b; b="$(cat "$body")"; rm -f "$body"
    [[ "$code" == 000 ]] && { log "ERROR: cannot reach qBittorrent at $QBT_ARR_URL"; return 5; }
    qbt_login_ok "$code" "$b" || { log "ERROR: qBittorrent refused the login for '$QBT_ARR_USER' (HTTP $code)"; return 4; }
}

qbt_get() { # path
    curl -sf --max-time "$RECLAIM_TIMEOUT" -b "$QBT_JAR" -H "Referer: $QBT_ARR_URL" "$QBT_ARR_URL$1"
}

qbt_delete() { # hash
    curl -sf --max-time "$RECLAIM_TIMEOUT" -b "$QBT_JAR" -H "Referer: $QBT_ARR_URL" \
        --data-urlencode "hashes=$1" --data-urlencode "deleteFiles=true" \
        "$QBT_ARR_URL/api/v2/torrents/delete" >/dev/null
}

# ─── Radarr / Sonarr import history ───────────────────────────────────────────
# All pages of eventType 3. The name "downloadFolderImported" is refused (400);
# only the number is accepted.
app_imports() { # url key
    local url="$1" key="$2" page=1 json n
    while :; do
        json="$(curl -sf --max-time "$RECLAIM_TIMEOUT" -H "X-Api-Key: $key" \
            "$url/api/v3/history?eventType=3&page=$page&pageSize=250&sortKey=date&sortDirection=descending")" || return 1
        history_imports "$json"
        n="$(jq '.records | length' <<<"$json")"
        [[ "$n" -eq 250 ]] || return 0
        page=$((page + 1))
    done
}

# ─── the ledger ───────────────────────────────────────────────────────────────
# "app<TAB>date<TAB>hash<TAB>path" lines: the import history as last seen,
# which outlives a movie or series deleted in its app.

ledger_rows() { # app → its "date<TAB>hash<TAB>path" lines
    [[ -f "$RECLAIM_LEDGER" ]] || return 0
    awk -F'\t' -v a="$1" '$1 == a { print $2 "\t" $3 "\t" $4 }' "$RECLAIM_LEDGER"
}

with_app() { awk -v a="$1" 'NF { print a "\t" $0 }'; } # app; prefixes stdin lines

# Replace the ledger with stdin, atomically; untouched when nothing changed.
ledger_write() {
    local tmp
    tmp="$(mktemp "$RECLAIM_LEDGER.XXXXXX")" || { log "WARN: cannot write $RECLAIM_LEDGER"; return 1; }
    grep -v '^$' > "$tmp"
    if cmp -s -- "$tmp" "$RECLAIM_LEDGER"; then rm -f -- "$tmp"
    else mv -f -- "$tmp" "$RECLAIM_LEDGER" || { rm -f -- "$tmp"; log "WARN: cannot write $RECLAIM_LEDGER"; return 1; }
    fi
}

# Add each app's live import history to the ledger. No qBittorrent, no
# decisions: this is what runs every RECLAIM_RECORD_EVERY seconds. Quiet when
# an app is away; the next reclaim run says so.
record() {
    local entry app cat urlv keyv imports old new added out="" rc=0
    for entry in "${APPS[@]}"; do
        IFS='|' read -r app cat urlv keyv <<<"$entry"
        old="$(ledger_rows "$app")"
        new="$old"
        if [[ -n "${!keyv}" ]]; then
            if imports="$(app_imports "${!urlv}" "${!keyv}")"; then
                new="$(printf '%s\n%s\n' "$imports" "$old" | merge_imports)"
                added=$(( $(grep -c . <<<"$new") - $(grep -c . <<<"$old") ))
                [[ "$added" -gt 0 ]] && log "Recorded $added import(s) of $app."
            else
                rc=5
            fi
        fi
        out+="$(with_app "$app" <<<"$new")"$'\n'
    done
    ledger_write <<<"$out" || rc=3
    return "$rc"
}

# ─── one reclaim run ──────────────────────────────────────────────────────────
reclaim() { # run|audit
    local mode="$1" entry app cat urlv keyv imports torrents rc=0
    local -A IMPORTS=() LATEST=()
    local removed=0 hash name save progress files rel abs imp present media single decision superseded
    local -A COUNT=() HELD=() LIVE=()
    local date ledger=""

    QBT_JAR="$(mktemp)"; trap 'rm -f "$QBT_JAR"' RETURN
    qbt_login || return $?

    for entry in "${APPS[@]}"; do
        IFS='|' read -r app cat urlv keyv <<<"$entry"
        # An app skipped this run keeps its ledger rows as they are.
        [[ -n "${!keyv}" ]] || { log "$app: no $keyv — its torrents are left alone"; ledger+="$(ledger_rows "$app" | with_app "$app")"$'\n'; continue; }
        if ! imports="$(app_imports "${!urlv}" "${!keyv}")"; then
            # Never guess ownership: without the history, keep everything of this app.
            log "WARN: cannot read $app's import history at ${!urlv} — its torrents are left alone this run"
            ledger+="$(ledger_rows "$app" | with_app "$app")"$'\n'
            rc=5; continue
        fi
        LIVE=()
        while IFS=$'\t' read -r date hash abs; do [[ -n "$hash" ]] && LIVE[$hash]=1; done <<<"$imports"
        # The live history plus what the ledger remembers of history since deleted.
        imports="$(printf '%s\n%s\n' "$imports" "$(ledger_rows "$app")" | merge_imports)"
        # Newest first, so the first hash seen for a path is the download that
        # path holds now; any other hash for it was superseded.
        while IFS=$'\t' read -r date hash abs; do
            [[ -n "$hash" ]] || continue
            IMPORTS[$hash]+="$abs"$'\n'
            [[ -n "${LATEST[$abs]:-}" ]] || LATEST[$abs]="$hash"
        done <<<"$imports"

        torrents="$(qbt_get "/api/v2/torrents/info?category=$cat")" || { log "ERROR: cannot list $cat torrents"; return 5; }
        HELD=()
        while IFS=$'\t' read -r hash name save progress; do
            [[ -n "$hash" ]] || continue
            HELD[$hash]=1
            if [[ "$progress" != 1 ]]; then COUNT[incomplete]=$(( ${COUNT[incomplete]:-0} + 1 )); continue; fi

            imp=0; present=0; superseded=1
            while IFS= read -r abs; do
                [[ -n "$abs" ]] || continue
                imp=$((imp + 1)); [[ -e "$abs" ]] && present=$((present + 1))
                [[ "${LATEST[$abs]:-}" == "$hash" ]] && superseded=0
            done <<<"${IMPORTS[$hash]:-}"
            [[ "$imp" -gt 0 ]] || superseded=0

            media=0; single=0
            files="$(qbt_get "/api/v2/torrents/files?hash=$hash")" || { log "WARN: cannot list the files of '$name' — left alone"; continue; }
            while IFS= read -r rel; do
                is_media "$rel" || continue
                abs="${save%/}/$rel"
                [[ -e "$abs" ]] || continue
                media=$((media + 1))
                [[ "$(stat -c %h -- "$abs")" -eq 1 ]] && single=$((single + 1))
            done < <(jq -r '.[] | select(.priority != 0) | .name' <<<"$files")

            decision="$(decide "$imp" "$present" "$media" "$single" "$superseded")"
            COUNT[$decision]=$(( ${COUNT[$decision]:-0} + 1 ))
            case "$decision" in
                deleted|upgraded)
                    local why="its library files are gone"
                    [[ "$decision" == upgraded ]] && why="an upgrade replaced it in the library"
                    if [[ "$mode" == audit ]]; then
                        log "would remove '$name' ($app) — $why"
                    elif [[ "$removed" -ge "$RECLAIM_MAX_REMOVALS" ]]; then
                        log "WARN: RECLAIM_MAX_REMOVALS=$RECLAIM_MAX_REMOVALS reached — '$name' left for the next run"
                    elif qbt_delete "$hash"; then
                        removed=$((removed + 1)); unset "HELD[$hash]"
                        log "Removed '$name' ($app) with its data — $why."
                        # An upgrade's folder still holds the new file; rmdir leaves it.
                        [[ "$decision" == deleted ]] && prune_dirs "${IMPORTS[$hash]}"
                    else
                        log "ERROR: qBittorrent refused to remove '$name'"; rc=5
                    fi ;;
                partial) log "partial: '$name' ($app) — $present of $imp imported file(s) still in the library; kept" ;;
                moved)   log "moved: '$name' ($app) — imports gone but its data is still linked elsewhere; kept" ;;
            esac
        done < <(jq -r '.[] | [.hash, .name, .save_path, (if .progress >= 1 then 1 else 0 end)] | @tsv' <<<"$torrents")

        # Keep what the app still has, and what it forgot of a torrent
        # qBittorrent still holds; the rest can never be decided again.
        while IFS=$'\t' read -r date hash abs; do
            [[ -n "$hash" && -n "${LIVE[$hash]:-}${HELD[$hash]:-}" ]] && ledger+="$app"$'\t'"$date"$'\t'"$hash"$'\t'"$abs"$'\n'
        done <<<"$imports"
    done
    [[ "$mode" == run ]] && { ledger_write <<<"$ledger" || rc=3; }

    local k summary=""
    for k in deleted upgraded partial moved in-library not-imported incomplete; do
        [[ -n "${COUNT[$k]:-}" ]] && summary+=" $k=${COUNT[$k]}"
    done
    log "Done ($mode):${summary:- nothing to look at}; removed $removed."
    return "$rc"
}

# The folder a deleted import left behind, if it is now empty and inside the
# library. rmdir never removes anything with content.
prune_dirs() { # newline-separated imported paths
    local p d
    while IFS= read -r p; do
        [[ -n "$p" ]] || continue
        d="$(dirname -- "$p")"
        while [[ "$d" == "$LIBRARY"/*/* ]]; do
            rmdir -- "$d" 2>/dev/null || break
            log "Pruned empty directory: $d"
            d="$(dirname -- "$d")"
        done
    done <<<"$1"
}

# ─── watching ─────────────────────────────────────────────────────────────────
reclaim_locked() {
    local rc=0
    exec 9>"$RECLAIM_LOCK" || { log "ERROR: cannot open $RECLAIM_LOCK"; return 3; }
    flock -w 60 9 || { log "Another reclaim holds $RECLAIM_LOCK — skipping."; return 0; }
    reclaim run || rc=$?
    exec 9>&-
    return "$rc"
}

# Never waits: a reclaim holding the lock records as it runs.
record_locked() {
    local rc=0
    exec 9>"$RECLAIM_LOCK" || { log "ERROR: cannot open $RECLAIM_LOCK"; return 3; }
    flock -n 9 || return 0
    record || rc=$?
    exec 9>&-
    return "$rc"
}

# As plex-watch: one run per burst, after RECLAIM_DEBOUNCE seconds of quiet;
# after a failure, ignore deletions for RECLAIM_FAIL_COOLDOWN. Every
# RECLAIM_RECORD_EVERY seconds without an event, record the imports.
watch_loop() {
    local path more n rc
    while :; do
        IFS= read -r -t "$RECLAIM_RECORD_EVERY" path; rc=$?
        if [[ "$rc" -gt 128 ]]; then record_locked || true; continue; fi
        [[ "$rc" -eq 0 ]] || break    # EOF: inotifywait is gone
        is_media "$path" || continue
        n=1
        log "Gone from the library: $path"
        while IFS= read -r -t "$RECLAIM_DEBOUNCE" more; do
            if is_media "$more"; then n=$((n + 1)); log "Gone from the library: $more"; fi
        done
        log "$n media file(s) removed, and ${RECLAIM_DEBOUNCE}s of quiet since."
        rc=0; reclaim_locked || rc=$?
        if [[ "$rc" -ne 0 ]]; then
            log "WARN: the reclaim exited $rc — ignoring further deletions for ${RECLAIM_FAIL_COOLDOWN}s."
            sleep "$RECLAIM_FAIL_COOLDOWN"
        fi
    done
}

preflight() {
    local cmd
    for cmd in curl jq flock stat; do command -v "$cmd" >/dev/null || { echo "missing command: $cmd" >&2; return 1; }; done
    [[ -d "$LIBRARY" ]] || { echo "not a directory: $LIBRARY" >&2; return 1; }
    [[ -n "$QBT_ARR_USER" && -n "$QBT_ARR_PASS" ]] || { echo "QBT_ARR_USER / QBT_ARR_PASS not set in $REPO/.env" >&2; return 1; }
    [[ -n "$RADARR_API_KEY$SONARR_API_KEY" ]] || { echo "neither RADARR_API_KEY nor SONARR_API_KEY is set in $REPO/.env" >&2; return 1; }
}

main() {
    case "${1:-}" in
        watch)
            preflight || exit 3
            command -v "$INOTIFYWAIT" >/dev/null || { echo "missing command: $INOTIFYWAIT — sudo apt install inotify-tools" >&2; exit 3; }
            log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            log "Watching $LIBRARY for deletions (debounce ${RECLAIM_DEBOUNCE}s) for $QBT_ARR_URL."
            record_locked || log "WARN: could not record the import history now — retrying every ${RECLAIM_RECORD_EVERY}s."
            watch_loop < <("$INOTIFYWAIT" -m -r -q -e delete -e moved_from --format '%w%f' -- "$LIBRARY")
            log "ERROR: inotifywait exited — the unit will be restarted."
            exit 5 ;;
        run)      preflight || exit 3; reclaim_locked; exit $? ;;
        --audit)  preflight || exit 3; reclaim audit; exit $? ;;
        -h|--help) sed -n '2,38p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)        echo "usage: ${0##*/} watch|run|--audit" >&2; exit 2 ;;
    esac
}

[[ "${ARR_RECLAIM_LIB:-0}" == "1" ]] || main "$@"
