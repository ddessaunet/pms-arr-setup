#!/usr/bin/env bash
# cutover-plex.test.sh — unit fixtures for tools/cutover-plex.sh
#
#   tests/cutover-plex.test.sh
#
# Offline, and changes nothing: the script is sourced with CUTOVER_PLEX_LIB=1
# so main() never runs, curl is stubbed, and the only files written are under
# $(mktemp -d).
#
# Not covered, because it needs a live box and sudo: stopping native Plex, the
# copy, the container start and the rollback. `tools/cutover-plex.sh --dry-run`
# rehearses every precondition against the real server.

cd "$(dirname "$0")/.." || exit 1

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export APPDATA="$TMP"
export LOG_FILE=/dev/null
export CUTOVER_PLEX_LIB=1
# shellcheck source=SCRIPTDIR/../tools/cutover-plex.sh
. ./tools/cutover-plex.sh || { echo "cannot source tools/cutover-plex.sh"; exit 1; }

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

# ─── versions ─────────────────────────────────────────────────────────────────
# The one decision that can lose data: an older image opening a database a
# newer Plex already migrated.
echo "version_decision"
ok_rc "same version → go"             0 version_decision 1.43.4.10903-e5521bd8c 1.43.4.10903-e5521bd8c
ok_rc "image newer → warn, go"        2 version_decision 1.43.4.10903-e5521bd8c 1.43.5.11000-aaaaaaaa
ok_rc "image older → abort"           1 version_decision 1.43.4.10903-e5521bd8c 1.42.2.10156-f737b826c
ok_rc "same release, older build → abort" \
                                      1 version_decision 1.43.4.10903-e5521bd8c 1.43.4.10800-e5521bd8c

# ─── state file ───────────────────────────────────────────────────────────────
echo
echo "state file"
S="$TMP/state"
state_write "$S" "IDENT=f3860770aca2" "TRASH=1" "COUNTS=2=132 3=7 5=2 4=5"
ok_eq "reads IDENT"                  "f3860770aca2"         "$(state_get IDENT "$S")"
ok_eq "reads a value with = and spaces" "2=132 3=7 5=2 4=5" "$(state_get COUNTS "$S")"
ok_eq "missing key → empty"          ""                     "$(state_get NOPE "$S")"
ok_eq "missing file → empty"         ""                     "$(state_get IDENT "$TMP/none")"
# shellcheck disable=SC2016  # the literal $(...) is the attack being tested
printf 'IDENT=x\n$(touch %s/pwned)\nTRASH=0\n' "$TMP" >"$S"
state_get TRASH "$S" >/dev/null
ok_eq "parsed, never sourced"        "absent" "$([[ -e $TMP/pwned ]] && echo present || echo absent)"
ok_eq "last value wins"              "0"      "$(printf 'TRASH=1\nTRASH=0\n' >"$S"; state_get TRASH "$S")"

# ─── counts ───────────────────────────────────────────────────────────────────
echo
echo "counts_match"
ok_rc "identical"                    0 counts_match "2=132 3=7 5=2 4=5" "2=132 3=7 5=2 4=5"
ok_rc "order does not matter"        0 counts_match "2=132 3=7 5=2 4=5" "4=5 5=2 3=7 2=132"
ok_rc "one title missing → differ"   1 counts_match "2=132 3=7 5=2 4=5" "2=131 3=7 5=2 4=5"
ok_rc "a section missing → differ"   1 counts_match "2=132 3=7 5=2 4=5" "2=132 3=7 5=2"
ok_rc "empty scan → differ"          1 counts_match "2=132 3=7 5=2 4=5" "2=0 3=0 5=0 4=0"

# ─── section_counts against a stubbed API ─────────────────────────────────────
echo
echo "section_counts"
# shellcheck disable=SC2329  # stubs, called indirectly through api()
curl() {
    local url="${*: -1}"
    case "$url" in
        */library/sections)
            printf '%s\n' '<MediaContainer size="2">' \
                '<Directory allowSync="1" key="2" type="movie" title="Movies">' \
                '<Location id="1" path="/mnt/data/streaming/movies" />' \
                '</Directory>' \
                '<Directory allowSync="1" key="3" type="show" title="TV Shows">' \
                '<Location id="2" path="/mnt/data/streaming/series" />' \
                '</Directory></MediaContainer>' ;;
        */library/sections/2/all) printf '<MediaContainer size="132" librarySectionID="2">' ;;
        */library/sections/3/all) printf '<MediaContainer size="7" librarySectionID="3">' ;;
        *) return 22 ;;
    esac
}
TOKEN=t
ok_eq "key=count per section"        "2=132 3=7" "$(section_counts)"
ok_eq "library paths"                "/mnt/data/streaming/movies /mnt/data/streaming/series" \
                                     "$(section_paths | paste -sd' ')"
curl() { return 7; }
ok_rc "Plex down → error, not empty" 1 section_counts

# ─── summary ──────────────────────────────────────────────────────────────────
echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
