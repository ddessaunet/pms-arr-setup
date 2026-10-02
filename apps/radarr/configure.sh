#!/usr/bin/env bash
# apps/radarr/configure.sh — apply Radarr's settings, then verify them.
#
#   apps/radarr/configure.sh            apply, then verify   (task radarr:configure)
#   apps/radarr/configure.sh --check    verify only          (task radarr:check)
#
# Radarr and Sonarr share one implementation, stack/lib/arr-configure.sh, and
# its tests (stack/lib/arr-configure.test.sh). This only picks the app.

exec "$(dirname "$(readlink -f "$0")")/../../stack/lib/arr-configure.sh" radarr "$@"
