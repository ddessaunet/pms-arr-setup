#!/usr/bin/env bash
# preflight.sh — read-only checks before starting the stack or a new phase.
# Changes nothing.
#
#   tools/preflight.sh      (also run by `npm start`)
#
# Exit 0 when every hard check passes, 1 otherwise. Warnings never fail.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_ROOT="${DATA_ROOT:-/mnt/data}"
TORRENTS="$DATA_ROOT/torrents"
STREAMING="$DATA_ROOT/streaming"

fails=0

ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; fails=$((fails + 1)); }

# Reads one KEY from .env without sourcing it.
env_get() {
    [[ -f "$REPO/.env" ]] || return 1
    sed -n "s/^$1=//p" "$REPO/.env" | tail -n1
}

container_running() { docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$1"; }

echo "── environment"

if docker info >/dev/null 2>&1; then
    ok "docker reachable as $(id -un)"
else
    fail "docker not reachable (daemon down, or $(id -un) not in the docker group)"
fi

if docker compose version >/dev/null 2>&1; then
    ok "docker compose plugin present"
else
    fail "docker compose plugin missing"
fi

if [[ -f "$REPO/.env" ]]; then
    ok ".env present"
    for key in PUID PGID TZ APPDATA; do
        [[ -n "$(env_get "$key")" ]] || fail ".env: $key is empty"
    done
else
    fail ".env missing — cp .env.example .env"
fi

if (cd "$REPO" && docker compose config -q 2>/dev/null); then
    ok "compose.yaml renders"
else
    fail "compose.yaml does not render — run: docker compose config"
fi

echo "── filesystem"

# Hardlinks are the point: a download must occupy its size once. They only work
# within one filesystem.
dev_t="$(stat -c %d "$TORRENTS" 2>/dev/null)"
dev_s="$(stat -c %d "$STREAMING" 2>/dev/null)"
if [[ -z "$dev_t" || -z "$dev_s" ]]; then
    fail "$TORRENTS or $STREAMING does not exist"
elif [[ "$dev_t" == "$dev_s" ]]; then
    ok "$TORRENTS and $STREAMING share a filesystem (hardlinks work)"
else
    fail "$TORRENTS and $STREAMING are on different filesystems — imports would copy"
fi

appdata="$(env_get APPDATA)"
puid="$(env_get PUID)"
pgid="$(env_get PGID)"
appdata="${appdata:-/opt/appdata}"
if [[ -d "$appdata" ]]; then
    owner="$(stat -c '%u:%g' "$appdata")"
    want="${puid:-1000}:${pgid:-1001}"
    if [[ "$owner" == "$want" ]]; then
        ok "$appdata exists, owned $owner"
    else
        warn "$appdata owned $owner, expected $want"
    fi
    if [[ "$(stat -c %d "$appdata")" == "$dev_s" ]]; then
        fail "$appdata is on the same filesystem as $DATA_ROOT — keep appdata on /"
    fi
else
    fail "$appdata missing — sudo install -d -o ${puid:-1000} -g ${pgid:-1001} $appdata"
fi

read -r avail pct < <(df --output=avail,pcent -BG "$DATA_ROOT" | tail -n1)
if [[ "${pct%\%}" -ge 97 ]]; then
    warn "$DATA_ROOT at $pct ($avail free) — do not enable upgrades or large grabs"
else
    ok "$DATA_ROOT at $pct ($avail free)"
fi

echo "── native services"

for unit in plexmediaserver qbittorrent-nox plex-watch plex-update.timer; do
    printf '  ....  %-20s %s\n' "$unit" "$(systemctl is-active "$unit" 2>/dev/null)/$(systemctl is-enabled "$unit" 2>/dev/null)"
done

echo "── plex"

# The container owns :32400 on host networking. Native Plex is kept installed
# and masked as the rollback until Phase 7; if it ever runs again the two fight
# for the port, and whichever loses is the one clients cannot reach.
native="$(systemctl is-enabled plexmediaserver 2>/dev/null)"
if [[ "$native" == masked* ]]; then
    ok "native plexmediaserver masked"
elif [[ -z "$native" || "$native" == not-found ]]; then
    ok "native plexmediaserver not installed"
else
    fail "native plexmediaserver is $native, not masked — it would fight the container for :32400 (sudo systemctl mask --now plexmediaserver)"
fi

if container_running plex; then
    ok "plex container running"
else
    warn "plex container not running — npm start brings it up"
fi

echo
if [[ "$fails" -gt 0 ]]; then
    echo "$fails check(s) failed."
    exit 1
fi
echo "All hard checks passed."
