#!/usr/bin/env bash
# stack/install.sh — install the stack from this source tree into its install
# directory, then hand over to the install's own stack/deploy.sh.
#
#   stack/install.sh [--move] [DIR]     copy, fill in the units, deploy (asks for sudo)
#   stack/install.sh --files [DIR]      copy and fill in the units only; no deploy
#   stack/install.sh --check [DIR]      report what an install would change; changes nothing
#
# Normally run as `task deploy` / `task deploy:check`, from any checkout or an
# unpacked download: nothing here needs git.
#
# The live stack — compose, the systemd units, the docs site, .env — runs from
# the install, never from a source tree, so a clone can move, switch branches or
# be deleted without the services noticing. The install is a copy of this tree
# without what only development needs (tests, docs/, the site's source, git).
#
# Where it goes, first match wins:
#   1. DIR, or PMS_HOME in the environment
#   2. the install the units already run from (stack/lib/pms-home.sh)
#   3. /opt/arr-setup
# Moving an existing install somewhere else takes --move: two installs would
# fight over the same containers.
#
# In the install it:
#   - mirrors this tree, deleting what the source no longer has; .env, the
#     marker, site/ and .task/ are left alone
#   - fills @PMS_HOME@, @PMS_USER@ and @PMS_GROUP@ into jobs/*/*.service; the
#     source keeps the templates
#   - swaps in site/dist (apps/docs binds site/, so the swap is atomic for it)
#   - seeds .env once: the source's own .env if it has one, else .env.example,
#     and then stops so you can fill it in. It is never overwritten.
#   - writes .pms-install, the marker that makes it an install
#   - restarts the containers whose single-file binds changed
#
# **Run it as yourself, not as root.** It asks for sudo once, to create the
# directory when its parent is not yours, and deploy.sh asks for the units.
#
# Rehearse anywhere harmless — SYS_PREFIX relocates /etc, as in deploy.sh:
#   SYS_PREFIX=/tmp/rehearsal stack/install.sh --files /tmp/rehearsal/arr-setup

set -euo pipefail

SRC="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
SYS_PREFIX="${SYS_PREFIX:-}"
# shellcheck source=SCRIPTDIR/lib/pms-home.sh
. "$SRC/stack/lib/pms-home.sh"

# What an install leaves out: git, development, and what the install keeps of
# its own (.env, the marker, Task's cache, site/). A leading / anchors at the
# root. Unit files are rendered, not copied.
EXCLUDES=(
    /.git /.gitignore /.github/ /.claude/ /.agents/ /skills-lock.json /.task/
    /CLAUDE.md /DESIGN.md /docs/ /site/
    /.env /"$PMS_MARKER"
    '*.test.sh' testdata/ node_modules/
    .idea/ .vscode/ .DS_Store '*.swp'
    '/jobs/*/*.service'
)

# Containers that bind files from the tree, as container|file. A file bind
# holds the inode it was created with; the copy replaces files by rename, so
# only a restart shows the container the new one. (docs also binds site/, whose
# dist swap it sees live. recyclarr is one-shot: every run is a new container.)
BIND_FILES=(
    "decluttarr|apps/decluttarr/config.yaml"
    "docs|apps/docs/nginx.conf"
)

die() { echo "$*" >&2; exit 1; }

rsync_tree() { # extra rsync flags...
    local args=(-rlpt --delete) e
    for e in "${EXCLUDES[@]}"; do args+=("--exclude=$e"); done
    rsync "${args[@]}" "$@" "$SRC/" "$DEST/"
}

render() { # template → stdout
    # Comments keep the placeholders: they say where the values come from.
    sed -e "/^#/!s#@PMS_HOME@#$DEST#g" -e "/^#/!s#@PMS_USER@#$PMS_USER#g" -e "/^#/!s#@PMS_GROUP@#$PMS_GROUP#g" "$1"
}

