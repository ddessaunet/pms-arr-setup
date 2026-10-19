#!/usr/bin/env bash
# jobs/arr-reclaim/arr-reclaim.test.sh — unit fixtures and a full rehearsal for jobs/arr-reclaim/arr-reclaim.sh
#
#   jobs/arr-reclaim/arr-reclaim.test.sh
#
# Offline, and changes nothing outside $(mktemp -d): the script is sourced with
# ARR_RECLAIM_LIB=1 so main() never runs. The rehearsal builds a real library
# and torrent tree with real hardlinks in a temp dir, and stubs curl as
# qBittorrent and the Radarr/Sonarr history API — so the link counting, the
# decisions and the removals are the real code, on real files.

cd "$(dirname "$0")/../.." || exit 1

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export APPDATA="$TMP" LIBRARY="$TMP/lib"
export QBT_ARR_USER=u QBT_ARR_PASS=p RADARR_API_KEY=rk SONARR_API_KEY=sk
export ARR_RECLAIM_LIB=1
# shellcheck source=SCRIPTDIR/arr-reclaim.sh
. ./jobs/arr-reclaim/arr-reclaim.sh || { echo "cannot source jobs/arr-reclaim/arr-reclaim.sh"; exit 1; }

PASS=0; FAIL=0
ok_eq() { # label want got
    if [[ "$2" == "$3" ]]; then
        PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"
    else
        FAIL=$((FAIL + 1)); printf '  FAIL  %s\n          want: %q\n          got:  %q\n' "$1" "$2" "$3"
    fi
}
ok_rc() { # label want-rc cmd...
    local label="$1" want="$2"; shift 2
    "$@" >/dev/null 2>&1; local got=$?
    if [[ "$got" == "$want" ]]; then
        PASS=$((PASS + 1)); printf '  ok    %s\n' "$label"
    else
        FAIL=$((FAIL + 1)); printf '  FAIL  %s\n          want rc %s, got rc %s\n' "$label" "$want" "$got"
    fi
}

# ─── the decision ─────────────────────────────────────────────────────────────
echo "decide  (imports, imports-present, media, media-with-one-link)"
ok_eq "never imported → not ours"            not-imported "$(decide 0 0 1 1)"
ok_eq "imported and still there → keep"      in-library   "$(decide 1 1 1 0)"
ok_eq "one episode of a pack deleted → keep" partial      "$(decide 8 7 8 1)"
ok_eq "all gone, data unlinked → REMOVE"     deleted      "$(decide 1 0 1 1)"
ok_eq "whole pack gone, all unlinked → REMOVE" deleted    "$(decide 8 0 8 8)"
ok_eq "gone from its path but still linked (renamed) → keep" moved "$(decide 1 0 1 0)"
ok_eq "imports gone and no media left at all → keep" moved "$(decide 1 0 0 0)"
ok_eq "path re-imported by another download, data unlinked → REMOVE" upgraded "$(decide 1 1 1 1 1)"
ok_eq "superseded, but its data is still linked → keep" in-library "$(decide 1 1 1 0 1)"
ok_eq "not superseded: same numbers are a plain in-library" in-library "$(decide 1 1 1 1 0)"
ok_eq "never imported beats superseded" not-imported "$(decide 0 0 1 1 1)"

# ─── history parsing ──────────────────────────────────────────────────────────
echo
echo "history_imports"
H='{"page":1,"pageSize":250,"totalRecords":3,"records":[
 {"eventType":"downloadFolderImported","date":"2026-09-29T18:44:17Z","downloadId":"ABCDEF0123","data":{"importedPath":"/lib/movies/A (2000)/A (2000).mkv","droppedPath":"/t/a.mkv"}},
 {"eventType":"downloadFolderImported","date":"2026-09-29T18:44:17Z","downloadId":null,"data":{"importedPath":"/lib/manual.mkv"}},
 {"eventType":"downloadFolderImported","downloadId":"ABCDEF0123","data":{"importedPath":"/lib/movies/A (2000)/A (2000).srt"}}]}'
