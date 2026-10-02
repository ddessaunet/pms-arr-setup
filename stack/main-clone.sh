#!/usr/bin/env bash
# stack/main-clone.sh — succeed only in the main clone, never in a worktree.
#
#   stack/main-clone.sh     (a precondition of every task that changes the stack)
#
# compose.yaml fixes the project name (pms), so compose run from ANY checkout
# acts on the live containers — and a relative bind (decluttarr's config.yaml)
# then points into that checkout, which breaks once the worktree is deleted.
# Read-only tasks and the configure scripts (which talk to the apps' APIs, not
# to compose) are not guarded.

cd "$(dirname "$(readlink -f "$0")")/.." || exit 1

git_dir="$(git rev-parse --absolute-git-dir 2>/dev/null)" || exit 0  # not a git checkout: nothing to tell apart
common="$(git rev-parse --path-format=absolute --git-common-dir)"
[[ "$git_dir" == "$common" ]] && exit 0

echo "This is a worktree ($PWD). Containers and units must come from the main clone," >&2
echo "or their binds and paths point into a checkout that will be deleted." >&2
exit 1