units() { (cd "$SRC" && printf '%s\n' jobs/*/*.service); }

# ─── where ────────────────────────────────────────────────────────────────────
resolve_dest() {
    local asked="$1" current
    current="$(pms_installed_home)"
    if [[ -z "$asked" ]]; then
        DEST="${current:-$PMS_DEFAULT_HOME}"
    else
        DEST="$(realpath -m "$asked")"
        if [[ -n "$current" && "$current" != "$DEST" && "$MOVE" != 1 ]]; then
            echo "The stack is installed in $current, not $DEST." >&2
            echo "To move it there: stack/install.sh --move $DEST (task deploy -- --move $DEST)" >&2
            exit 1
        fi
    fi
    # ExecStart takes it verbatim, and sed above uses # as its delimiter.
    [[ "$DEST" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "Install directory '$DEST': use an absolute path of letters, digits, . _ - and /."
    [[ "$DEST/" != "$SRC/"* && "$SRC/" != "$DEST/"* ]] \
        || die "Install directory $DEST overlaps the source $SRC; pick a directory outside it."
}

# ─── check ────────────────────────────────────────────────────────────────────
check() {
    local rc=0 line u
    if [[ ! -e "$DEST/$PMS_MARKER" ]]; then
        echo "NOT INSTALLED: $DEST (task deploy installs it)"
        return 1
    fi
    while IFS= read -r line; do
        [[ -n "$line" ]] || continue
        echo "OUT OF DATE: $line"; rc=1
    done < <(rsync_tree --dry-run --itemize-changes | awk '$1 !~ /^[.c]d/ {print $1, $2}')
    while IFS= read -r u; do
        if [[ ! -f "$DEST/$u" ]] || ! diff -q <(render "$SRC/$u") "$DEST/$u" >/dev/null; then
            echo "OUT OF DATE: $u"; rc=1
        fi
    done < <(units)
    if [[ -d "$SRC/site/dist" ]] && [[ -n "$(rsync -rlpt --delete --dry-run --itemize-changes "$SRC/site/dist/" "$DEST/site/dist/" | grep -v '^\.d' || true)" ]]; then
        echo "OUT OF DATE: site/dist"; rc=1
    fi
    [[ -f "$DEST/.env" ]] || { echo "MISSING: $DEST/.env"; rc=1; }
    [[ "$rc" == 0 ]] && echo "ok: $DEST matches $SRC"
    return "$rc"
}

# ─── install ──────────────────────────────────────────────────────────────────
make_dest() {
    [[ -d "$DEST" ]] && return 0
    if [[ -w "$(dirname "$DEST")" ]]; then
        mkdir -p "$DEST"
    elif [[ -n "$SYS_PREFIX" ]]; then
        die "$(dirname "$DEST") is not writable, and SYS_PREFIX rehearsals do not use sudo."
    else
        echo "Creating $DEST (owned by $PMS_USER) — asks for sudo once."
        sudo install -d -o "$PMS_USER" -g "$PMS_GROUP" -m 755 "$DEST"
    fi
}

copy_tree() {
    local u tmp f
    CHANGED_FILES="$(rsync_tree --itemize-changes | awk '$1 !~ /^[.c]d/ {print $2}')"
    if [[ -n "$CHANGED_FILES" ]]; then
        local n; n="$(wc -l <<<"$CHANGED_FILES")"
        if [[ "$n" -le 20 ]]; then
            while IFS= read -r f; do echo "copied $f"; done <<<"$CHANGED_FILES"
        else
            echo "copied $n files"
        fi
    fi

    # Rendered units: rewritten only when the result differs, so deploy.sh sees
    # an unchanged unit as unchanged.
    while IFS= read -r u; do
        mkdir -p "$DEST/$(dirname "$u")"
        tmp="$(mktemp "$DEST/$(dirname "$u")/.render.XXXXXX")"
        render "$SRC/$u" >"$tmp"
        if [[ -f "$DEST/$u" ]] && cmp -s "$tmp" "$DEST/$u"; then
            rm -f "$tmp"
        else
            chmod 644 "$tmp"; mv "$tmp" "$DEST/$u"; echo "rendered $u"
        fi
    done < <(units)
    # A unit the source dropped would otherwise stay behind, excluded from --delete.
    for u in "$DEST"/jobs/*/*.service; do
        [[ -e "$u" && ! -e "$SRC/${u#"$DEST/"}" ]] || continue
        rm -f "$u"; echo "removed ${u#"$DEST/"}"
    done
    return 0
}

publish_site() {
    local site="$DEST/site"
    if [[ ! -d "$SRC/site/dist" ]]; then
        echo "warning: $SRC/site/dist does not exist (task site:build); the docs site keeps what it has." >&2
        return 0
    fi
    if [[ -d "$site/dist" ]] \
       && [[ -z "$(rsync -rlpt --delete --dry-run --itemize-changes "$SRC/site/dist/" "$site/dist/" | grep -v '^\.d' || true)" ]]; then
        return 0
    fi
    mkdir -p "$site"
    rm -rf "$site/.dist-next" "$site/.dist-prev"
    rsync -rlpt "$SRC/site/dist/" "$site/.dist-next/"
    if [[ -d "$site/dist" ]]; then mv "$site/dist" "$site/.dist-prev"; fi
    mv "$site/.dist-next" "$site/dist"
    rm -rf "$site/.dist-prev"
    echo "published site/dist"
}

# 0 = .env is in place; 3 = seeded from .env.example, fill it in first.
seed_env() {
    [[ -e "$DEST/.env" ]] && return 0
    if [[ -f "$SRC/.env" ]]; then
        install -m 600 "$SRC/.env" "$DEST/.env"
        echo "copied $SRC/.env to $DEST/.env (the install's from now on)"
        return 0
    fi
    install -m 600 "$SRC/.env.example" "$DEST/.env"
    echo
    echo "Created $DEST/.env from .env.example. Fill it in, then run this again."
    return 3
}

write_marker() {
    local version
    version="$(git -C "$SRC" describe --always --dirty 2>/dev/null || echo unknown)"
    printf 'source=%s\nversion=%s\ninstalled=%s\n' "$SRC" "$version" "$(date -Is)" >"$DEST/$PMS_MARKER"
}

# A container created from somewhere else still reads that tree's files: say
# so, rather than restarting it onto them. One created here gets restarted when
# a file it binds changed.
refresh_binds() {
    local entry name file wd restarted=" "
    [[ -z "$SYS_PREFIX" ]] || { echo "SYS_PREFIX set — leaving the containers alone."; return 0; }
    command -v docker >/dev/null || return 0
    for entry in "${BIND_FILES[@]}"; do
        name="${entry%%|*}"; file="${entry#*|}"
        wd="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$name" 2>/dev/null)" || continue
        if [[ "$wd" != "$DEST" ]]; then
            [[ "$restarted" == *" $name "* ]] && continue
            echo "$name was created from $wd, not the install: cd $DEST && task $name:up"
            restarted+="$name "
        elif grep -qxF "$file" <<<"$CHANGED_FILES" && [[ "$restarted" != *" $name "* ]]; then
            docker restart "$name" >/dev/null && echo "restarted $name ($file changed)"
            restarted+="$name "
        fi
    done
}

