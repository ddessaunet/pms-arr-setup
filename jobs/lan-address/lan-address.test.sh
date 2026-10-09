#!/usr/bin/env bash
# jobs/lan-address/lan-address.test.sh — unit fixtures for jobs/lan-address/lan-address.sh,
# and the names it shares with its units and Taskfile.yml.
#
#   jobs/lan-address/lan-address.test.sh
#
# Offline, and changes nothing outside a scratch folder: sourced with
# LAN_ADDRESS_LIB=1 so main() runs only in subshells, with the addresses and the
# configure scripts stood in for.

cd "$(dirname "$0")/../.." || exit 1

export LAN_ADDRESS_LIB=1
# shellcheck source=SCRIPTDIR/lan-address.sh
. ./jobs/lan-address/lan-address.sh || { echo "cannot source jobs/lan-address/lan-address.sh"; exit 1; }

PASS=0; FAIL=0
ok_eq() { # label want got
    if [[ "$2" == "$3" ]]; then
        PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"
    else
        FAIL=$((FAIL + 1)); printf '  FAIL  %s\n          want: %q\n          got:  %q\n' "$1" "$2" "$3"
    fi
}

SCRATCH="$(mktemp -d)"; trap 'rm -rf "$SCRATCH"' EXIT

# ─── addresses ────────────────────────────────────────────────────────────────
echo "addresses_now"
# shellcheck disable=SC2329  # stands in for servarr.sh's, called by addresses_now
lan_ips() { printf '%s\n' 192.168.0.87 192.168.0.67 192.168.0.87; }
ok_eq "sorted, deduplicated, one line" "192.168.0.67 192.168.0.87" "$(addresses_now)"
# shellcheck disable=SC2329
lan_ips() { :; }
ok_eq "none yet → empty" "" "$(addresses_now)"

# ─── state ────────────────────────────────────────────────────────────────────
echo
echo "state_of / state_set / pending_apps"
S=$'prowlarr 192.168.0.66 192.168.0.86\nqbittorrent 192.168.0.67 192.168.0.87'
NOW="192.168.0.67 192.168.0.87"
ok_eq "reads an app's addresses"        "192.168.0.66 192.168.0.86" "$(state_of "$S" prowlarr)"
ok_eq "an app never applied → empty"    ""  "$(state_of "$S" seerr)"
ok_eq "no app is a prefix of another"   ""  "$(state_of "$S" prowl)"
ok_eq "set replaces the app's line" $'prowlarr 192.168.0.67 192.168.0.87\nqbittorrent 192.168.0.67 192.168.0.87' \
    "$(state_set "$S" prowlarr "$NOW")"
ok_eq "set adds a new app, sorted" $'prowlarr 192.168.0.66 192.168.0.86\nqbittorrent 192.168.0.67 192.168.0.87\nradarr 192.168.0.67 192.168.0.87' \
    "$(state_set "$S" radarr "$NOW")"
ok_eq "set on empty state"              "seerr $NOW" "$(state_set "" seerr "$NOW")"
ok_eq "pending: changed and never applied, not current" $'prowlarr\nradarr' \
    "$(pending_apps "$S" "$NOW" qbittorrent prowlarr radarr)"
ok_eq "pending: nothing when all current" "" \
    "$(pending_apps "qbittorrent $NOW" "$NOW" qbittorrent)"

# ─── a run, with the configure scripts stood in for ───────────────────────────
echo
echo "main"
export LAN_ADDRESS_STATE="$SCRATCH/state" LAN_ADDRESS_LOCK="$SCRATCH/lock"
export LAN_ADDRESS_APPS="qbittorrent prowlarr seerr"
RAN="$SCRATCH/ran"
# The apps listed in $FAILING fail; every call is logged to $RAN.
# shellcheck disable=SC2329  # stands in for the real one, called by main
run_configure() { echo "$1" >> "$RAN"; [[ " ${FAILING:-} " != *" $1 "* ]]; }
run() { # addresses args... → exit code; output discarded
    : > "$RAN"
    ( addresses_now() { echo "$ADDR"; }; main "$@" ) >/dev/null 2>&1
}
ran() { paste -sd' ' "$RAN"; }