ok_eq "date first, hash lowercased, one line per imported file; a missing date is never empty" \
    "$(printf '2026-09-29T18:44:17Z\tabcdef0123\t/lib/movies/A (2000)/A (2000).mkv\n0\tabcdef0123\t/lib/movies/A (2000)/A (2000).srt')" \
    "$(history_imports "$H")"
ok_eq "a manual import (no downloadId) is nobody's torrent" "0" "$(history_imports "$H" | grep -c manual)"
ok_eq "an empty page is nothing"  "" "$(history_imports '{"records":[]}')"
ok_eq "merge: deduplicated, newest first" \
    "$(printf '2026-09-02\tb\t/p\n2026-09-01\ta\t/p')" \
    "$(printf '2026-09-01\ta\t/p\n\n2026-09-02\tb\t/p\n2026-09-01\ta\t/p\n' | merge_imports)"

# ─── login ────────────────────────────────────────────────────────────────────
echo
echo "qbt_login_ok"
ok_rc "5.2: 204, empty body"      0 qbt_login_ok 204 ""
ok_rc "≤5.1: 200 Ok."             0 qbt_login_ok 200 "Ok."
ok_rc "≤5.1: 200 Fails. refused"  1 qbt_login_ok 200 "Fails."
ok_rc "5.2: 401 refused"          1 qbt_login_ok 401 ""
ok_rc "an empty 200 is not a login" 1 qbt_login_ok 200 ""

echo
echo "movie_with_file / series_holding"
M='[{"id":7,"title":"A","year":2000,"movieFile":{"path":"/lib/movies/A (2000)/A (2000).mkv"}},
    {"id":8,"title":"B","year":2001,"movieFile":null},{"id":9,"title":"C","year":2002}]'
ok_eq "the movie whose file it was" "$(printf '7\tA (2000)')" "$(movie_with_file "$M" "/lib/movies/A (2000)/A (2000).mkv")"
ok_eq "a movie without a file record is nobody's" "" "$(movie_with_file "$M" "/lib/movies/B (2001)/B (2001).mkv")"
S='[{"id":2,"title":"The Boys","path":"/lib/series/The Boys"},{"id":3,"title":"The Boy","path":"/lib/series/The Boy"}]'
ok_eq "the series whose folder holds it, not one named like a prefix" "$(printf '2\tThe Boys')" \
    "$(series_holding "$S" "/lib/series/The Boys/Season 01/The Boys - S01E01.mkv")"
ok_eq "outside every series folder → nothing" "" "$(series_holding "$S" "/lib/movies/A (2000)/A (2000).mkv")"

echo
echo "is_media"
ok_rc "mkv"                 0 is_media "/lib/movies/A (2000)/A (2000).mkv"
ok_rc "uppercase MP4"       0 is_media "/lib/x.MP4"
ok_rc "a subtitle is not"   1 is_media "/lib/movies/A (2000)/A (2000).srt"
ok_rc "a directory is not"  1 is_media "/lib/movies/A (2000)"

# ─── full rehearsal on real files ─────────────────────────────────────────────
# Six Radarr torrents, one per outcome, built with real hardlinks:
#   del   imported, then deleted in "Plex"             → removed, folder pruned
#   keep  imported, still in the library               → kept
#   ren   imported, then renamed inside the library    → kept (still linked)
#   copy  imported by COPY (no hardlink), still there  → kept
#   stray finished, never imported (not in history)    → kept
#   dl    still downloading                            → kept
echo
echo "reclaim — rehearsal"
T="$TMP/torrents/radarr"; L="$TMP/lib/movies"
mkdir -p "$T" "$L"
for n in del keep ren copy stray dl; do printf '%s' "$n" > "$T/$n.mkv"; done
mkdir -p "$L/Del (2001)" "$L/Keep (2002)" "$L/Ren (2003)" "$L/Copy (2004)"
ln "$T/del.mkv"  "$L/Del (2001)/Del (2001).mkv"
ln "$T/keep.mkv" "$L/Keep (2002)/Keep (2002).mkv"
ln "$T/ren.mkv"  "$L/Ren (2003)/Ren (2003).mkv"
cp "$T/copy.mkv" "$L/Copy (2004)/Copy (2004).mkv"
rm "$L/Del (2001)/Del (2001).mkv"                                        # deleted in Plex
mv "$L/Ren (2003)/Ren (2003).mkv" "$L/Ren (2003)/Ren (2003) renamed.mkv" # renamed, not deleted

