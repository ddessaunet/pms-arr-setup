# CLAUDE.md

## What this repo is

Docker Compose for the media stack on the home server (Ubuntu), replacing the native setup
in `../pms-local` phase by phase. [README.md](README.md) has the layout.
[docs/phases.md](docs/phases.md) is the runbook, and its checkboxes track progress. Tick a
box, and commit the tick, when a phase is done. If the boxes look stale, check the server
rather than trusting them.

Compose runs from this clone. State lives in `/opt/appdata`, not in the repo.

## This is a live system

The `plex` container serves the real library (since Phase 1b). Native qBittorrent seeds real
data, and pms-local's `plex-watch` deletes torrent data when library files disappear. Confirm
before anything destructive:

- `docker compose down -v`, or deleting anything under `/opt/appdata/plex` after Phase 1b
- recursive `rm`, `chown` or `chmod` under `/mnt/data`
- stopping, masking or uninstalling a native service outside the step that says to
- anything under `/var/lib/plexmediaserver`, the native Plex database kept for rollback until
  Phase 7, or unmasking `plexmediaserver` (it would fight the container for `:32400`)

## Traps that span files

1. **Host paths are mounted verbatim** (`/mnt/data` → `/mnt/data`). The Plex database and
   qBittorrent's `.fastresume` files store absolute paths. Don't "tidy" this to `/data`.
2. **Hardlinking containers get `/mnt/data` as ONE bind mount.** Separate mounts for
   `torrents/` and `streaming/` make `link()` fail with `EXDEV`, and imports turn into
   copies on a nearly full volume.
3. **`plex-watch` treats any delete or move in the library as a Plex deletion** and removes
   the native torrent's data. Until Phase 7 the arrs must only add files: no renames, no
   upgrades, no recycle bin.
4. **`/opt/appdata/plex` is the live Plex database**, not a cache. `docker compose down`
   is safe (config is a bind mount), but deleting or re-seeding that directory loses the
   library and watch history. The container must keep identity `f3860770…`; one that
   comes up with another has started on a fresh config.
5. **Two updaters, one Sunday slot.** pms-local's `plex-update.timer` updates native Plex;
   this repo's `pms-update.timer` updates the containers. Both deploys key off the same
   signal, whether `plexmediaserver` is masked, so exactly one is armed: this repo's
   `npm run deploy` arms its timer only while masked, and pms-local's (from pms-local#14)
   only while not. Until #14 is deployed, pms-local's deploy re-arms its timer
   unconditionally.
6. **`systemd/pms-update.service` hardcodes this clone's path** in `ExecStart`, because
   compose needs `compose.yaml` and `.env` beside it. `npm run deploy` refuses to install it
   if the path doesn't match the clone. Moving the clone means editing that line.

## Conventions

- Commit subjects are lowercase and imperative; bodies explain *why*.
- `.env` holds secrets and is gitignored. Only `.env.example` is tracked.
- npm is only a task runner (see README). Run `npm run lint && npm test` before committing,
  and never `sudo npm`. npm lives in nvm, so from a non-login shell load it first:
  `. ~/.nvm/nvm.sh`.
- `npm run check` is the read-only drift report. `npm run deploy` changes init state and
  needs sudo, so it's the user's to run.
