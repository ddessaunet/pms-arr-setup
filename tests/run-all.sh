#!/usr/bin/env bash
# run-all.sh — runs every *.test.sh suite in this directory.
#
#   ./tests/run-all.sh
#
# Suites are standalone executables that exit non-zero on failure; this only
# sequences them and summarises. Add one by dropping in <subject>.test.sh —
# there is nothing to register.

cd "$(dirname "$(readlink -f "$0")")" || exit 1

suites=(*.test.sh)
[[ -e "${suites[0]}" ]] || { echo "no *.test.sh suites found" >&2; exit 1; }

total=0; failed=0
for suite in "${suites[@]}"; do
    total=$((total + 1))
    printf '── %s ──\n' "$suite"
    if ./"$suite"; then
        printf '   PASS %s\n\n' "$suite"
    else
        failed=$((failed + 1))
        printf '   FAIL %s\n\n' "$suite"
    fi
done

printf '%d suite(s), %d failure(s)\n' "$total" "$failed"
[[ "$failed" -eq 0 ]]
