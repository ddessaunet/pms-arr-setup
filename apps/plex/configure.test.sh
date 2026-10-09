#!/usr/bin/env bash
# apps/plex/configure.test.sh — unit fixtures for apps/plex/configure.sh
#
#   apps/plex/configure.test.sh
#
# Offline, and changes nothing: sourced with PLEX_CONFIGURE_LIB=1 so main()
# never runs. The live behaviour was checked on the real Plex 1.43.4:
# - GET /:/prefs with Accept: application/json returns MediaContainer.Setting[],
#   PreferredNetworkInterface among them, with value "" for Any and enumValues
#   listing the host's interfaces with their current addresses
# - PUT /:/prefs?PreferredNetworkInterface=eno1 sets it; the .env PLEX_TOKEN
#   is accepted

cd "$(dirname "$0")/../.." || exit 1

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export PLEX_CONFIGURE_LIB=1 PLEX_TOKEN=pt
# shellcheck source=SCRIPTDIR/configure.sh
. ./apps/plex/configure.sh || { echo "cannot source apps/plex/configure.sh"; exit 1; }

PASS=0; FAIL=0
ok_eq() { # label want got
    if [[ "$2" == "$3" ]]; then
        PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"
    else
        FAIL=$((FAIL + 1)); printf '  FAIL  %s\n          want: %q\n          got:  %q\n' "$1" "$2" "$3"
    fi
}

# As Plex 1.43.4 returns it, trimmed to two settings.
prefs() { # value
    jq -cn --arg v "$1" '{MediaContainer: {size: 2, Setting: [
        {id: "FriendlyName", type: "text", default: "", value: "Local PMS"},
        {id: "PreferredNetworkInterface", label: "Preferred network interface", type: "text",
         default: "", value: $v, advanced: true, group: "network",
         enumValues: ":Any|eno1:eno1 (192.168.0.86)|wlp2s0:wlp2s0 (192.168.0.66)|docker0:docker0 (172.17.0.1)"}]}}'
}

echo "the wanted setting"
ok_eq "the wired NIC by default" "eno1" "$PLEX_IFACE"
ok_eq "Plex's id for it"          "PreferredNetworkInterface" "$PREF"

echo
echo "pref_value"
ok_eq "Any is the empty value"       ""     "$(pref_value "$(prefs '')" "$PREF")"
ok_eq "a set interface"              "eno1" "$(pref_value "$(prefs eno1)" "$PREF")"
if pref_value "$(prefs '')" "$PREF" >/dev/null; then r=found; else r=missing; fi
ok_eq "Any still counts as present"  "found" "$r"
if pref_value "$(prefs '')" NoSuchPref >/dev/null; then r=found; else r=missing; fi
ok_eq "an absent setting fails"      "missing" "$r"
if pref_value 'not json' "$PREF" >/dev/null; then r=found; else r=missing; fi
ok_eq "a non-JSON body fails"        "missing" "$r"

echo
echo "pref_choices / iface_addr"
ok_eq "every offered interface, Any first" " eno1 wlp2s0 docker0" "$(pref_choices "$(prefs '')" "$PREF" | paste -sd' ' -)"
ok_eq "eno1's address"               "192.168.0.86" "$(iface_addr "$(prefs '')" "$PREF" eno1)"
ok_eq "wlp2s0 is not eno1"           "192.168.0.66" "$(iface_addr "$(prefs '')" "$PREF" wlp2s0)"
ok_eq "unknown interface → empty"    ""             "$(iface_addr "$(prefs '')" "$PREF" eth9)"
if has_choice "$(prefs '')" "$PREF" eno1; then r=yes; else r=no; fi
ok_eq "eno1 is offered"              "yes" "$r"
if has_choice "$(prefs '')" "$PREF" eno; then r=yes; else r=no; fi
ok_eq "a prefix is not a match"      "no"  "$r"
if has_choice "$(prefs '')" "$PREF" eth0; then r=yes; else r=no; fi
ok_eq "a missing NIC is refused"     "no"  "$r"

echo
echo "prefs_token"
printf '<?xml version="1.0" encoding="utf-8"?>\n<Preferences MachineIdentifier="abc" PlexOnlineToken="tOkEn123" PlexOnlineUsername="u"/>\n' >"$TMP/Preferences.xml"
ok_eq "PlexOnlineToken from Preferences.xml" "tOkEn123" "$(prefs_token "$TMP/Preferences.xml")"
ok_eq "missing file → empty, no error"       ""         "$(prefs_token "$TMP/none.xml")"

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
