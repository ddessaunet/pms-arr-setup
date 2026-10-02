#!/usr/bin/env bash
# apps/sonarr/configure.sh — apply Sonarr's settings, then verify them.
#
#   apps/sonarr/configure.sh            apply, then verify   (task sonarr:configure)
#   apps/sonarr/configure.sh --check    verify only          (task sonarr:check)
#
# Radarr and Sonarr share one implementation, stack/lib/arr-configure.sh, and
# its tests (stack/lib/arr-configure.test.sh). This only picks the app.

exec "$(dirname "$(readlink -f "$0")")/../../stack/lib/arr-configure.sh" sonarr "$@"
