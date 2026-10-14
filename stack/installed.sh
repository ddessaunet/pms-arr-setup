#!/usr/bin/env bash
# stack/installed.sh — succeed only in an install, never in a source tree.
#
#   stack/installed.sh     (a precondition of every task that changes the stack)
#
# compose.yaml fixes the project name (pms), so compose run from ANY tree acts
# on the live containers — and a relative bind (decluttarr's config.yaml, the
# docs site) then points into that tree, which breaks once it moves or is
# deleted. Containers and units come from the install that stack/install.sh
# made, which a clone, a worktree or a download never is. Read-only tasks and
# the configure scripts (which talk to the apps' APIs, not to compose) are not
# guarded.

cd "$(dirname "$(readlink -f "$0")")/.." || exit 1
# shellcheck source=SCRIPTDIR/lib/pms-home.sh
. stack/lib/pms-home.sh

[[ -e "$PMS_MARKER" ]] && exit 0

echo "This is a source tree ($PWD), not the install. Containers and units come from" >&2
echo "the install, or their binds and paths point into a tree that can move:" >&2
echo "  cd $(pms_home_hint)    (task deploy installs it first)" >&2
exit 1
