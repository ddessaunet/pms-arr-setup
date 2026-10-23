#!/usr/bin/env bash
# stack/run-tests.sh — runs every *.test.sh suite in apps/, jobs/ and stack/,
# then every *.test.ts in them with `bun test`.
#
#   stack/run-tests.sh      (task test)
#
# Suites are standalone executables that exit non-zero on failure; this only
# sequences them and summarises. A suite lives beside what it tests; add one by
# dropping in <subject>.test.sh or <subject>.test.ts — there is nothing to register.
# The TypeScript ones count as one suite here; bun prints its own per-test lines.
#
# Only those three trees are searched, never the whole checkout: .claude/worktrees/
# holds other branches' copies of every suite, and site/ has its own (Vitest,
# task site:test). Bun comes from stack/lib/bun.sh, as for the launchers.

cd "$(dirname "$(readlink -f "$0")")/.." || exit 1

mapfile -t suites < <(find apps jobs stack -name '*.test.sh' -type f | sort)
[[ ${#suites[@]} -gt 0 ]] || { echo "no *.test.sh suites found" >&2; exit 1; }

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

total=$((total + 1))
printf '── bun test ./apps ./jobs ./stack ──\n'
# shellcheck source=SCRIPTDIR/lib/bun.sh
if (. stack/lib/bun.sh && "$BUN" test ./apps ./jobs ./stack); then
    printf '   PASS bun test\n\n'
else
    failed=$((failed + 1))
    printf '   FAIL bun test\n\n'
fi

printf '%d suite(s), %d failure(s)\n' "$total" "$failed"
[[ "$failed" -eq 0 ]]