hash_of() { printf '%040d' "$1"; }
INFO="$(jq -cn --arg t "$T" '[
    {hash: "0000000000000000000000000000000000000001", name: "del",   save_path: $t, progress: 1},
    {hash: "0000000000000000000000000000000000000002", name: "keep",  save_path: $t, progress: 1},
    {hash: "0000000000000000000000000000000000000003", name: "ren",   save_path: $t, progress: 1},
    {hash: "0000000000000000000000000000000000000004", name: "copy",  save_path: $t, progress: 1},
    {hash: "0000000000000000000000000000000000000005", name: "stray", save_path: $t, progress: 1},
    {hash: "0000000000000000000000000000000000000006", name: "dl",    save_path: $t, progress: 0.4}]')"
HIST="$(jq -cn --arg l "$L" '{records: [
    {downloadId: "0000000000000000000000000000000000000001", data: {importedPath: ($l + "/Del (2001)/Del (2001).mkv")}},
    {downloadId: "0000000000000000000000000000000000000002", data: {importedPath: ($l + "/Keep (2002)/Keep (2002).mkv")}},
    {downloadId: "0000000000000000000000000000000000000003", data: {importedPath: ($l + "/Ren (2003)/Ren (2003).mkv")}},
    {downloadId: "0000000000000000000000000000000000000004", data: {importedPath: ($l + "/Copy (2004)/Copy (2004).mkv")}}]}')"
FILES_OF() { jq -cn --arg n "$1" '[{name: ($n + ".mkv"), priority: 1}]'; }
SHIST='{"records":[]}'
LEDGER="$RECLAIM_LEDGER"

# curl as qBittorrent and as the two history APIs. Deletions are recorded,
# and the torrent data really is deleted, as qBittorrent would.
DELETED="$TMP/deleted"; : > "$DELETED"
ARR_CALLS="$TMP/arr-calls"; : > "$ARR_CALLS"
MOVIES='[]'; SERIES='[]'
# shellcheck disable=SC2329  # stub, called indirectly by the script
curl() {
    local url="${*: -1}" a out="" code=200 body=""
    for a in "$@"; do [[ "$a" == -o ]] && out=next && continue; [[ "$out" == next ]] && out="$a"; done
    case "$url" in
        */api/v2/auth/login)            code=204 ;;
        */api/v2/torrents/info?category=radarr) body="$INFO" ;;
        */api/v2/torrents/info?category=sonarr) body='[]' ;;
        */api/v2/torrents/files?hash=*)
            local h="${url##*hash=}"
            body="$(FILES_OF "$(jq -r --arg h "$h" '.[] | select(.hash == $h) | .name' <<<"$INFO")")" ;;
        */api/v2/torrents/delete)
            local h; h="$(printf '%s\n' "$@" | sed -n 's/^hashes=//p')"
            echo "$h" >> "$DELETED"
            rm -f "$T/$(jq -r --arg h "$h" '.[] | select(.hash == $h) | .name' <<<"$INFO").mkv" ;;
        *7878/api/v3/history*)          body="$HIST" ;;
        *8989/api/v3/history*)          if [[ -n "${SONARR_DOWN:-}" ]]; then code=503; else body="$SHIST"; fi ;;
        *7878/api/v3/movie)             body="$MOVIES" ;;
        *7878/api/v3/movie/*)           echo "radarr $(printf '%s\n' "$@" | grep -A1 '^-X$' | tail -n1) ${url##*/api/v3/}" >> "$ARR_CALLS" ;;
        *8989/api/v3/series)            body="$SERIES" ;;
        *8989/api/v3/command)           echo "sonarr $(printf '%s\n' "$@" | grep '^{')" >> "$ARR_CALLS" ;;
        *)                              code=404 ;;
    esac
    if [[ -n "$out" && "$out" != next ]]; then printf '%s' "$body" > "$out"; printf '%s' "$code"
    else printf '%s' "$body"; fi
    # -f (alone or as in -sf) makes an HTTP error a failure, as with real curl.
    [[ "$code" == 2* ]] || ! printf '%s\n' "$@" | grep -q -- '^-[a-zA-Z]*f'
}

