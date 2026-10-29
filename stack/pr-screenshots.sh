#!/usr/bin/env bash
# stack/pr-screenshots.sh — publish screenshots for a pull request's description.
#
#   stack/pr-screenshots.sh <pr> <png>...    (task site:screenshot writes them)
#
# GitHub has no API for attaching an image to a PR, so the images go to the
# pr-screenshots branch (no shared history with main; never merged), under
# pr-<n>/, and this prints one Markdown image line per file to paste into the
# description. The links name the commit, not the branch, so shooting again
# later never changes what an older description shows. The commit is made with
# plumbing on a scratch index: no worktree, and the checkout is not touched.

set -euo pipefail

BRANCH='pr-screenshots'

if [[ $# -lt 2 || ! $1 =~ ^[0-9]+$ ]]; then
    echo "usage: $0 <pr number> <png>..." >&2
    exit 2
fi
pr="$1"
shift
files=()
for f in "$@"; do
    [[ -f "$f" && "$f" == *.png ]] || { echo "Not a .png file: $f" >&2; exit 2; }
    files+=("$(readlink -f "$f")")
done

cd "$(dirname "$(readlink -f "$0")")/.." || exit 1
repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export GIT_INDEX_FILE="$tmp/index"

parent=()
if git fetch -q origin "refs/heads/$BRANCH" 2>/dev/null; then
    git read-tree FETCH_HEAD
    parent=(-p "$(git rev-parse FETCH_HEAD)")
else
    git read-tree --empty # the first one: the branch starts here
fi

names=()
for f in "${files[@]}"; do
    name="$(basename "$f")"
    git update-index --add --cacheinfo "100644,$(git hash-object -w "$f"),pr-$pr/$name"
    names+=("$name")
done
commit="$(git commit-tree "$(git write-tree)" "${parent[@]}" -m "add screenshots for #$pr")"
# Not forced: if someone else pushed in between, this fails, and running it again is safe.
git push -q origin "$commit:refs/heads/$BRANCH" 2>&1 | { grep -v '^remote:' >&2 || true; }

for name in "${names[@]}"; do
    echo "![${name%.png}](https://raw.githubusercontent.com/$repo/$commit/pr-$pr/$name)"
done
