#!/usr/bin/env bash
# stack/layout.test.sh — the app contract: every app and job has the same shape.
#
#   stack/layout.test.sh
#
# Offline, and changes nothing: it reads files, and asks task for its task list
# when task is installed (TASK names the binary; `task test` sets it).
#
# The contract (README → "The app contract"):
#   apps/<app>/  compose.yaml with exactly the service <app>, no project name, no
#                .env beside it; Taskfile.yml; README.md with the standard
#                sections; included by compose.yaml and the root Taskfile.yml.
#                configure.sh, when present, takes --check, has a test, and is in
#                the root CONFIGURED list. The template tasks match what the app
#                is (EXPECT below).
#   jobs/<job>/  a script, its unit(s), a test, README.md, Taskfile.yml; every
#                unit is in stack/deploy.sh's MANIFEST, and its ExecStart exists.
#   launchers    a script in TypeScript keeps its .sh as a launcher: it
#                sources stack/lib/bun.sh and execs the .ts beside it. Its
#                --check is looked for in the .ts, and a *.test.ts counts as
#                its test.
#   every script finds the repo root, whatever its depth.

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

# Which per-app tasks each app must have — and must not. A long-running service
# gets the service verbs; one on the weekly updater, update; one with settings
# in this repo, configure/check. The exceptions say why.
#   recyclarr   one-shot tool: no logs/up/update, its own preview/sync
#   decluttarr  pinned image (bump the tag by hand): no update
#   maintainerr pinned image, like decluttarr, and its settings live here
SERVICE_TASKS="logs ps up"
UPDATE_TASKS="update update:dry"
CONFIGURE_TASKS="check configure"
expect_tasks() { # app → sorted task names
    local t
    case "$1" in
        recyclarr)  t="preview sync" ;;
        decluttarr) t="$SERVICE_TASKS" ;;
        maintainerr) t="$SERVICE_TASKS $CONFIGURE_TASKS" ;;
        *)          t="$SERVICE_TASKS $UPDATE_TASKS"
                    [[ -f "apps/$1/configure.sh" ]] && t+=" $CONFIGURE_TASKS" ;;
    esac
    tr ' ' '\n' <<<"$t" | sort | paste -sd' '
}

# ─── launchers ────────────────────────────────────────────────────────────────
# The exact lines a launcher has (README → "The app contract"), and what is
# wrong with one: nothing, when it is well-formed. Paths are relative to $1.
# shellcheck disable=SC2016  # the literal text in the launcher is what is matched
LAUNCHER_SOURCE='. "$REPO/stack/lib/bun.sh" || exit 3'
# shellcheck disable=SC2016
is_launcher() { grep -q '^exec "\$BUN"' "$1"; }
# shellcheck disable=SC2016
launcher_target() { # file → the .ts it runs
    sed -n 's#^exec "\$BUN" --no-install "\$REPO/\([^"]*\.ts\)" "\$@"$#\1#p' "$1" | head -1
}
launcher_problem() { # root file
    local ts
    grep -qxF "$LAUNCHER_SOURCE" "$1/$2" || { echo "no line: $LAUNCHER_SOURCE"; return; }
    ts="$(launcher_target "$1/$2")"
    # shellcheck disable=SC2016
    [[ -n "$ts" ]] || { echo 'no line: exec "$BUN" --no-install "$REPO/<dir>/<name>.ts" "$@"'; return; }
    [[ "$(dirname "$ts")" == "$(dirname "$2")" ]] || { echo "$ts is not beside it"; return; }
    [[ -f "$1/$ts" ]] || { echo "$ts does not exist"; return; }
}
# The file that holds a script's logic: the .ts behind a launcher, else itself.
impl_of() { if is_launcher "$1"; then launcher_target "$1"; else echo "$1"; fi; }
# Its test: <impl>.test.sh or <impl>.test.ts.
has_test() { [[ -f "${1%.*}.test.sh" || -f "${1%.*}.test.ts" ]]; }
takes_check() { # impl
    case "$1" in
        *.ts) grep -qF -- "'--check'" "$1" ;;
        *)    grep -q -- '--check)' "$1" ;;
    esac
}

APP_SECTIONS=("## Role" "## Access" "## Secrets" "## Settings" "## Tasks")
JOB_SECTIONS=("## Role" "## Schedule" "## Tasks")

mapfile -t APPS < <(find apps -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)
mapfile -t JOBS < <(find jobs -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)

# ─── the app list, three ways ─────────────────────────────────────────────────
echo "every app is wired in"
ok_eq "compose.yaml includes exactly apps/*" "${APPS[*]}" \
    "$(sed -n 's|^  - apps/\([^/]*\)/compose.yaml$|\1|p' compose.yaml | sort | paste -sd' ')"
