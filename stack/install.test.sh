#!/usr/bin/env bash
# stack/install.test.sh — stack/install.sh, end to end, in a scratch directory.
#
#   stack/install.test.sh
#
# Offline, and changes nothing outside a temp dir: it copies this repo (without
# git, .env or the site's source, as a download would be) to a scratch source,
# and installs from there with SYS_PREFIX set, so /etc, sudo and the containers
# are never touched. The units themselves are installed by deploy.sh, which needs
# sudo and a live box: `task deploy:check` / `task deploy` are its rehearsal.

cd "$(dirname "$0")/.." || exit 1
ROOT="$PWD"

PASS=0; FAIL=0

ok_eq() { # label want got
    if [[ "$2" == "$3" ]]; then
        PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"
    else
        FAIL=$((FAIL + 1)); printf '  FAIL  %s\n          want: %s\n          got:  %s\n' "$1" "$2" "$3"
    fi
}
ok() { # label cmd...
    local label="$1"; shift
    if "$@" >/dev/null 2>&1; then PASS=$((PASS + 1)); printf '  ok    %s\n' "$label"
    else FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$label"; fi
}

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export SYS_PREFIX="$T"
unset PMS_HOME
TSRC="$T/src"
TDEST="$T/arr-setup"
ME="$(id -un)"

rsync -a --exclude=/.git --exclude=/.claude/ --exclude=/.env --exclude=/.task/ \
    --exclude=/node_modules/ --exclude=/site/node_modules/ --exclude=/site/dist/ --exclude='/site/.*' "$ROOT/" "$TSRC/"
mkdir -p "$TSRC/site/dist"; echo v1 >"$TSRC/site/dist/index.html"
mkdir -p "$TSRC/node_modules/vite-plus"   # as `task bun:install` leaves it

install_() { "$TSRC/stack/install.sh" --files "$@" >"$T/out" 2>&1; }
# The libraries find their tree by $0, so source them through bash -c with $0
# set to the script, as if it ran from where it lives.
in_install_lib() { # code [args...] → runs code with install.sh's functions
    local code="$1"; shift
    bash -c "INSTALL_LIB=1; . \"\$0\"; set +euo pipefail; $code" "$TSRC/stack/install.sh" "$@"
}
# The --check of the files alone; install.sh --check goes on to deploy.sh's,
# which looks at /etc under SYS_PREFIX, where nothing is installed. (The single
# quotes are deliberate: the code runs in the library's shell.)
# shellcheck disable=SC2016
check_files() { in_install_lib 'PMS_USER=$(id -un); PMS_GROUP=$(id -gn); DEST="$1"; check' "$1"; }
resolved() { # asked move → the DEST install.sh would pick
    # shellcheck disable=SC2016
    in_install_lib 'MOVE="$2"; resolve_dest "$1" 2>/dev/null && echo "$DEST"' "$1" "$2"
}
deploy_preflight() { # tree → deploy.sh's preflight, run from that tree
    bash -c 'DEPLOY_LIB=1; . "$0"; set +euo pipefail; preflight' "$1/stack/deploy.sh"
}

# ─── first install ────────────────────────────────────────────────────────────
echo "first install, no .env anywhere"
install_ "$TDEST"; rc=$?
ok_eq "stops so .env can be filled in" 3 "$rc"
ok "seeds .env from .env.example" cmp "$TSRC/.env.example" "$TDEST/.env"
ok_eq ".env is private" 600 "$(stat -c %a "$TDEST/.env")"
ok "not marked installed yet" test ! -e "$TDEST/.pms-install"

echo
echo "second run, .env filled in"
echo "SECRET=keep" >"$TDEST/.env"
install_ "$TDEST"; rc=$?
ok_eq "succeeds" 0 "$rc"
ok_eq ".env is left alone" "SECRET=keep" "$(cat "$TDEST/.env")"
ok "marked installed" test -f "$TDEST/.pms-install"
ok "marker works without git" grep -qx "version=unknown" "$TDEST/.pms-install"
ok "stack/installed.sh passes in the install" "$TDEST/stack/installed.sh"
ok "stack/installed.sh refuses the source" bash -c "! '$TSRC/stack/installed.sh'"

# ─── what is in it ────────────────────────────────────────────────────────────
echo
echo "the install's contents"
ok_eq "no tests" "" "$(cd "$TDEST" && find . -name '*.test.sh' -o -name '*.test.ts' -o -name testdata | head -3)"
ok_eq "no dev tools: package.json, bun.lock, tsconfig, Vite+ config, .bun-version, node_modules" "" \
    "$(cd "$TDEST" && ls -d package.json bun.lock tsconfig.json vite.config.ts .bun-version node_modules 2>/dev/null)"
ok "no generated API types (stack/lib/api/)" test ! -e "$TDEST/stack/lib/api"
ok_eq "the TypeScript sources" "$(cd "$TSRC" && find stack/lib -path stack/lib/api -prune -o -name '*.ts' ! -name '*.test.ts' -print | sort)" \
    "$(cd "$TDEST" && find stack/lib -name '*.ts' | sort)"
ok "Bun's finder" test -f "$TDEST/stack/lib/bun.sh"
ok "no docs/" test ! -e "$TDEST/docs"
ok "no CI workflows" test ! -e "$TDEST/.github"
ok "no site source" test ! -e "$TDEST/site/src"
ok "site/dist published" grep -qx v1 "$TDEST/site/dist/index.html"
ok "compose.yaml" test -f "$TDEST/compose.yaml"
ok_eq "every app's compose.yaml" "$(cd "$TSRC" && ls apps/*/compose.yaml)" "$(cd "$TDEST" && ls apps/*/compose.yaml)"
ok_eq "every configure.sh" "$(cd "$TSRC" && ls apps/*/configure.sh)" "$(cd "$TDEST" && ls apps/*/configure.sh)"