main() {
    local mode=install asked="${PMS_HOME:-}" rc=0
    MOVE=0
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --check) mode=check ;;
            --files) mode=files ;;
            --move)  MOVE=1 ;;
            -*)      echo "usage: ${0##*/} [--check|--files] [--move] [DIR]" >&2; exit 2 ;;
            *)       asked="$1" ;;
        esac
        shift
    done

    [[ "$(id -u)" -ne 0 ]] || die "Run this as yourself, not as root — it asks for sudo where it needs it."
    command -v rsync >/dev/null || die "rsync is not installed (sudo apt install rsync)."
    PMS_USER="$(id -un)"; PMS_GROUP="$(id -gn)"
    resolve_dest "$asked"

    if [[ "$mode" == check ]]; then
        check || rc=1
        if [[ -e "$DEST/$PMS_MARKER" ]]; then
            echo
            "$DEST/stack/deploy.sh" --check || rc=1
        fi
        return "$rc"
    fi

    echo "Installing $SRC → $DEST"
    make_dest
    copy_tree
    publish_site
    seed_env || exit $?
    write_marker
    refresh_binds
    [[ "$mode" == files ]] && { echo "installed files in $DEST (--files: no deploy)"; return 0; }

    echo
    exec "$DEST/stack/deploy.sh"
}

# Sourcing with INSTALL_LIB=1 gets the functions without running anything,
# which is how stack/install.test.sh reaches them.
[[ "${INSTALL_LIB:-0}" == "1" ]] || main "$@"
