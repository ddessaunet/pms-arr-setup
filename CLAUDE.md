# CLAUDE.md

## What this repo is

Docker Compose for the media stack on the home server (Ubuntu), replacing the native setup
in `../pms-local` phase by phase. [README.md](README.md) has the layout.
[docs/phases.md](docs/phases.md) is the runbook, and its checkboxes track progress. Tick a
box, and commit the tick, when a phase is done. If the boxes look stale, check the server
rather than trusting them.

Compose runs from this clone. State lives in `/opt/appdata`, not in the repo.

## This is a live system

Native Plex and native qBittorrent serve and seed real data, and pms-local's `plex-watch`
deletes torrent data when library files disappear. Confirm before anything destructive:

- `docker compose down -v`, or deleting anything under `/opt/appdata/plex` after Phase 1b
- recursive `rm`, `chown` or `chmod` under `/mnt/data`
- stopping, masking or uninstalling a native service outside the step that says to
- anything under `/var/lib/plexmediaserver`, the rollback copy of the Plex database

## Traps that span files

1. **Host paths are mounted verbatim** (`/mnt/data` → `/mnt/data`). The Plex database and
   qBittorrent's `.fastresume` files store absolute paths. Don't "tidy" this to `/data`.
2. **Hardlinking containers get `/mnt/data` as ONE bind mount.** Separate mounts for
   `torrents/` and `streaming/` make `link()` fail with `EXDEV`, and imports turn into
   copies on a nearly full volume.
3. **`plex-watch` treats any delete or move in the library as a Plex deletion** and removes
   the native torrent's data. Until Phase 7 the arrs must only add files: no renames, no
   upgrades, no recycle bin.
4. **The `plex` service carries `profiles: [cutover]` until Phase 1b is done.** A bare
   `up -d` would otherwise bind `:32400` against native Plex and seed a fresh config.
5. **pms-local's `npm run deploy-system` re-enables `plex-update.timer`**, which reinstalls
   and starts native Plex. Don't run it after Phase 1b.

## Conventions

- Commit subjects are lowercase and imperative; bodies explain *why*.
- `.env` holds secrets and is gitignored. Only `.env.example` is tracked.
- `tools/*.sh` must pass `shellcheck`.