OUT="$(reclaim audit 2>&1)"
ok_eq "audit: would remove only the deleted one" "1" "$(grep -c 'would remove' <<<"$OUT")"
ok_eq "audit: and it is 'del'"   "1" "$(grep -c "would remove 'del'" <<<"$OUT")"
ok_eq "audit: changes nothing"   "" "$(cat "$DELETED")"
ok_rc "audit: data still there" 0 test -e "$T/del.mkv"
ok_rc "audit: writes no ledger" 1 test -e "$LEDGER"

OUT="$(reclaim run 2>&1)"
ok_eq "run: no shell errors (sonarr's history is empty)" "" "$(grep -E 'line [0-9]+:' <<<"$OUT")"
ok_eq "run: exactly one removal"  "1" "$(wc -l < "$DELETED" | tr -d ' ')"
ok_eq "run: the deleted import's torrent" "$(hash_of 1)" "$(cat "$DELETED")"
ok_rc "run: its data is gone"     1 test -e "$T/del.mkv"
ok_rc "run: its empty folder pruned" 1 test -d "$L/Del (2001)"
ok_rc "kept: still in the library"   0 test -e "$T/keep.mkv"
ok_rc "kept: renamed, still linked"  0 test -e "$T/ren.mkv"
ok_rc "kept: imported by copy"       0 test -e "$T/copy.mkv"
ok_rc "kept: never imported"         0 test -e "$T/stray.mkv"
ok_rc "kept: still downloading"      0 test -e "$T/dl.mkv"
ok_rc "the library's other folders untouched" 0 test -d "$L/Keep (2002)"
ok_eq "summary names every outcome" \
    "deleted=1 moved=1 in-library=2 not-imported=1 incomplete=1; removed 1." \
    "$(grep -o 'deleted=.*' <<<"$OUT")"
ok_eq "run: the ledger holds the history, as radarr's" "4 4" \
    "$(wc -l < "$LEDGER" | tr -d ' ') $(grep -c '^radarr'$'\t' "$LEDGER")"

: > "$DELETED"
reclaim run >/dev/null 2>&1
ok_eq "a second run finds nothing more to remove" "" "$(cat "$DELETED")"

# The cap: with every torrent "deleted", only RECLAIM_MAX_REMOVALS go per run.
echo
echo "reclaim — the cap"
rm -f "$LEDGER"
for n in 1 2 3 4 5; do printf 'x' > "$T/cap$n.mkv"; done
INFO="$(jq -cn --arg t "$T" '[range(1;6) | {hash: ("c" + (. | tostring) | .[0:40]), name: ("cap" + (. | tostring)), save_path: $t, progress: 1}]')"
HIST="$(jq -cn --arg l "$L" '{records: [range(1;6) | {downloadId: ("C" + (. | tostring)), data: {importedPath: ($l + "/gone" + (. | tostring) + ".mkv")}}]}')"
: > "$DELETED"
OUT="$(RECLAIM_MAX_REMOVALS=3 reclaim run 2>&1)"
ok_eq "five deleted, three removed" "3" "$(wc -l < "$DELETED" | tr -d ' ')"
ok_eq "and the rest are named for the next run" "2" "$(grep -c 'left for the next run' <<<"$OUT")"