ADDR="192.168.0.67 192.168.0.87" FAILING=prowlarr run; rc=$?
ok_eq "first run: every app"                    "qbittorrent prowlarr seerr" "$(ran)"
ok_eq "a failure → exit 1"                      "1" "$rc"
ok_eq "only the apps that applied are recorded" $'qbittorrent 192.168.0.67 192.168.0.87\nseerr 192.168.0.67 192.168.0.87' \
    "$(cat "$LAN_ADDRESS_STATE")"

ADDR="192.168.0.67 192.168.0.87" run; rc=$?
ok_eq "next run: only the one that failed"      "prowlarr" "$(ran)"
ok_eq "all applied → exit 0"                    "0" "$rc"

ADDR="192.168.0.67 192.168.0.87" run; rc=$?
ok_eq "no change: nothing runs"                 "" "$(ran)"
ok_eq "no change → exit 0"                      "0" "$rc"

ADDR="192.168.0.66 192.168.0.86" run --dry-run; rc=$?
ok_eq "dry run: nothing runs"                   "" "$(ran)"
ok_eq "dry run: state untouched"                "3" "$(grep -c '192.168.0.67 192.168.0.87' "$LAN_ADDRESS_STATE")"

ADDR="192.168.0.66 192.168.0.86" run
ok_eq "an address change: every app again"      "qbittorrent prowlarr seerr" "$(ran)"
ok_eq "and all recorded at the new addresses"   "3" "$(grep -c '192.168.0.66 192.168.0.86$' "$LAN_ADDRESS_STATE")"

ADDR="192.168.0.66 192.168.0.86" run --force
ok_eq "--force: every app, changed or not"      "qbittorrent prowlarr seerr" "$(ran)"

ADDR="" run; rc=$?
ok_eq "no address yet: nothing runs, exit 0"    " 0" "$(ran) $rc"

ADDR="192.168.0.66 192.168.0.86" run --bogus; rc=$?
ok_eq "unknown argument → exit 2"               "2" "$rc"
unset LAN_ADDRESS_APPS

# ─── one name, several owners ─────────────────────────────────────────────────
echo
echo "the units and the app list"
ok_eq "the timer runs this script" "/home/dario/repositories/pms-arr-setup/jobs/lan-address/lan-address.sh" \
    "$(sed -n 's/^ExecStart=//p' jobs/lan-address/lan-address.service)"
ok_eq "the unit allows netlink, which hostname -I needs" "1" \
    "$(grep -c '^RestrictAddressFamilies=.*AF_NETLINK' jobs/lan-address/lan-address.service)"
ok_eq "the timer fires after boot and every 5 minutes" $'OnBootSec=2min\nOnUnitActiveSec=5min' \
    "$(grep -E '^On(Boot|UnitActive)Sec=' jobs/lan-address/lan-address.timer)"
# Every app with a configure.sh, in Taskfile.yml's order, except Bazarr (no
# address) and Plex (pinned to an interface name, not an address).
ok_eq "the apps are CONFIGURED minus bazarr and plex" \
    "$(sed -n 's/^  CONFIGURED: //p' Taskfile.yml | tr ' ' '\n' | grep -vxE 'bazarr|plex' | paste -sd' ')" \
    "$(LAN_ADDRESS_LIB=1 bash -c '. ./jobs/lan-address/lan-address.sh && echo "$LAN_ADDRESS_APPS"')"
for app in $(LAN_ADDRESS_LIB=1 bash -c '. ./jobs/lan-address/lan-address.sh && echo "$LAN_ADDRESS_APPS"'); do
    ok_eq "apps/$app/configure.sh is executable" "yes" "$([[ -x "apps/$app/configure.sh" ]] && echo yes)"
done

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
