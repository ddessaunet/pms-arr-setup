[← Index](../README.md)

# Updating

`pms-update.timer` updates the containers every Sunday at 05:00 (up to 45 minutes of
jitter). That's the same slot and the same rules as pms-local's native `plex-update.timer`,
which it replaces once Plex runs here:

- **It never interrupts a stream.** If anyone is watching Plex, the run is deferred to next
  week.
- **It never guesses.** If Plex's token is missing or rejected, or Plex won't answer, the run
  fails loudly instead of updating blind.
- **An update only counts once the service is back.** For Plex, that means `/identity`
  reporting the same server identity as before.

It adds one thing native could not do: if the new image doesn't come up healthy, it
**rolls back to the previous image** on its own.

## What a run does

For each service in `UPDATE_SERVICES` (`.env`, default `plex`):

1. **Skip it if its container isn't running.** Before Phase 1b, `plex` isn't running, so an
   armed timer is harmless.
2. **Pull the image.** If the image ID is unchanged, it's already current and nothing else
   happens.
3. **Gate.** Plex checks `/status/sessions` using the token from its own `Preferences.xml`,
   sent as a header so it never lands in a URL or a log. Other services have no gate.
4. **Recreate** the container on the new image (`docker compose up -d --no-deps`).
5. **Wait up to `UPDATE_HEALTH_WAIT` seconds (default 180)** for it to be healthy. For Plex
   that means the same `machineIdentifier` as before. For a service without an identity
   check, it means staying up for 20 seconds without restarting.
6. **If it's healthy**, log the Plex version before and after, and remove the old image
   (only that image, and only if nothing else uses it).
7. **If it's not healthy**, re-tag the old image, recreate the container on it, and wait
   again. Next week's run will try the new image again.

A deferred run keeps the pulled image. The next run sees the running container is behind
and goes straight to the gate.

## Installing

```bash
task deploy
```

This installs `jobs/pms-update/pms-update.{service,timer}` and arms the timer **only while
`plexmediaserver` is masked**, which is to say only after the Phase 1b cutover. Once Phase 7b
has removed the package, a missing unit counts as masked too. Otherwise it disarms the
timer. That's the same signal pms-local's deploy uses to disarm its own
`plex-update.timer`, so exactly one of the two updaters is armed at any time. The deploy
refuses to run if the unit's `ExecStart` doesn't point at this clone.

```bash
task deploy:check
```

This reports drift (a missing, changed or wrong-mode unit, or a timer armed when it
shouldn't be, or the reverse) and changes nothing.

## Reading runs

```bash
journalctl -u pms-update
```

```bash
systemctl list-timers pms-update.timer
```

| exit | meaning |
|---|---|
| `0` | updated, already current, deferred for a stream, not running, or another run held the lock |
| `3` | preflight: docker unreachable, `.env` missing, `compose.yaml` does not render, no appdata |
| `4` | Plex token unreadable or rejected — cannot tell whether anyone is streaming |
| `5` | Plex is running but will not answer — session state unknown |
| `6` | pull failed |
| `9` | the new image was unhealthy; **rolled back**, and the old image is serving |
| `10` | **the rollback failed too — the service is down** |

Anything non-zero leaves the unit `failed` in `systemctl --failed`. That's the alerting, as
with native.

With several services, each one is tried and the worst exit code wins.

## Running it by hand

```bash
task update:dry
```

`--dry-run` still **pulls**, because that's how it finds out whether there's anything new.
Pulling only downloads, and the running container is untouched until something recreates it.
Everything after the gate is skipped.

To update one service now, outside the schedule:

```bash
jobs/pms-update/update-stack.sh plex
```

## Adding a service

When a later phase brings a service up, add its compose name to `UPDATE_SERVICES` in `.env`
(space-separated, e.g. `UPDATE_SERVICES=plex qbittorrent prowlarr`). With no hooks it gets
the default health check: stays up for 20 seconds without restarting, and no gate.

Only add hooks if the service needs them. They are functions in `jobs/pms-update/update-stack.sh` named
after the compose service, with dashes as underscores:

| hook | purpose |
|---|---|
| `gate_<svc>` | return `0` to go ahead, `1` to defer to next week, anything else to fail with that code |
| `identity_<svc>` | print something that must be unchanged after the update; health waits for it |
| `version_<svc>` | print a version to log before and after |

For example, qBittorrent could get a gate that defers while anything is downloading.

## If a run exits 10

The service is down: both the new image and the rollback failed.

```bash
docker compose ps
```

```bash
docker compose logs --tail 100 <service>
```

Two things to check first:

- **Was the old image removed?** It shouldn't be; a failed update never removes it.
  `docker images lscr.io/linuxserver/plex` lists what's still there.
- **Did the config volume change underneath it?** A new Plex build can migrate its database
  on first start, and an older build may then refuse it. If so, stop the container and
  restore `/opt/appdata/plex` from a backup.

For Plex, the Phase 1b rollback (native `plexmediaserver`, with the database left in
`/var/lib/plexmediaserver`) still works as a last resort. It's the state from before the
cutover, though, so anything watched since then is missing.

## Tests

```bash
jobs/pms-update/update-stack.test.sh
```

The tests run offline: `curl` is stubbed, and nothing outside a temp directory is written.
Pulling, recreating, the health wait and the rollback need a live box. `--dry-run` rehearses
the first half.