# ─── an upgrade, on real files ────────────────────────────────────────────────
# Radarr grabbed "old", imported it, then an upgrade "new" was imported to the
# SAME library path. The library now links "new"; "old" is down to one link.
# History is newest first: new, then old.
echo
echo "reclaim — upgrade"
U="$TMP/lib/movies/Up (2024)"; mkdir -p "$U"
printf 'old' > "$T/up-old.mkv"; printf 'new' > "$T/up-new.mkv"
ln "$T/up-old.mkv" "$U/Up (2024).mkv"                    # first import
rm "$U/Up (2024).mkv"; ln "$T/up-new.mkv" "$U/Up (2024).mkv"   # the upgrade replaces it
printf 'kept' > "$T/re-still.mkv"; ln "$T/re-still.mkv" "$TMP/lib/elsewhere.mkv"   # superseded, still linked
INFO="$(jq -cn --arg t "$T" '[
    {hash: "u1", name: "up-old",   save_path: $t, progress: 1},
    {hash: "u2", name: "up-new",   save_path: $t, progress: 1},
    {hash: "u3", name: "re-still", save_path: $t, progress: 1}]')"
HIST="$(jq -cn --arg p "$U/Up (2024).mkv" '{records: [
    {date: "2026-09-03T00:00:00Z", downloadId: "U2", data: {importedPath: $p}},
    {date: "2026-09-02T00:00:00Z", downloadId: "U3", data: {importedPath: $p}},
    {date: "2026-09-01T00:00:00Z", downloadId: "U1", data: {importedPath: $p}}]}')"
rm -f "$LEDGER"; : > "$DELETED"
OUT="$(reclaim run 2>&1)"
ok_eq "only the replaced torrent is removed" "u1" "$(cat "$DELETED")"
ok_eq "and it says why" "1" "$(grep -c "Removed 'up-old'.*an upgrade replaced it" <<<"$OUT")"
ok_rc "the new file is still in the library" 0 test -e "$U/Up (2024).mkv"
ok_rc "its folder is not pruned"             0 test -d "$U"
ok_rc "the new torrent is kept"              0 test -e "$T/up-new.mkv"
ok_rc "superseded but still linked is kept"  0 test -e "$T/re-still.mkv"
ok_eq "summary" "upgraded=1 in-library=2; removed 1." "$(grep -o 'upgraded=.*' <<<"$OUT")"
ok_eq "the replaced torrent's import stays in the ledger while the history has it" "1" "$(grep -c $'\tu1\t' "$LEDGER")"

# ─── deleted in Radarr: the history goes with the movie ───────────────────────
# "gone" was imported and recorded; then the movie was deleted in Radarr with
# its files, which purged its history. "unknown" is the same on disk but was
# never recorded. A sonarr row stays put while Sonarr cannot be read.
echo
echo "reclaim — deleted in Radarr"
G="$TMP/lib/movies/Gone (2005)"; mkdir -p "$G"
printf 'gone' > "$T/gone.mkv"; ln "$T/gone.mkv" "$G/Gone (2005).mkv"
printf 'unknown' > "$T/unknown.mkv"
INFO="$(jq -cn --arg t "$T" '[
    {hash: "r1", name: "gone",    save_path: $t, progress: 1},
    {hash: "r2", name: "unknown", save_path: $t, progress: 1}]')"
HIST="$(jq -cn --arg p "$G/Gone (2005).mkv" '{records: [{date: "2026-09-30T00:10:00Z", downloadId: "R1", data: {importedPath: $p}}]}')"
SHIST="$(jq -cn '{records: [{date: "2026-09-20T00:00:00Z", downloadId: "S1", data: {importedPath: "/lib/series/S/S01E01.mkv"}}]}')"
rm -f "$LEDGER"; : > "$DELETED"
OUT="$(record 2>&1)"
ok_eq "record: one line per app that had news" "2" "$(grep -c 'Recorded 1 import(s)' <<<"$OUT")"
ok_eq "record: into the ledger" "2" "$(wc -l < "$LEDGER" | tr -d ' ')"
OUT="$(record 2>&1)"
ok_eq "record again: nothing new, nothing said" "" "$OUT"
ok_eq "record again: no duplicates" "2" "$(wc -l < "$LEDGER" | tr -d ' ')"
ok_eq "record: nothing removed" "" "$(cat "$DELETED")"