ok_eq "Taskfile.yml includes exactly apps/* and jobs/*" "$(printf '%s\n' "${APPS[@]}" "${JOBS[@]}" | sort | paste -sd' ')" \
    "$(sed -nE 's#^  ([a-z-]+): +\{ taskfile: (apps|jobs)/\1, +dir: \2/\1[ ,].*#\1#p' Taskfile.yml | sort | paste -sd' ')"
ok "Taskfile.yml includes site/ (the website, served by apps/docs; an install has none)" \
    grep -qE '^  site: +\{ taskfile: site, +dir: site, optional: true \}' Taskfile.yml
CONFIGURED="$(sed -n 's/^  CONFIGURED: //p' Taskfile.yml)"
ok_eq "CONFIGURED is every app with a configure.sh" \
    "$(for a in "${APPS[@]}"; do [[ -f "apps/$a/configure.sh" ]] && echo "$a"; done | sort | paste -sd' ')" \
    "$(tr ' ' '\n' <<<"$CONFIGURED" | sort | paste -sd' ')"
ok "no .env inside apps/ (it would feed that app's compose file)" \
    test -z "$(find apps -name .env -print -quit)"

# ─── each app ─────────────────────────────────────────────────────────────────
for app in "${APPS[@]}"; do
    d="apps/$app"
    echo
    echo "$d"
    for f in compose.yaml Taskfile.yml README.md; do ok "has $f" test -f "$d/$f"; done
    ok_eq "compose.yaml defines only the service $app" "$app" \
        "$(awk '/^services:/ {on=1; next} on && /^[^ #]/ {on=0} on && /^  [a-z][a-z0-9_-]*:/ {sub(":", "", $1); print $1}' "$d/compose.yaml" | paste -sd' ')"
    ok_eq "container_name is $app" "1" "$(grep -cxE "    container_name: $app" "$d/compose.yaml")"
    ok_eq "no project name (the root sets pms)" "0" "$(grep -cE '^name:' "$d/compose.yaml")"
    if grep -q 'image: lscr.io/linuxserver/' "$d/compose.yaml"; then
        ok_eq "linuxserver image: PUID PGID TZ UMASK set" "4" \
            "$(grep -cE '^      (PUID|PGID|TZ|UMASK): ' "$d/compose.yaml")"
    fi
    for s in "${APP_SECTIONS[@]}"; do ok "README has '$s'" grep -qxF "$s" "$d/README.md"; done
    if [[ -f "$d/configure.sh" ]]; then
        ok "configure.sh is executable" test -x "$d/configure.sh"
        # radarr/sonarr delegate to stack/lib/arr-configure.sh, which owns the
        # flag and the tests.
        impl="$d/configure.sh"
        if lib="$(grep -oE 'stack/lib/[a-z-]+\.sh' "$d/configure.sh" | grep -vxE 'stack/lib/bun\.sh' | head -1)" \
           && [[ -n "$lib" ]]; then
            impl="$lib"
        fi
        impl="$(impl_of "$impl")"
        ok "configure takes --check ($impl)" takes_check "$impl"
        ok "configure has a test (${impl%.*}.test.sh or .test.ts)" has_test "$impl"
    fi
done

