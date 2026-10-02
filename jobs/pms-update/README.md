# pms-update

The weekly container updater. [`docs/updating.md`](../../docs/updating.md) covers it in
full: the streaming check, the health wait, the rollback, the exit codes, and adding a
service.

## Role

For each service in `UPDATE_SERVICES` (`.env`), [`update-stack.sh`](update-stack.sh):

1. pulls the new image;
2. skips the run if anyone is streaming on Plex;
3. recreates the container;
4. waits for it to be healthy;
5. rolls back to the previous image if it isn't.

[Decluttarr](../../apps/decluttarr/README.md) is pinned and not on the list, and
[Recyclarr](../../apps/recyclarr/README.md)'s image tag is its own update policy.

## Schedule

Sundays at 05:00 (up to 45 minutes of jitter): [`pms-update.timer`](pms-update.timer) runs
[`pms-update.service`](pms-update.service) from the main clone. `task deploy` installs both,
and arms the timer only while native `plexmediaserver` is masked or not installed. Unmasking
native Plex is the Phase 1b rollback, and then pms-local's own updater takes over again.

## Tasks

| task | does |
|---|---|
| `task update` (`pms-update:run`) | Update every service in `UPDATE_SERVICES` now; `task update -- plex` updates only Plex. |
| `task update:dry` (`pms-update:dry`) | Pull and report. Recreates nothing. |
| `task <app>:update` | Update one app through the same script. |
| `task pms-update:logs` | The last runs' journal. |