rm "$G/Gone (2005).mkv"; rmdir "$G"                      # "Delete movie", with files
HIST='{"records":[]}'                                     # … and Radarr's history of it
SONARR_DOWN=1
cp "$LEDGER" "$TMP/ledger.before"
OUT="$(reclaim audit 2>&1)"
ok_eq "audit: would remove the recorded one" "1" "$(grep -c "would remove 'gone'" <<<"$OUT")"
ok_rc "audit: ledger byte-identical" 0 cmp -s "$LEDGER" "$TMP/ledger.before"
OUT="$(reclaim run 2>&1)"
ok_eq "run: the recorded torrent is removed" "r1" "$(cat "$DELETED")"
ok_rc "run: its data is gone" 1 test -e "$T/gone.mkv"
ok_rc "never recorded: kept" 0 test -e "$T/unknown.mkv"
ok_eq "summary" "deleted=1 not-imported=1; removed 1." "$(grep -o 'deleted=.*' <<<"$OUT")"
ok_eq "its row is dropped: neither Radarr nor qBittorrent has it" "0" "$(grep -c $'\tr1\t' "$LEDGER")"
ok_eq "Sonarr unreachable: its row is kept" "1" "$(grep -c $'^sonarr\t.*\ts1\t' "$LEDGER")"
unset SONARR_DOWN
SHIST='{"records":[]}'

# ─── telling Radarr and Sonarr, on real files ─────────────────────────────────
#   Gone (2010)    file deleted in Plex                       → removed from Radarr
#   Up (2011)      deleted, but an upgrade put a file back     → kept
#   Twice (2012)   its file named twice in one burst          → removed once
#   two episodes of one series, one of another                → each series rescanned once
#   a deleted file Radarr no longer knows (its own delete)    → nothing
#   a path outside the library                                → nothing
echo
echo "forget — rehearsal"
L="$TMP/lib/movies"; SL="$TMP/lib/series"
mkdir -p "$L/Up (2011)" "$SL/Show/Season 01" "$SL/Other/Season 02"
printf 'new' > "$L/Up (2011)/Up (2011).mkv"
MOVIES="$(jq -cn --arg l "$L" '[
    {id: 21, title: "Gone",  year: 2010, movieFile: {path: ($l + "/Gone (2010)/Gone (2010).mkv")}},
    {id: 22, title: "Up",    year: 2011, movieFile: {path: ($l + "/Up (2011)/Up (2011).mkv")}},
    {id: 23, title: "Twice", year: 2012, movieFile: {path: ($l + "/Twice (2012)/Twice (2012).mkv")}},
    {id: 24, title: "Kept",  year: 2013, movieFile: null}]')"
SERIES="$(jq -cn --arg l "$SL" '[{id: 31, title: "Show", path: ($l + "/Show")}, {id: 32, title: "Other", path: ($l + "/Other")}]')"
GONE=("$L/Gone (2010)/Gone (2010).mkv" "$L/Up (2011)/Up (2011).mkv" "$L/Twice (2012)/Twice (2012).mkv"
      "$L/Twice (2012)/Twice (2012).mkv" "$L/Kept (2013)/Kept (2013).mkv"
      "$SL/Show/Season 01/Show - S01E01.mkv" "$SL/Show/Season 01/Show - S01E02.mkv"
      "$SL/Other/Season 02/Other - S02E01.mkv" "/elsewhere/Gone (2010)/Gone (2010).mkv")
: > "$ARR_CALLS"
OUT="$(forget "${GONE[@]}" 2>&1)"; RC=$?
ok_eq "forget: exits 0" 0 "$RC"
ok_eq "forget: the deleted movies removed from Radarr, once each, files untouched" \
    "$(printf 'radarr DELETE movie/%s?deleteFiles=false&addImportExclusion=false\n' 21 23)" \
    "$(grep '^radarr' "$ARR_CALLS")"
