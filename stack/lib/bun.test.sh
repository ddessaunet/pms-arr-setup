#!/usr/bin/env bash
# stack/lib/bun.test.sh — stack/lib/bun.sh: which Bun a launcher gets.
#
#   stack/lib/bun.test.sh
#
# Offline, and changes nothing outside a temp dir: the candidates are stub
# scripts that print a version, and the Homebrew fallback is pointed at one.

cd "$(dirname "$0")/../.." || exit 1

PASS=0; FAIL=0
ok_eq() { # label want got
    if [[ "$2" == "$3" ]]; then
        PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"
    else
        FAIL=$((FAIL + 1)); printf '  FAIL  %s\n          want: %q\n          got:  %q\n' "$1" "$2" "$3"
    fi
}

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
stub() { # dir version → a bun in dir that prints version
    mkdir -p "$T/$1"
    printf '#!/bin/sh\necho %s\n' "$2" >"$T/$1/bun"
    chmod +x "$T/$1/bun"
}
stub path 1.4.4
stub old 1.3.9
stub brew 1.5.0
stub pinned 1.4.0

# Runs bun.sh's lookup in a clean shell: PATH holds only $1 (plus coreutils),
# PMS_BUN is $2, and the fallback is $3. Prints "rc BUN BUN_VERSION".
found() { # path-dir pms_bun fallback
    # shellcheck disable=SC2016  # the code runs in the inner shell
    env -i PATH="${1:+$T/$1:}/usr/bin:/bin" PMS_BUN="$2" bash -c '
        BUN_LIB=1; . stack/lib/bun.sh; BUN_FALLBACK="$1"
        pms_bun 2>/dev/null; rc=$?
        printf "%s %s %s" "$rc" "${BUN#"$2"/}" "$BUN_VERSION"' _ "$3" "$T"
}

echo "which bun"
ok_eq "on PATH"                          "0 path/bun 1.4.4"   "$(found path "" "$T/brew/bun")"
ok_eq "not on PATH: Homebrew's"          "0 brew/bun 1.5.0"   "$(found "" "" "$T/brew/bun")"
ok_eq "too old on PATH: Homebrew's"      "0 brew/bun 1.5.0"   "$(found old "" "$T/brew/bun")"
ok_eq "PMS_BUN wins over PATH"           "0 pinned/bun 1.4.0" "$(found path "$T/pinned/bun" "$T/brew/bun")"
ok_eq "PMS_BUN too old: no fallback"     "3  "                "$(found path "$T/old/bun" "$T/brew/bun")"
ok_eq "PMS_BUN missing: no fallback"     "3  "                "$(found path "$T/none/bun" "$T/brew/bun")"
ok_eq "none at all"                      "3  "                "$(found "" "" "$T/none/bun")"
ok_eq "only too old ones"                "3  "                "$(found old "" "$T/old/bun")"

echo
echo "the message"
msg="$(env -i PATH=/usr/bin:/bin PMS_BUN="$T/old/bun" bash -c '. stack/lib/bun.sh' 2>&1)"; rc=$?
ok_eq "sourcing it fails with 3"         "3" "$rc"
ok_eq "names the minimum"                "1" "$(grep -c 'need 1.4.0 or later' <<<"$msg")"
ok_eq "says what it found"               "1" "$(grep -c "$T/old/bun: version '1.3.9'" <<<"$msg")"
ok_eq "says how to install it"           "1" "$(grep -c 'brew install bun && brew pin bun' <<<"$msg")"

echo
echo "versions"
cmp_v() { BUN_LIB=1; . stack/lib/bun.sh; bun_version_at_least "$1" "$2" && echo yes || echo no; }
ok_eq "equal"                    yes "$(cmp_v 1.4.0 1.4.0)"
ok_eq "patch above"              yes "$(cmp_v 1.4.10 1.4.9)"
ok_eq "minor below"              no  "$(cmp_v 1.3.99 1.4.0)"
ok_eq "major above"              yes "$(cmp_v 2.0.0 1.4.0)"
ok_eq "a suffix is ignored"      yes "$(cmp_v 1.4.1-canary.3+abc 1.4.0)"
ok_eq "garbage is not a version" no  "$(cmp_v 'error: oops' 1.4.0)"
ok_eq "empty is not a version"   no  "$(cmp_v '' 1.4.0)"

echo
echo "pins"
min="$(sed -n 's/^PMS_BUN_MIN="\(.*\)"$/\1/p' stack/lib/bun.sh)"
ok_eq ".bun-version (CI's, the box's) is at least PMS_BUN_MIN" yes "$(cmp_v "$(cat .bun-version)" "$min")"
ok_eq "package.json's packageManager is .bun-version" "bun@$(cat .bun-version)" \
    "$(jq -r .packageManager package.json)"

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
