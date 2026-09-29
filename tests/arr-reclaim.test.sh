#!/usr/bin/env bash
# arr-reclaim.test.sh — unit fixtures and a full rehearsal for tools/arr-reclaim.sh
#
#   tests/arr-reclaim.test.sh
#
# Offline, and changes nothing outside $(mktemp -d): the script is sourced with
# ARR_RECLAIM_LIB=1 so main() never runs. The rehearsal builds a real library
# and torrent tree with real hardlinks in a temp dir, and stubs curl as
# qBittorrent and the Radarr/Sonarr history API — so the link counting, the
# decisions and the removals are the real code, on real files.

cd "$(dirname "$0")/.." || exit 1

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export APPDATA="$TMP" LIBRARY="$TMP/lib"
export QBT_ARR_USER=u QBT_ARR_PASS=p RADARR_API_KEY=rk SONARR_API_KEY=sk
export ARR_RECLAIM_LIB=1
# shellcheck source=SCRIPTDIR/../tools/arr-reclaim.sh
. ./tools/arr-reclaim.sh || { echo "cannot source tools/arr-reclaim.sh"; exit 1; }

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
 {"eventType":"downloadFolderImported","downloadId":"ABCDEF0123","data":{"importedPath":"/lib/movies/A (2000)/A (2000).mkv","droppedPath":"/t/a.mkv"}},
 {"eventType":"downloadFolderImported","downloadId":null,"data":{"importedPath":"/lib/manual.mkv"}},
 {"eventType":"downloadFolderImported","downloadId":"ABCDEF0123","data":{"importedPath":"/lib/movies/A (2000)/A (2000).srt"}}]}'
ok_eq "hash lowercased, one line per imported file" \
    "$(printf 'abcdef0123\t/lib/movies/A (2000)/A (2000).mkv\nabcdef0123\t/lib/movies/A (2000)/A (2000).srt')" \
    "$(history_imports "$H")"
ok_eq "a manual import (no downloadId) is nobody's torrent" "0" "$(history_imports "$H" | grep -c manual)"
ok_eq "an empty page is nothing"  "" "$(history_imports '{"records":[]}')"

# ─── login ────────────────────────────────────────────────────────────────────
echo
echo "qbt_login_ok"
ok_rc "5.2: 204, empty body"      0 qbt_login_ok 204 ""
ok_rc "≤5.1: 200 Ok."             0 qbt_login_ok 200 "Ok."
ok_rc "≤5.1: 200 Fails. refused"  1 qbt_login_ok 200 "Fails."
ok_rc "5.2: 401 refused"          1 qbt_login_ok 401 ""
ok_rc "an empty 200 is not a login" 1 qbt_login_ok 200 ""

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

# curl as qBittorrent and as the two history APIs. Deletions are recorded,
# and the torrent data really is deleted, as qBittorrent would.
DELETED="$TMP/deleted"; : > "$DELETED"
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
        *8989/api/v3/history*)          body='{"records":[]}' ;;
        *)                              code=404 ;;
    esac
    if [[ -n "$out" && "$out" != next ]]; then printf '%s' "$body" > "$out"; printf '%s' "$code"
    else printf '%s' "$body"; fi
    [[ "$code" == 2* ]] || [[ "$*" != *-f* ]]
}

OUT="$(reclaim audit 2>&1)"
ok_eq "audit: would remove only the deleted one" "1" "$(grep -c 'would remove' <<<"$OUT")"
ok_eq "audit: and it is 'del'"   "1" "$(grep -c "would remove 'del'" <<<"$OUT")"
ok_eq "audit: changes nothing"   "" "$(cat "$DELETED")"
ok_rc "audit: data still there" 0 test -e "$T/del.mkv"

OUT="$(reclaim run 2>&1)"
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

: > "$DELETED"
reclaim run >/dev/null 2>&1
ok_eq "a second run finds nothing more to remove" "" "$(cat "$DELETED")"

# The cap: with every torrent "deleted", only RECLAIM_MAX_REMOVALS go per run.
echo
echo "reclaim — the cap"
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
    {downloadId: "U2", data: {importedPath: $p}},
    {downloadId: "U3", data: {importedPath: $p}},
    {downloadId: "U1", data: {importedPath: $p}}]}')"
: > "$DELETED"
OUT="$(reclaim run 2>&1)"
ok_eq "only the replaced torrent is removed" "u1" "$(cat "$DELETED")"
ok_eq "and it says why" "1" "$(grep -c "Removed 'up-old'.*an upgrade replaced it" <<<"$OUT")"
ok_rc "the new file is still in the library" 0 test -e "$U/Up (2024).mkv"
ok_rc "its folder is not pruned"             0 test -d "$U"
ok_rc "the new torrent is kept"              0 test -e "$T/up-new.mkv"
ok_rc "superseded but still linked is kept"  0 test -e "$T/re-still.mkv"
ok_eq "summary" "upgraded=1 in-library=2; removed 1." "$(grep -o 'upgraded=.*' <<<"$OUT")"

# ─── debounce ─────────────────────────────────────────────────────────────────
echo
echo "watch_loop"
RUNS="$TMP/runs"; : > "$RUNS"
reclaim_locked() { echo run >> "$RUNS"; return 0; }
RECLAIM_DEBOUNCE=1
printf '%s\n' "/lib/a.mkv" "/lib/a.srt" "/lib/b.mkv" | watch_loop >/dev/null 2>&1
ok_eq "one burst → one run" "1" "$(wc -l < "$RUNS" | tr -d ' ')"
: > "$RUNS"
printf '%s\n' "/lib/poster.jpg" "/lib/movies/Dir (2000)" | watch_loop >/dev/null 2>&1
ok_eq "no media in the burst → no run" "0" "$(wc -l < "$RUNS" | tr -d ' ')"

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