ok_eq "forget: each series with a deleted episode rescanned once" \
    "$(printf 'sonarr {"name":"RescanSeries","seriesId":%s}\n' 31 32)" \
    "$(grep '^sonarr' "$ARR_CALLS" | sort)"
ok_eq "forget: says what it did" "2 2" \
    "$(grep -c 'from radarr — its file was deleted' <<<"$OUT") $(grep -c 'Asked sonarr to rescan' <<<"$OUT")"

: > "$ARR_CALLS"
OUT="$(RECLAIM_MAX_FORGETS=1 forget "${GONE[@]}" 2>&1)"
ok_eq "forget: the cap leaves the rest to Radarr's rescan" "1 1" \
    "$(grep -c '^radarr' "$ARR_CALLS") $(grep -c 'RECLAIM_MAX_FORGETS=1 reached' <<<"$OUT")"

: > "$ARR_CALLS"
OUT="$(forget "$L/Up (2011)/Up (2011).mkv" 2>&1)"
ok_eq "forget: nothing gone for good → nothing said or done" ":" "$OUT:$(cat "$ARR_CALLS")"

# reclaim_locked records the history before forgetting anything, and forgets
# nothing when it can't.
: > "$ARR_CALLS"
OUT="$(SONARR_DOWN=1 reclaim_locked "$L/Gone (2010)/Gone (2010).mkv" 2>&1)"
ok_eq "history unreadable → Radarr told nothing" "" "$(cat "$ARR_CALLS")"
ok_eq "… and it says so" "1" "$(grep -c 'radarr and sonarr are told nothing' <<<"$OUT")"
: > "$ARR_CALLS"
reclaim_locked "$L/Gone (2010)/Gone (2010).mkv" >/dev/null 2>&1
ok_eq "history recorded → Radarr told" "1" "$(grep -c '^radarr' "$ARR_CALLS")"
: > "$ARR_CALLS"
reclaim_locked >/dev/null 2>&1
ok_eq "a run without deletions (task, or manual run) tells nobody" "" "$(cat "$ARR_CALLS")"

# ─── debounce ─────────────────────────────────────────────────────────────────
echo
echo "watch_loop"
RUNS="$TMP/runs"; : > "$RUNS"
reclaim_locked() { echo "run${*:+ $*}" >> "$RUNS"; return 0; }
RECLAIM_DEBOUNCE=1
printf 'DELETE\t%s\n' "/lib/a.mkv" "/lib/a.srt" "/lib/b.mkv" | watch_loop >/dev/null 2>&1
ok_eq "one burst → one run, with its deleted media" "run /lib/a.mkv /lib/b.mkv" "$(cat "$RUNS")"
: > "$RUNS"
printf 'MOVED_FROM\t/lib/old name.mkv\nDELETE\t/lib/d.mkv\n' | watch_loop >/dev/null 2>&1
ok_eq "a move is reclaimed, never forgotten" "run /lib/d.mkv" "$(cat "$RUNS")"
: > "$RUNS"
printf 'DELETE\t%s\n' "/lib/poster.jpg" | watch_loop >/dev/null 2>&1
printf 'DELETE,ISDIR\t%s\n' "/lib/movies/Dir (2000)" | watch_loop >/dev/null 2>&1
ok_eq "no media in the burst → no run" "0" "$(wc -l < "$RUNS" | tr -d ' ')"
: > "$RUNS"
record_locked() { echo record >> "$RUNS"; return 0; }
RECLAIM_RECORD_EVERY=1
{ sleep 1.5; printf 'DELETE\t%s\n' "/lib/c.mkv"; } | watch_loop >/dev/null 2>&1
ok_eq "idle → a record, then the burst → a run" "record run /lib/c.mkv" "$(tr '\n' ' ' < "$RUNS" | sed 's/ $//')"

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
