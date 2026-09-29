# CLAUDE.md

## What this repo is

Docker Compose for the media stack on the home server (Ubuntu), replacing the native setup
in `../pms-local` phase by phase. [README.md](README.md) has the layout.
[docs/phases.md](docs/phases.md) is the runbook, and its checkboxes track progress. Tick a
box, and commit the tick, when a phase is done. If the boxes look stale, check the server
rather than trusting them.

Compose runs from this clone. State lives in `/opt/appdata`, not in the repo.

## This is a live system

The `plex` container serves the real library (since Phase 1b). The `:8081` qBittorrent seeds
real data, and `arr-reclaim` deletes torrent data when library files Radarr/Sonarr imported
disappear. Confirm before anything destructive:

- `docker compose down -v`, or deleting anything under `/opt/appdata/plex` after Phase 1b
- recursive `rm`, `chown` or `chmod` under `/mnt/data`
- stopping, masking or uninstalling a native service outside the step that says to
- `/root/plexmediaserver-native.tgz` or `/var/lib/plexmediaserver`, the native Plex database
  (Phase 7b removed the package and kept both), or unmasking `plexmediaserver` (a reinstall
  would fight the container for `:32400`)

## Traps that span files

1. **Host paths are mounted verbatim** (`/mnt/data` → `/mnt/data`). The Plex database and
   qBittorrent's `.fastresume` files store absolute paths. Don't "tidy" this to `/data`.
2. **Hardlinking containers get `/mnt/data` as ONE bind mount.** Separate mounts for
   `torrents/` and `streaming/` make `link()` fail with `EXDEV`, and imports turn into
   copies on a nearly full volume.
3. **`plex-watch` is retired (Phase 7a).** It treated any delete or move in the library as
   a Plex deletion; now only `arr-reclaim` watches, and a move or rename leaves its data
   linked, so it keeps the torrent. Moves are safe, but the existing library is still
   imported and renamed only as Phase 8 plans it, not ad hoc.
   **pms-local is not modified by this migration,** and its `deploy`/`deploy-system` must
   not be run again: `deploy-system` re-enables `plex-watch` on every run. `plex-watch` and
   `qbittorrent-nox` are disabled, not masked: their unit files are in
   `/etc/systemd/system`, where `systemctl mask` refuses. Anything needed from pms-local is
   ported here and adapted, as `tools/arr-reclaim.sh` ports `plex-watch`.
4. **`/opt/appdata/plex` is the live Plex database**, not a cache. `docker compose down`
   is safe (config is a bind mount), but deleting or re-seeding that directory loses the
   library and watch history. The container must keep identity `f3860770…`; one that
   comes up with another has started on a fresh config.
5. **One updater.** This repo's `pms-update.timer` (Sunday 05:00) updates the containers.
   `npm run deploy` arms it while `plexmediaserver` is masked or not installed (Phase 7b),
   and disarms it otherwise: unmasking native Plex is the Phase 1b rollback, and then
   pms-local's `plex-update.timer` owns updates again. That one is disabled while masked.
6. **One qBittorrent: the container on `:8081`, peer 13762** (kept there on purpose; native
   `qbittorrent-nox` on `:8080`/13761 is disabled since Phase 7a, and its 9 torrents were
   dropped, their files kept by the library's own hardlinks). It has no import hook:
   Radarr/Sonarr import over its API. Its settings come from `tools/qbt-configure.sh`;
   change them there, not in the WebUI, or `qbt:check` reports drift.
7. **Prowlarr's settings come from `tools/prowlarr-configure.sh`**, and its API key from
   `.env` (`PROWLARR__AUTH__APIKEY`), which Phase 4 wires into Radarr and Sonarr. Changing
   the key means changing it everywhere. Indexers that go through FlareSolverr are listed
   there; add `flare` only for ones Cloudflare actually blocks, since each such search runs
   a headless Chromium.
8. **The library is not tidy.** 107 of 134 movies are loose files at the `movies/` root, and
   several series folders are misfiled. Radarr/Sonarr manage new content only; the rest
   waits for Phase 8.
9. **`arr-reclaim` removes a torrent only when all three hold:** Radarr/Sonarr imported it
   (its hash is in their import history, `eventType=3`, since the name is refused), every
   imported file is gone, and no other link remains. Don't loosen this to category
   ownership: a finished-but-not-yet-imported download has no library link either.
10. **Servarr reads `allowedHosts` at startup only.** `apply_host` restarts the app after
    changing it; without that, Prowlarr ↔ Radarr/Sonarr calls fail with "Invalid Hostname"
    after the next unrelated restart.
11. **Quality has three owners, in this order:**
    - **Recyclarr** (`recyclarr/recyclarr.yml`, run on demand): the default profiles, 4K HDR
      `UHD Bluray + WEB` for movies and `WEB-1080p` for series, and their custom formats.
    - **`arr-configure.sh`:** sizes (1080p 40, 2160p 150 MB/min; Recyclarr's
      `quality_definition` must stay out), and upgrades **only** on `UHD Bluray + WEB`.
    - **`seerr-configure.sh`:** requests default to those profiles.

    Run `recyclarr:sync` → `arr:configure` → `seerr:configure`. Radarr reports quality sizes
    a few seconds late after a write, so the read-back re-reads for up to about 10 s before
    calling it drift.
12. **Seerr is configured by `tools/seerr-configure.sh`, after one browser sign-in with
    Plex.** Its API key is refused (403) until that admin exists, and it lives in
    `/opt/appdata/seerr/settings.json`, not `.env`. Seerr rejects read-only fields in writes,
    so the script only ever sends the fields it owns. Its requests are ordinary Radarr/Sonarr
    adds; nothing in Seerr touches files.
13. **`systemd/pms-update.service` and `systemd/arr-reclaim.service` hardcode this clone's
    path** in `ExecStart`, because the scripts need `compose.yaml` and `.env` beside them.
    `npm run deploy` refuses to install a unit whose path doesn't match the clone. Moving
    the clone means editing those lines.

## Conventions

- Commit subjects are lowercase and imperative; bodies explain *why*.
- `.env` holds secrets and is gitignored. Only `.env.example` is tracked.
- npm is only a task runner (see README). Run `npm run lint && npm test` before committing,
  and never `sudo npm`. npm lives in nvm, so from a non-login shell load it first:
  `. ~/.nvm/nvm.sh`.
- `npm run check` is the read-only drift report. `npm run deploy` changes init state and
  needs sudo, so it's the user's to run.
