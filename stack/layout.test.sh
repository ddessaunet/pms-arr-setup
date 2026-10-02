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
SERVICE_TASKS="logs ps up"
UPDATE_TASKS="update update:dry"
CONFIGURE_TASKS="check configure"
expect_tasks() { # app → sorted task names
    local t
    case "$1" in
        recyclarr)  t="preview sync" ;;
        decluttarr) t="$SERVICE_TASKS" ;;
        *)          t="$SERVICE_TASKS $UPDATE_TASKS"
                    [[ -f "apps/$1/configure.sh" ]] && t+=" $CONFIGURE_TASKS" ;;
    esac
    tr ' ' '\n' <<<"$t" | sort | paste -sd' '
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
ok "Taskfile.yml includes site/ (the website, served by apps/docs)" \
    grep -qE '^  site: +\{ taskfile: site, +dir: site \}' Taskfile.yml
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
        impl="$d/configure.sh"; t="$d/configure.test.sh"
        if lib="$(grep -oE 'stack/lib/[a-z-]+\.sh' "$d/configure.sh" | grep -v servarr | head -1)" && [[ -n "$lib" ]]; then
            impl="$lib"; t="${lib%.sh}.test.sh"
        fi
        ok "configure takes --check ($impl)" grep -q -- '--check)' "$impl"
        ok "configure has a test ($t)" test -f "$t"
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
    ok "has a test"    compgen -G "$d/*.test.sh"
    ok "has a unit"    compgen -G "$d/*.service"
    for s in "${JOB_SECTIONS[@]}"; do ok "README has '$s'" grep -qxF "$s" "$d/README.md"; done
    for u in "$d"/*.service "$d"/*.timer; do
        [[ -e "$u" ]] || continue
        ok "$(basename "$u") is in deploy.sh's MANIFEST" grep -qxF "$u" <<<"$MANIFEST_SRCS"
    done
    for u in "$d"/*.service; do
        exe="$(sed -n 's/^ExecStart=//p' "$u" | awk '{print $1}')"
        rel="${exe#/home/dario/repositories/pms-arr-setup/}"
        ok "$(basename "$u") runs an executable in this repo ($rel)" test -x "$rel"
    done
done
echo
ok_eq "every unit in MANIFEST exists" "" \
    "$(while read -r f; do [[ -f "$f" ]] || echo "$f"; done <<<"$MANIFEST_SRCS")"

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