# ─── each job ─────────────────────────────────────────────────────────────────
MANIFEST_SRCS="$(sed -n 's/^    "\(jobs\/[^:]*\):.*/\1/p' stack/deploy.sh | sort)"
for job in "${JOBS[@]}"; do
    d="jobs/$job"
    echo
    echo "$d"
    for f in Taskfile.yml README.md; do ok "has $f" test -f "$d/$f"; done
    ok "has a script"  compgen -G "$d/*[!t].sh"
    ok "has a test"    compgen -G "$d/*.test.[st][hs]"
    ok "has a unit"    compgen -G "$d/*.service"
    for s in "${JOB_SECTIONS[@]}"; do ok "README has '$s'" grep -qxF "$s" "$d/README.md"; done
    for u in "$d"/*.service "$d"/*.timer; do
        [[ -e "$u" ]] || continue
        ok "$(basename "$u") is in deploy.sh's MANIFEST" grep -qxF "$u" <<<"$MANIFEST_SRCS"
    done
    for u in "$d"/*.service; do
        exe="$(sed -n 's/^ExecStart=//p' "$u" | awk '{print $1}')"
        rel="${exe#@PMS_HOME@/}"
        # Templates: stack/install.sh fills in where it is installed and who runs it.
        ok "$(basename "$u") ExecStart starts with @PMS_HOME@/" test "$rel" != "$exe"
        ok "$(basename "$u") runs an executable in this repo ($rel)" test -x "$rel"
        ok "$(basename "$u") runs as @PMS_USER@:@PMS_GROUP@" \
            test "$(sed -n 's/^\(User\|Group\)=//p' "$u" | paste -sd:)" = "@PMS_USER@:@PMS_GROUP@"
    done
done
echo
ok_eq "every unit in MANIFEST exists" "" \
    "$(while read -r f; do [[ -f "$f" ]] || echo "$f"; done <<<"$MANIFEST_SRCS")"

# ─── launchers ────────────────────────────────────────────────────────────────
echo
echo "launchers (a .sh that runs the .ts beside it)"
n=0
while IFS= read -r f; do
    is_launcher "$f" || continue
    n=$((n + 1))
    ok_eq "$f" "" "$(launcher_problem "$ROOT" "$f")"
    ok "$f is executable" test -x "$f"
done < <(printf '%s\n' apps/*/*.sh jobs/*/*.sh stack/*.sh stack/lib/*.sh)
[[ "$n" -gt 0 ]] || echo "  (none yet)"

# The check itself, on a scratch tree: one good launcher and each way to get it wrong.
L="$(mktemp -d)"
trap 'rm -rf "$L"' EXIT
mkdir -p "$L/jobs/x" "$L/jobs/y"
touch "$L/jobs/x/x.ts" "$L/jobs/y/y.ts"
launcher() { # path ts → a launcher at path that runs ts
    # shellcheck disable=SC2016
    printf '#!/usr/bin/env bash\nREPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"\n%s\nexec "$BUN" --no-install "$REPO/%s" "$@"\n' \
        "$LAUNCHER_SOURCE" "$2" >"$L/$1"
}
launcher jobs/x/good.sh jobs/x/x.ts
ok_eq "self-test: a good one passes" "" "$(launcher_problem "$L" jobs/x/good.sh)"
ok_eq "self-test: and its .ts is its logic" "jobs/x/x.ts" "$(impl_of "$L/jobs/x/good.sh")"
launcher jobs/x/missing.sh jobs/x/gone.ts
ok_eq "self-test: a .ts that does not exist" "jobs/x/gone.ts does not exist" "$(launcher_problem "$L" jobs/x/missing.sh)"
launcher jobs/x/elsewhere.sh jobs/y/y.ts
ok_eq "self-test: a .ts in another folder" "jobs/y/y.ts is not beside it" "$(launcher_problem "$L" jobs/x/elsewhere.sh)"
launcher jobs/x/install.sh jobs/x/x.ts; sed -i 's/--no-install //' "$L/jobs/x/install.sh"
ok "self-test: without --no-install" test -n "$(launcher_problem "$L" jobs/x/install.sh)"
launcher jobs/x/noexit.sh jobs/x/x.ts; sed -i 's/ || exit 3$//' "$L/jobs/x/noexit.sh"
ok "self-test: sourcing bun.sh without || exit 3" test -n "$(launcher_problem "$L" jobs/x/noexit.sh)"

# ─── every script finds the repo root ─────────────────────────────────────────
# A wrong depth fails quietly — .env reads come back empty — so evaluate each
# script's REPO= line as if it ran from where it lives.
echo
echo "REPO resolves to the repo root"
while IFS= read -r f; do
    line="$(grep -m1 '^REPO=' "$f")"
    # shellcheck disable=SC2016  # the literal text in the script is what is replaced
    line="${line//'${BASH_SOURCE[0]}'/$ROOT/$f}"
    # shellcheck disable=SC2016
    line="${line//'$0'/$ROOT/$f}"
    got="$(eval "$line"; printf '%s' "$REPO")"
    ok_eq "$f" "$ROOT" "$got"
done < <(grep -l '^REPO=' apps/*/*.sh jobs/*/*.sh stack/*.sh stack/lib/*.sh | sort)

# ─── no old paths ─────────────────────────────────────────────────────────────
echo
echo "no paths from before the monorepo layout"
ok_eq "no tools/, tests/ or systemd/<unit> paths" "" \
    "$(grep -rnE '(^|[^a-z/._-])(tools|tests)/[a-z]|(^|[^a-z/])systemd/[a-z-]+\.(service|timer)' \
        apps jobs stack compose.yaml Taskfile.yml README.md CLAUDE.md .env.example docs \
        --exclude=layout.test.sh | head -5)"
# pms-local's own `npm run deploy-system` is quoted in the runbook, and stays.
ok_eq "no npm commands of this repo" "" \
    "$(grep -rnE 'npm (run|start|test)' apps jobs stack compose.yaml Taskfile.yml README.md CLAUDE.md .env.example docs \
        --exclude=layout.test.sh | grep -vE 'npm run deploy-(system|all)' | head -5)"

# ─── what task sees ───────────────────────────────────────────────────────────
echo
TASK="${TASK:-$(command -v task)}"
if [[ -z "$TASK" ]]; then
    echo "  skip  task not installed: per-app task lists not checked"
else
    echo "per-app tasks (task --list-all)"
    TASKS="$("$TASK" --list-all --json 2>/dev/null | jq -r '.tasks[].name')"
    ok "task parses the Taskfiles" test -n "$TASKS"
    for app in "${APPS[@]}"; do
        ok_eq "$app" "$(expect_tasks "$app")" \
            "$(sed -n "s/^$app://p" <<<"$TASKS" | sort | paste -sd' ')"
    done
fi

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
