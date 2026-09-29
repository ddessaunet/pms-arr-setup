#!/usr/bin/env bash
# update-stack.test.sh — unit fixtures for tools/update-stack.sh
#
#   tests/update-stack.test.sh
#
# Offline, and changes nothing: the script is sourced with UPDATE_STACK_LIB=1
# so main() never runs, curl is replaced by a stub, and the only file written
# is a fake Preferences.xml under $(mktemp -d).
#
# Not covered, because it needs a live box: pull, recreate, the health wait and
# the rollback. docs/updating.md has the rehearsal for those.

cd "$(dirname "$0")/.." || exit 1

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export APPDATA="$TMP"
export PLEX_PREFS="$TMP/Preferences.xml"
export UPDATE_STACK_LIB=1
# shellcheck source=SCRIPTDIR/../tools/update-stack.sh
. ./tools/update-stack.sh || { echo "cannot source tools/update-stack.sh"; exit 1; }

log() { :; }   # keep the output to test results

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

# ─── hooks ────────────────────────────────────────────────────────────────────
echo "hook"
ok_eq "plex → gate_plex"             "gate_plex"             "$(hook gate plex)"
ok_eq "dashes become underscores"    "gate_radarr_4k"        "$(hook gate radarr-4k)"
ok_rc "plex has a gate"              0 has_hook gate plex
ok_rc "plex has an identity check"   0 has_hook identity plex
ok_rc "a new service has no gate"    1 has_hook gate qbittorrent
ok_eq "short image id"               "0123456789ab"          "$(short sha256:0123456789abcdef)"

# ─── token ────────────────────────────────────────────────────────────────────
echo
echo "plex_token"
ok_eq "no Preferences.xml → empty"   "" "$(plex_token)"
printf '<?xml version="1.0"?>\n<Preferences MachineIdentifier="abc" PlexOnlineToken="tOkEn123" PlexOnlineUsername="u"/>\n' >"$PLEX_PREFS"
ok_eq "reads PlexOnlineToken"        "tOkEn123" "$(plex_token)"

# ─── the session parser ───────────────────────────────────────────────────────
echo
echo "session_count"
ok_eq "size=0 → 0"  "0" "$(session_count '<MediaContainer size="0">')"
ok_eq "size=2 → 2"  "2" "$(session_count '<?xml version="1.0"?>
<MediaContainer size="2" allowSync="1">')"
ok_eq "librarySize is not size" "1" "$(session_count '<MediaContainer librarySize="9" size="1">')"
ok_rc "not XML is an error"   2 session_count 'Fails.'
ok_rc "no size is an error"   2 session_count '<MediaContainer>'

# ─── the streaming gate ───────────────────────────────────────────────────────
# curl is stubbed: STUB_BODY is what it prints, STUB_RC its exit status.
echo
echo "gate_plex"
curl() { printf '%s' "${STUB_BODY:-}"; return "${STUB_RC:-0}"; }
gate_as() { STUB_BODY="$1" STUB_RC="$2" gate_plex; }

ok_rc "nobody watching → clear"         0 gate_as '<MediaContainer size="0">' 0
ok_rc "someone watching → defer"        1 gate_as '<MediaContainer size="1">' 0
ok_rc "token rejected (401) → 4"        4 gate_as '' 22
ok_rc "refused → 5, never a guess"      5 gate_as '' 7
ok_rc "timed out → 5"                   5 gate_as '' 28
ok_rc "garbage answer → 5"              5 gate_as 'Fails.' 0
rm -f "$PLEX_PREFS"
ok_rc "no token at all → 4"             4 gate_as '<MediaContainer size="0">' 0

# ─── identity ─────────────────────────────────────────────────────────────────
echo
echo "identity_plex / version_plex"
IDENT='<?xml version="1.0" encoding="UTF-8"?>
<MediaContainer size="0" apiVersion="1.2.3" claimed="1" machineIdentifier="f3860770aca2" version="1.43.4.10903-e5521bd8c">'
ok_eq "machineIdentifier"  "f3860770aca2"            "$(STUB_BODY="$IDENT" identity_plex)"
ok_eq "server version, not the XML or API version" \
                           "1.43.4.10903-e5521bd8c"  "$(STUB_BODY="$IDENT" version_plex)"
ok_eq "no answer → empty"  ""                        "$(STUB_BODY="" STUB_RC=7 identity_plex)"

# ─── summary ──────────────────────────────────────────────────────────────────
echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
