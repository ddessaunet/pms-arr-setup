# CLAUDE.md

## What this repo is

Docker Compose for the media stack on the home server (Ubuntu), replacing the native setup
in `../pms-local` phase by phase. [README.md](README.md) has the layout: one folder per app
(`apps/<app>/`) and per host job (`jobs/<job>/`), every one the same shape, checked by
`stack/layout.test.sh`. Each app's `README.md` holds its own traps; the ones below span apps.
[docs/phases.md](docs/phases.md) is the runbook, and its checkboxes track progress. Tick a
box, and commit the tick, when a phase is done. If the boxes look stale, check the server
rather than trusting them.

Compose runs from the main clone. State lives in `/opt/appdata`, not in the repo.

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
   linked, so it keeps the torrent. Moves and renames are safe.
   **pms-local is not modified by this migration,** and its `deploy`/`deploy-system` must
   not be run again: `deploy-system` re-enables `plex-watch` on every run. `plex-watch` and
   `qbittorrent-nox` are disabled, not masked: their unit files are in
   `/etc/systemd/system`, where `systemctl mask` refuses. Anything needed from pms-local is
   ported here and adapted, as `jobs/arr-reclaim/arr-reclaim.sh` ports `plex-watch`.
4. **`/opt/appdata/plex` is the live Plex database**, not a cache. `docker compose down`
   is safe (config is a bind mount), but deleting or re-seeding that directory loses the
   library and watch history. The container must keep identity `f3860770…`; one that
   comes up with another has started on a fresh config.
5. **One updater.** This repo's `pms-update.timer` (Sunday 05:00) updates the containers.
   `task deploy` arms it while `plexmediaserver` is masked or not installed (Phase 7b),
   and disarms it otherwise: unmasking native Plex is the Phase 1b rollback, and then
   pms-local's `plex-update.timer` owns updates again. That one is disabled while masked.