echo
echo "rendered units"
for u in "$TDEST"/jobs/*/*.service; do
    n="$(basename "$u")"
    exe="$(sed -n 's/^ExecStart=//p' "$u" | awk '{print $1}')"
    ok "$n runs from the install" test "${exe#"$TDEST"/}" != "$exe"
    ok "$n runs an executable there" test -x "$exe"
    ok_eq "$n runs as the installing user" "$ME" "$(sed -n 's/^User=//p' "$u")"
    ok_eq "$n has no placeholder left outside comments" "" "$(grep -n '^[^#]*@PMS_' "$u")"
done
ok "the source keeps its templates" grep -q '^ExecStart=@PMS_HOME@/' "$TSRC/jobs/arr-reclaim/arr-reclaim.service"

echo
echo "every script finds the install as its root"
while IFS= read -r f; do
    line="$(grep -m1 '^REPO=' "$TDEST/$f")"
    # shellcheck disable=SC2016  # the literal text in the script is what is replaced
    line="${line//'${BASH_SOURCE[0]}'/$TDEST/$f}"
    # shellcheck disable=SC2016
    line="${line//'$0'/$TDEST/$f}"
    ok_eq "$f" "$TDEST" "$(eval "$line"; printf '%s' "$REPO")"
done < <(cd "$TDEST" && grep -l '^REPO=' apps/*/*.sh jobs/*/*.sh stack/*.sh stack/lib/*.sh | sort)

echo
echo "deploy.sh"
ok "accepts the install" deploy_preflight "$TDEST"
ok_eq "refuses the source tree (its units are templates)" 1 "$(deploy_preflight "$TSRC" >/dev/null 2>&1; echo $?)"

# ─── updates ──────────────────────────────────────────────────────────────────
echo
echo "updating"
ok "a fresh install has no drift" check_files "$TDEST"
echo "# changed" >>"$TSRC/apps/decluttarr/config.yaml"
ok_eq "a changed source file is drift" 1 "$(check_files "$TDEST" >/dev/null; echo $?)"
rm "$TSRC/jobs/arr-reclaim/README.md"
echo v2 >"$TSRC/site/dist/index.html"
install_ "$TDEST"
ok "the change is copied" grep -qx "# changed" "$TDEST/apps/decluttarr/config.yaml"
ok "a file the source dropped is removed" test ! -e "$TDEST/jobs/arr-reclaim/README.md"
ok "the new site is swapped in" grep -qx v2 "$TDEST/site/dist/index.html"
ok_eq "no swap leftovers" "dist" "$(find "$TDEST/site" -mindepth 1 -maxdepth 1 -printf '%f\n')"
ok_eq ".env still left alone" "SECRET=keep" "$(cat "$TDEST/.env")"
ok "no drift after" check_files "$TDEST"
before="$(stat -c %Y "$TDEST/jobs/arr-reclaim/arr-reclaim.service")"
sleep 1; install_ "$TDEST"
ok_eq "an unchanged unit is not rewritten" "$before" "$(stat -c %Y "$TDEST/jobs/arr-reclaim/arr-reclaim.service")"

# ─── where ────────────────────────────────────────────────────────────────────
echo
echo "where it installs"
ok_eq "nothing installed: the default" /opt/arr-setup "$(resolved "" 0)"
mkdir -p "$T/etc/systemd/system"
cp "$TDEST/jobs/arr-reclaim/arr-reclaim.service" "$T/etc/systemd/system/"
ok_eq "installed: where the units run from" "$TDEST" "$(resolved "" 0)"
ok_eq "installed: the same place, asked" "$TDEST" "$(resolved "$TDEST" 0)"
ok_eq "installed: elsewhere is refused" "" "$(resolved "$T/other" 0)"
ok_eq "installed: elsewhere with --move" "$T/other" "$(resolved "$T/other" 1)"
ok_eq "inside the source is refused" "" "$(resolved "$TSRC/inst" 1)"
ok_eq "a path with a space is refused" "" "$(resolved "$T/a b" 1)"
sed -i "s#^ExecStart=.*#ExecStart=$TSRC/jobs/arr-reclaim/arr-reclaim.sh watch#" "$T/etc/systemd/system/arr-reclaim.service"
ok_eq "units from before installs (run from a clone): the default" /opt/arr-setup "$(resolved "" 0)"

# ─── binds ────────────────────────────────────────────────────────────────────
# A file bound into a container from the tree must be in BIND_FILES, or an
# update would leave the container reading the replaced file.
echo
echo "file binds"
want="$(cd "$TSRC" && for c in apps/*/compose.yaml; do
    d="${c%/compose.yaml}"
    sed -n 's#^ *- \./\([^:]*\):.*#\1#p' "$c" | while read -r f; do
        [[ -f "$d/$f" && "$d" != apps/recyclarr ]] && echo "${d#apps/}|$d/$f"
    done
done | sort)"
# shellcheck disable=SC2016
got="$(in_install_lib 'printf "%s\n" "${BIND_FILES[@]}"' | sort)"
ok_eq "BIND_FILES is every single-file bind (recyclarr runs one-shot)" "$want" "$got"

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
