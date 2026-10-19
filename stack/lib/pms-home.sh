#!/usr/bin/env bash
# stack/lib/pms-home.sh — where the stack is installed. Sourced, never run.
#
# The stack runs from an install directory that stack/install.sh fills from a
# source tree (a clone, a worktree, an unpacked download). An install is marked
# by PMS_MARKER at its root; a source tree never has one.
#
# The chosen directory is not stored anywhere of its own: the installed
# arr-reclaim.service runs from it, so that unit is the record. A unit that
# runs from a directory without the marker is a deploy from before installs
# (it ran straight from the clone), and does not count.

PMS_DEFAULT_HOME=/opt/arr-setup
PMS_MARKER=.pms-install

# The install the units run from, or nothing. SYS_PREFIX relocates /etc, as in
# stack/deploy.sh.
pms_installed_home() {
    local unit="${SYS_PREFIX:-}/etc/systemd/system/arr-reclaim.service" exe home
    [[ -f "$unit" ]] || return 0
    exe="$(sed -n 's/^ExecStart=//p' "$unit" | head -1 | awk '{print $1}')"
    home="${exe%/jobs/arr-reclaim/arr-reclaim.sh}"
    [[ "$home" != "$exe" && -e "$home/$PMS_MARKER" ]] && echo "$home"
    return 0
}

# What a `cd <here>` hint should name: the current install, else the default.
pms_home_hint() {
    local home
    home="$(pms_installed_home)"
    echo "${home:-$PMS_DEFAULT_HOME}"
}