6. **One qBittorrent: the container on `:8081`, peer 13762** (kept there on purpose; native
   `qbittorrent-nox` on `:8080`/13761 is disabled since Phase 7a, and its 9 torrents were
   dropped, their files kept by the library's own hardlinks). It has no import hook:
   Radarr/Sonarr import over its API. Its settings come from `apps/qbittorrent/configure.sh`;
   change them there, not in the WebUI, or `task qbittorrent:check` reports drift. Torrents added by
   hand go in its `manual` category: no app looks there, so they are never imported,
   replaced or removed, only stopped at the share limits.
7. **Prowlarr's settings come from `apps/prowlarr/configure.sh`**, and its API key from
   `.env` (`PROWLARR__AUTH__APIKEY`), which Phase 4 wires into Radarr and Sonarr. Changing
   the key means changing it everywhere. Indexers that go through FlareSolverr are listed
   there; add `flare` only for ones Cloudflare actually blocks, since each such search runs
   a headless Chromium. It also owns **Minimum Seeders** (`MIN_SEEDERS`, on the sync
   profile): Prowlarr's full sync overwrites it on the Radarr/Sonarr indexers, so never set
   it there. A sync-profile edit does not push by itself; the script runs
   `ApplicationIndexerSync` after applying.
8. **Radarr and Sonarr manage the whole library; most of it is unmonitored.** Unmonitored
   titles are never searched or upgraded; monitor one by hand to get it improved. Media is
   `Title (Year)/Title (Year).ext` and `Show/Season NN/Show - SNNEMM.ext`. `photos/`,
   `videos/` and `music/` are Plex-only and not theirs.
9. **`arr-reclaim` removes a torrent only when all three hold:** Radarr/Sonarr imported it
   (its hash is in their import history, `eventType=3`, since the name is refused), every
   imported file is gone, and no other link remains. Don't loosen this to category
   ownership: a finished-but-not-yet-imported download has no library link either.
   Deleting a movie/series **in Radarr/Sonarr wipes its history**, so `arr-reclaim` keeps
   what it has seen in `/opt/appdata/.arr-reclaim.imports` (recorded every minute) and
   decides from both. Don't replace that with a post-import category: Radarr/Sonarr list
   only their own category, so *Remove Completed* would stop seeing imported torrents.
10. **Servarr reads `allowedHosts` at startup only.** `apply_host` restarts the app after
    changing it; without that, Prowlarr ↔ Radarr/Sonarr calls fail with "Invalid Hostname"
    after the next unrelated restart.
11. **Quality has three owners, in this order:**
    - **Recyclarr** (`apps/recyclarr/recyclarr.yml`, run on demand): the default profiles, 4K HDR
      `UHD Bluray + WEB` for movies and `WEB-1080p` for series, and their custom formats.
      Its 4K qualities are **one group** on purpose: Radarr ranks quality before score, so
      split, any Bluray encode beat a well-seeded tiered WEB release. It also makes the
      opt-in **`4K HDR or 1080p`** (Phase 6b): a variant of the same TRaSH profile (same
      `trash_id`, so the same scores) with a 1080p group under the 4K one, for films with no
      4K HDR release. Its name is matched exactly by `stack/lib/arr-configure.sh` and
      `jobs/arr-fallback-search/arr-fallback-search.sh`, and that job's test pins it.
      And the hand-picked **`UHD Fallback`**, for films with 4K releases the strict profile
      rejects: not guide-backed, so it gets only the formats listed for it. HDR preferred
      but not required, audio scored as in the default, no tiers, no LQ penalty (YTS
      passes), no Remux, no upgrades.
    - **`stack/lib/arr-configure.sh`** (behind `apps/radarr|sonarr/configure.sh`): sizes
      (Radarr 1080p 40, 2160p 150 MB/min; Sonarr 1080p no max; Recyclarr's
      `quality_definition` must stay out), and upgrades and no Remux **only** on the two
      4K movie profiles.
    - **`apps/seerr/configure.sh`:** requests default to those profiles; the variant is
      picked per request, never the default.

    Radarr searches a movie in full only when it is added, and after that only through
    RSS. So `arr-fallback-search.timer` (daily, 04:00) searches the variant's movies without a
    4K file again.

    Run `task recyclarr:sync` → `task arr:configure` → `task seerr:configure`. Radarr reports quality sizes
    a few seconds late after a write, so the read-back re-reads for up to about 10 s before
    calling it drift.
12. **Seerr is configured by `apps/seerr/configure.sh`, after one browser sign-in with
    Plex.** Its API key is refused (403) until that admin exists, and it lives in
    `/opt/appdata/seerr/settings.json`, not `.env`. Seerr rejects read-only fields in writes,
    so the script only ever sends the fields it owns. Its requests are ordinary Radarr/Sonarr
    adds; nothing in Seerr touches files.
13. **The units in `jobs/` (`pms-update.service`, `arr-reclaim.service`,
    `arr-fallback-search.service`) hardcode this clone's path** in `ExecStart`, because the
    scripts need `compose.yaml` and `.env` at the repo root. `task deploy` refuses to install
    a unit whose path doesn't match the clone, and `stack/layout.test.sh` fails if the path
    names a script that doesn't exist. Moving the clone, or a script, means editing those
    lines and running `task deploy` right after pulling.

14. **Decluttarr replaces queued downloads only, and only three jobs are on.**
    `apps/decluttarr/config.yaml` lists `remove_stalled`, `remove_slow` and
    `remove_metadata_missing`; listing any job turns it on, and `remove_orphans` /
    `remove_unmonitored` would delete seeding torrents or upgrades, so
    `apps/decluttarr/config.test.sh` pins the list. What it removes was never imported, so
    it never meets `arr-reclaim` (trap 9). `remove_slow` pauses while qBittorrent runs above
    80% of its `dl_limit` (64 MiB/s, just under the 600 Mbit/s line); a limit of 0 means
    it never pauses. Its `detect_deletions` watcher starts even when unlisted, so give it
    no media mounts. The image is pinned, so it has no `update` task.

15. **Plex's own subtitle download is not a permissions problem.** Plex stores downloaded
    subtitles in its database, not the library; `Got a subtitle of 99 bytes` in its log is
    its subtitle server's 500, upstream. **Bazarr** (Phase 9) writes `.es.srt`/`.en.srt`
    beside the video for every Radarr/Sonarr title, monitored or not (`only_monitored`
    stays off: most of the library is unmonitored). It mounts `streaming/` only, and
    `apps/bazarr/configure.sh` owns **all** its language profiles (Bazarr replaces the
    whole list on a write). A sidecar never counts as media for `arr-reclaim`.

16. **Every checkout is the live stack to compose.** `compose.yaml` fixes the project name
    (`pms`), so `docker compose up` from a worktree recreates the live containers, and a
    relative bind (decluttarr's `./config.yaml`) then points into that worktree and breaks
    once it is deleted. Run read-only compose (`config`, `ps`, `logs`) anywhere; create or
    recreate containers, and install units, only from the main clone. The Taskfile's
    `start`, `stop`, `<app>:up`, `<app>:update`, `update` and `deploy` refuse elsewhere
    (`stack/main-clone.sh`). The configure scripts talk to the apps' APIs, not compose, so
    they run anywhere.

## Conventions

- Commit subjects are lowercase and imperative; bodies explain *why*.
- `.env` holds secrets and is gitignored. Only `.env.example` is tracked.
- [Task](https://taskfile.dev) (`Taskfile.yml`) is the task runner, nothing else: no
  dependencies. Run `task lint test` before committing. `task --list` shows every task.
- A new app follows the app contract in the README: `apps/<app>/` with `compose.yaml`,
  `Taskfile.yml`, `README.md` (and `configure.sh` plus its test when this repo owns its
  settings), one include line each in `compose.yaml` and `Taskfile.yml`. Tests live beside
  what they test.
- `task check` (every app's drift plus deploy drift) and `task deploy:check` are read-only.
  `task deploy` changes init state and needs sudo, so it's the user's to run.
