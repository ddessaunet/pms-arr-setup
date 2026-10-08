[← Index](../README.md)

# Phases

Moving from the native setup in [pms-local](https://github.com/ddessaunet/pms-local) to a containerized arr stack,
one reversible step at a time. Each phase has **Do**, **Verify** and **Rollback**. The native
setup keeps working until Phase 7, and you can stop between any two phases for as long as
you like.

Tick these as phases finish, and commit the tick. This list is how you (or the next session)
tell what has been done. If it looks stale, check the server rather than trusting it.

- [x] Phase 0 — foundation
- [x] Phase 1a — test Plex beside the native one
- [x] Phase 1b — Plex cutover (2026-09-28: identity `f3860770…`, counts 132/7/2/5 carried over)
- [x] Phase 2 — qBittorrent, parallel instance (2026-09-29: settings from qbt-configure, test download + hardlink verified)
- [x] Phase 3 — Prowlarr + FlareSolverr (2026-09-29: 6 indexers pass, 1337x + EZTV via FlareSolverr)
- [x] Phase 4 — Radarr + Sonarr (2026-09-29: grab → hardlink import → Plex delete → arr-reclaim freed 10 GB, unmonitored)
- [x] Phase 5 — Seerr (requests) (2026-09-29: two requests auto-approved → HD-1080p grab → hardlink import → Available)
- [x] Phase 6 — Recyclarr: 4K HDR as the default for movies (2026-10-01: Air grabbed 2160p HDR10+ in the cap, hardlinked, Available; Dune's 1080p torrent reclaimed when 4K replaced it)
- [x] Phase 6b — opt-in `4K HDR or 1080p` profile for films with no 4K HDR release, re-searched daily (2026-10-02: Cosmic Sin grabbed 1080p WEBRip, hardlinked, Available; a dead first grab replaced by Decluttarr)
- [ ] Download health — seeder floor, 4K ranked by release tier, Decluttarr replaces stalled/slow grabs
- [x] Phase 7a — retire native qBittorrent and `plex-watch` (2026-09-29: 9 native torrents dropped, all 10 library files kept at 1 link; both services disabled)
- [x] Phase 7b — remove native Plex and pms-local's leftovers (2026-09-29, same day as 7a by choice: DB archived to /root, packages, units, files and user removed)
- [x] Phase 8 — library cleanup (2026-09-30; one-off for this box, so not kept in the repo)
- [x] Phase 9 — Bazarr: Spanish + English subtitles beside the media (2026-10-01: Days of Thunder `.es.srt` beside the video, Plex lists it, hardlink kept, reclaim audit removes nothing)
- [ ] Address check — `lan-address.timer` re-applies the apps' address settings when DHCP moves the box

Run `stack/preflight.sh` before each of Phases 0–1b. It is read-only.

---

## Rules that span phases

1. **Mount data at its host path.** `/mnt/data/...` inside the container, never `/data`.
   The Plex database stores absolute library paths and qBittorrent's `.fastresume` files
   store absolute save paths. Keep the paths identical and both carry over untouched, with
   no Remote Path Mappings in the arrs.
2. **Any container that hardlinks gets `/mnt/data` as one bind mount.** qBittorrent, Radarr
   and Sonarr must see `torrents/` and `streaming/` through the *same* mount. Two bind mounts
   of the same filesystem still make `link()` fail with `EXDEV`, and the arrs then quietly
   fall back to copying. That doubles disk use on a volume that is nearly full (`df -h /mnt/data`).
3. **Appdata lives on `/`** (`/opt/appdata`), never on `/mnt/data`.
4. **Everything runs as `1000:1001` (dario:media).** The library is already `dario:media`,
   so no media file ever needs a chown.
5. **`plex-watch` was live until Phase 7a.** It treated *any* `delete` or `moved_from` under
   `/mnt/data/streaming` as "deleted in Plex" and removed the matching native torrent **and
   its data**, so until then the arrs only *added* files. It's retired now, and moves are
   safe. pms-local is not modified by this migration; what the stack needs from it is ported here (`arr-reclaim`).
6. **Upgrades only in the 4K movie profiles (`UHD Bluray + WEB` and its `4K HDR or 1080p` variant), and movie sizes are capped**
   (Radarr 1080p 40, 2160p 150 MB/min; Sonarr 1080p no max; `arr-configure.sh`). Everything else is single-grab.
7. **Media is deleted in Plex, and that frees the space.** For Radarr/Sonarr imports,
   this repo's `arr-reclaim` removes the torrent, and it does the same when one is deleted
   in Radarr/Sonarr with its files. For the rest of the library, including
   the ex-native titles whose torrents Phase 7a dropped, the library file is the only link,
   so deleting it frees the space by itself.

---

## Phase 0 — Foundation

Nothing on the server changes except one empty directory.

**Do**

```bash
cp .env.example .env
$EDITOR .env                      # check TZ; PLEX_CLAIM only for a fresh install
```

```bash
sudo install -d -o 1000 -g 1001 /opt/appdata
```

```bash
stack/preflight.sh 0
```

**Verify:** preflight passes. The hardlink check (same filesystem) is the one that matters.

**Rollback:** `sudo rmdir /opt/appdata`.

---

## Phase 1a — Test Plex (done 2026-09-28)

A throwaway second server (`plex-shadow`, `:32420`, library read-only) proved the image on
this box before anything native was stopped:
- it scanned the same library (132 / 7 / 2 / 5)
- it direct-played a title
- it survived a real `update-stack.sh` run (image recreate, health check, old image removed)

It has since been removed from `compose.yaml`.

A fresh install has no native server to test against. It starts `plex` directly, with
`PLEX_CLAIM` set in `.env` for the first start.

---

## Phase 1b — Plex cutover (done 2026-09-28)

The `plex` container took over with a **copy** of the native database. It serves:
- the same identity, `f3860770…`
- the same version (1.43.4.10903) and the same library counts
- 48 history entries and 12 On Deck items

The steps were:
1. Hold *Empty trash automatically* off while copying, so a missing mount couldn't delete
   titles.
2. Disable `plex-update.timer`.
3. Stop and **mask** `plexmediaserver`.
4. `rsync` the native `Plex Media Server` directory into
   `/opt/appdata/plex/Library/Application Support/`, and `chown` the copy to 1000:1001.
5. Start the container.
6. Check the identity and counts match, then restore the trash setting.

Native `plexmediaserver` stayed installed and masked, with its database untouched in
`/var/lib/plexmediaserver`, until Phase 7b removed the package. It's archived in
`/root/plexmediaserver-native.tgz`, and the mask stays.

**Still to do once:**
- Arm the container updater with `task update:dry`, then `task deploy`. It's armed
  only while native Plex is masked. See [Updating](updating.md).
- Remove "PMS shadow" from plex.tv → Authorized Devices, then run
  `rm -rf /opt/appdata/plex-shadow`.

**Rollback** (until Phase 7b; after it, see Phase 7b's rollback)

```bash
docker compose stop plex
```

```bash
sudo systemctl unmask plexmediaserver && sudo systemctl start plexmediaserver
```

Then swap the updaters. Both deploys read the mask, so re-running each one puts its own timer
right:

```bash
task deploy
```

```bash
cd ../pms-local && npm run deploy-system
```

Anything watched while the container was running is lost, because the native database never
saw it.

---

## Phase 2 — qBittorrent, parallel instance

A **second** qBittorrent in a container (`:8081`, peer port `13762`), for Radarr and Sonarr
only. Native `qbittorrent-nox` keeps `:8080`, peer port `13761`, its torrents and its
`on-complete.sh` hook until Phase 7. The working import path never has a gap, and
pms-local's `plex-reconcile` only ever sees the native instance.

- **No VPN**, the same as native.
- **Seeding** (set in Phase 4): ratio 2.0 or 14 days, then the torrent stops, and
  Radarr/Sonarr remove it. Deleting in Plex is faster: `arr-reclaim` removes the torrent
  right away.

**Do**

1. Choose a WebUI login for this instance and put it in `.env`:

   ```bash
   $EDITOR .env                      # QBT_ARR_USER= and QBT_ARR_PASS=
   ```

2. Start it. `task start` runs the preflight first, which checks `:8081`, `:13762/tcp` and
   `:13762/udp` are free.

   ```bash
   task start
   ```

   > This also recreates `plex` once (about 20 s), picking up the `PLEX_CLAIM` and `UMASK`
   > config changes. The config is unchanged, so it's the same server. Do it when nobody is
   > watching.

3. Apply the settings. The first run logs in with the temporary password the container
   prints and sets your `.env` login. It then applies the paths, categories, peer port and
   host-header domains, and reads everything back:

   ```bash
   task qbittorrent:configure
   ```

   The settings themselves are data at the top of
   [`apps/qbittorrent/configure.sh`](../apps/qbittorrent/configure.sh). `task qbittorrent:check` reports drift
   and changes nothing.

**Verify**

- `task qbittorrent:check` exits 0, and running `task qbittorrent:configure` again changes nothing.
- A small legal test torrent added with category `radarr` downloads into
  `/mnt/data/torrents/.incomplete-arr/`, then lands in `/mnt/data/torrents/radarr/`. It's
  owned `dario:media` and group-writable.
- **Hardlinks work from inside the container.** Test under `torrents/`, never `streaming/`,
  so `plex-watch` doesn't see it:

  ```bash
  docker exec qbittorrent sh -c 'f=$(find /mnt/data/torrents/radarr -type f | head -1); ln "$f" /mnt/data/torrents/.hardlink-test && stat -c "%h links" "$f"; rm /mnt/data/torrents/.hardlink-test'
  ```

  It prints `2 links`. Then delete the test torrent with its files.
- Native is untouched: `qbittorrent-nox` is active and `:8080` lists the same torrents.
- `task update:dry` covers it (`UPDATE_SERVICES=plex qbittorrent`).

**Rollback**

```bash
docker compose rm -sf qbittorrent
```

```bash
rm -rf /opt/appdata/qbittorrent
```

Then take `qbittorrent` out of `UPDATE_SERVICES` in `.env`. Native was never touched.

---

## Phase 3 — Prowlarr + FlareSolverr

Prowlarr manages the indexers, and from Phase 4 hands them to Radarr and Sonarr. FlareSolverr
solves Cloudflare challenges for the indexers that need it. **Neither touches `/mnt/data`**,
and nothing native changes, so this is the lowest-risk phase.

- **Prowlarr:** `:9696` on the LAN. Login is forms-based, but not asked from local
  addresses.
- **FlareSolverr:** not published. Only Prowlarr reaches it, as `flaresolverr:8191` on
  `arr`.
- **The API key is fixed from `.env`** before the first start (`PROWLARR__AUTH__APIKEY`), so
  Phase 4 uses it without copying it out of the UI.
- **Indexers:** 1337x, The Pirate Bay, LimeTorrents, Knaben, YTS and EZTV. **1337x and EZTV
  go through FlareSolverr.** Both passed a test once, then hit a Cloudflare challenge, and
  pass through it. The list, and which ones use FlareSolverr, is data at the top of
  [`apps/prowlarr/configure.sh`](../apps/prowlarr/configure.sh).

**Do**

1. Check `.env`. `PROWLARR_API_KEY` must be 32 hex characters (`openssl rand -hex 16`). Also
   choose `PROWLARR_USER` and `PROWLARR_PASS`:

   ```bash
   $EDITOR .env
   ```

2. Start it. Only `prowlarr` and `flaresolverr` are created; `plex` and `qbittorrent` stay
   running as they are.

   ```bash
   task start
   ```

3. Apply the login, the FlareSolverr proxy and the indexers. It reads everything back and
   **tests every indexer**. This takes a couple of minutes: each FlareSolverr test is about
   15–20 s.

   ```bash
   task prowlarr:configure
   ```

   An indexer that fails its test is reported as `FAILING` but doesn't fail the run, because
   public trackers come and go. If the failure message says *blocked by CloudFlare
   Protection*, switch that entry to `flare` in the script and run it again.

**Verify**

- `task prowlarr:check` exits 0, and running `prowlarr:configure` again changes nothing.
- A search returns results through a FlareSolverr indexer and a direct one: search a known
  title in the WebUI (Search), or:

  ```bash
  curl -s -H "X-Api-Key: $(sed -n 's/^PROWLARR_API_KEY=//p' .env)" "http://127.0.0.1:9696/api/v1/search?query=draft%20day&type=search" | jq 'group_by(.indexer) | map({(.[0].indexer): length}) | add'
  ```

- Nothing else touched: `plex` and `qbittorrent` weren't recreated, and `plex-watch` is quiet.
- `task update:dry` covers both (`UPDATE_SERVICES=… prowlarr flaresolverr`).

**Rollback**

```bash
docker compose rm -sf prowlarr flaresolverr
```

```bash
rm -rf /opt/appdata/prowlarr
```

Then take both out of `UPDATE_SERVICES` in `.env`.

---

## Phase 4 — Radarr + Sonarr

The first services besides pms-local that write into the library. They handle **new content
only**.

**Media already in the library isn't imported here.** Organising it would mean moves,
which `plex-watch` read as deletions (rule 5) until Phase 7a.

| | |
|---|---|
| Radarr | `:7878`, root `/mnt/data/streaming/movies`, new imports `Title (Year)/Title (Year).ext` |
| Sonarr | `:8989`, root `/mnt/data/streaming/series`, `Show/Season 01/Show - S01E01.ext` |
| quality | **1080p** (`HD-1080p`, **no Remux**), sizes **capped at 40 MB/min** (about 4.8 GB for a 2-hour film; 25 preferred). Sonarr's max was later removed: 880 MB for a 22-minute episode rejected every real 1080p WEB-DL, **no upgrades** on any profile until Phase 6 |
| downloads | the `:8081` qBittorrent, categories `radarr` / `sonarr`, **hardlinked** into the library |
| seeding | ratio 2.0 or 14 days, then the torrent **stops**, and *Remove Completed* removes it (the library keeps its hardlink) |
| deleted in Plex | **unmonitored**, never re-downloaded, and **`arr-reclaim`** removes its torrent **with its data** within about a minute |
| deleted in Radarr/Sonarr, with its files | gone from the app, and `arr-reclaim` removes its torrent the same way (from its ledger, below) |
| indexers | pushed by Prowlarr (full sync); not configured here |
| Plex | refreshed on import and delete, through `host.docker.internal:32400` |

**How `arr-reclaim` decides.** `jobs/arr-reclaim/arr-reclaim.sh`, run by `arr-reclaim.service`, ports
pms-local's `plex-watch` + reconcile to the `:8081` instance. It watches the library with
inotify and waits 60 s of quiet after a burst of deletions. It then removes a torrent **only
when all three are true**:
- Radarr or Sonarr **imported** it: its hash is in their import history.
- **Every** file imported from it is gone from the library.
- **No other link** to its data remains.

So a finished download that isn't imported yet, one episode deleted out of a season pack, or
a file that was only moved are all kept. There are at most 3 removals per run.

**Its ledger** (added 2026-09-30). Deleting a movie in Radarr (or a series in Sonarr) also
deletes its history, before any run can read it: Night of the Living Dead, deleted in Radarr
with its files, was logged `not-imported` and kept its 1.6 GB torrent. So `arr-reclaim`
records the import history it sees in `/opt/appdata/.arr-reclaim.imports`, every minute
while idle and on every run, and decides from the history plus that ledger. Only a delete
within that minute of the import slips through, and is kept. A row is dropped once both the
app and qBittorrent have forgotten it. Deleting in Radarr **without** its files keeps the
torrent, rightly: the library still links it.

**Do**

1. Choose `ARR_USER` / `ARR_PASS` in `.env`. The API keys and `PLEX_TOKEN` are already
   there. Then run the preflight:

   ```bash
   stack/preflight.sh
   ```

2. Start them. Only `radarr` and `sonarr` are created.

   ```bash
   task start
   ```

3. Configure. These are idempotent, and each ends with a read-back:

   ```bash
   task qbittorrent:configure
   ```

   ```bash
   task arr:configure
   ```

   ```bash
   task prowlarr:configure
   ```

   - `task qbittorrent:configure` sets the seeding limits.
   - `arr:configure` restarts each app once to activate its allowed hosts.
   - `prowlarr:configure` adds Radarr and Sonarr as applications and pushes the indexers.

4. Install and start the `arr-reclaim` watcher (with the updater units):

   ```bash
   task deploy
   ```

**Verify**

- `task arr:check` and `task prowlarr:check` show no drift. The download client and
  Plex tests pass, and both apps list their synced indexers.
- `task deploy:check` shows `arr-reclaim.service` enabled and running, and
  `task arr-reclaim:audit` has nothing to do.
- **End to end:** add *Night of the Living Dead (1968)* (public domain) in Radarr, 1080p,
  monitored, and search.
  - It downloads under category `radarr`, and imports as
    `movies/Night of the Living Dead (1968)/Night of the Living Dead (1968).<ext>` with
    **2 links**.
  - Plex shows it.
  - Then **delete it in Plex**. Within about a minute,
    `journalctl -u arr-reclaim` logs `Removed … with its data`, the space comes back
    (`df -h /mnt/data`), the empty folder is pruned, and Radarr marks the movie
    **unmonitored** without a new grab.
- **Sonarr without downloading:** add a series unmonitored and run an interactive search for
  one episode. Releases come back through the synced indexers.
- Nothing else moved: native `qbittorrent-nox` and `plex-watch` are untouched.

**Rollback**

```bash
sudo systemctl disable --now arr-reclaim
```

```bash
docker compose rm -sf radarr sonarr
```

```bash
rm -rf /opt/appdata/radarr /opt/appdata/sonarr
```

Then delete the Radarr/Sonarr applications in Prowlarr, and take `radarr sonarr` out of
`UPDATE_SERVICES`.

---

## Phase 5 — Seerr (requests)

The request UI in front of Radarr and Sonarr. It's **Seerr**, the merged successor of
Jellyseerr and Overseerr (Overseerr is archived, and the old Jellyseerr image isn't updated
any more).

It only files requests and has **no media mounts**. A request becomes an ordinary
Radarr/Sonarr add, so everything from Phase 4 applies to it: 1080p, hardlinked imports, no
upgrades, unmonitor on delete, and `arr-reclaim` freeing the space of a Plex delete.

- **Only you sign in**, and your requests are approved automatically.
- **The existing library shows as Available.** Seerr scans Plex, so titles already there
  can't be requested again, whether or not Radarr/Sonarr know them.

**Do**

1. Start it. Only `seerr` is created:

   ```bash
   task start
   ```

2. **Sign in with Plex once**, in a browser: open `http://192.168.0.86:5055` and choose
   *Sign in with Plex*. That's Seerr's first-run OAuth and the one step that can't be
   scripted. **Stop after signing in**; don't continue the wizard.

3. The script does the rest of the wizard:
   - the Plex server, and the Movies and TV Shows libraries
   - Radarr and Sonarr at HD-1080p, with their root folders
   - sign-in limited to you
   - marks the wizard finished and starts a full Plex scan

   ```bash
   task seerr:configure
   ```

   Its key is Seerr's own, read from `/opt/appdata/seerr/settings.json`; nothing goes in
   `.env`. Run before the sign-in, it stops and tells you to sign in.

**Verify**

- `task seerr:check` exits 0:
  - Plex is `f3860770…` (the same server as Phase 1b)
  - Movies and TV Shows are the enabled libraries
  - both server tests pass at HD-1080p
  - sign-in is admin-only
  - once the scan is done, the Available count is close to Plex's
- A request auto-approves and appears in Radarr (monitored, HD-1080p, searching). It then
  imports as in Phase 4 and turns Available in Seerr. Check the release size first.
- A title already in the library (e.g. *Tenet*) shows as Available and can't be requested.

**Rollback**

```bash
docker compose rm -sf seerr
```

```bash
rm -rf /opt/appdata/seerr
```

Then take `seerr` out of `UPDATE_SERVICES`. Radarr, Sonarr and the library are untouched.

---

## Phase 6 — Recyclarr: 4K HDR as the default for movies

New movie grabs default to **4K HDR**, the quality you choose most. **Series stay 1080p**,
because many have no 4K release. Decided 2026-09-29, with these parameters:

| | movies (Radarr) | series (Sonarr) |
|---|---|---|
| default profile | TRaSH **UHD Bluray + WEB** | TRaSH **WEB-1080p** |
| qualities | Bluray-2160p, WEB-DL/WEBRip-2160p **as one group**, so score decides (see Download health); **no Remux, no 1080p** | WEB-DL/WEBRip-1080p |
| HDR | **HDR +500, HDR10+ +100.** SDR, DV without an HDR10 fallback (purple/green on non-DV screens), x265 without HDR, and generated HDR are all **−10000**, so they're rejected | — |
| size cap | **150 MB/min** (~18 GB for 2 hours: most 4K HDR WEB-DLs, not 30–60 GB Bluray encodes) | **none** (25 preferred): a half-hour show's 1080p WEB-DL runs 1–1.6 GB, over 40 MB/min |
| upgrades | **on**, to a better-scored 4K release | off |

**Who owns what,** so no two tools fight:
- **Recyclarr** (`apps/recyclarr/recyclarr.yml`): those two profiles, the hand-picked
  `UHD Fallback` (below), and their custom formats.
- **`arr-configure.sh`:** sizes (Recyclarr's `quality_definition` is deliberately left out),
  and upgrades off on every other profile.
- **`seerr-configure.sh`:** requests default to those two profiles.

**Upgrades are safe with both watchers.**
- An upgrade replaces the library file at the same path. `plex-watch` ignores it, because
  it isn't a native torrent.
- `arr-reclaim` sees the path re-imported by a newer download, and removes the **old**
  torrent once nothing links to its data (`upgraded`).

**Playback:** transcoding is CPU-only, so 4K HDR has to **direct-play** (a 4K HDR TV app,
Shield or Apple TV). **Films with no 4K HDR release:** this profile grabs nothing for them,
and the request waits. Request them with `4K HDR or 1080p` instead (Phase 6b).

**4K releases exist, but none pass:** switch the film to **`UHD Fallback`** (Radarr → movie →
Edit → Quality Profile, then Search; or pick it in Seerr's request options). It is never a
default. It has the same 2160p group and size cap, with no Remux and no upgrades, but:
- HDR is preferred (+3000, HDR10+ +100), not required.
- There are no release-group tiers.
- LQ groups such as YTS pass.
- Audio is ranked as in the default (TrueHD Atmos 5000 down to DD 750). HDR is raised from
  the guide's 500 so that it comes first: only TrueHD Atmos or DTS X on SDR outranks HDR.

It still rejects files that are broken or fake (disc images, 3D, upscales, generated HDR,
DV without fallback). To get a better copy later, switch the film back to
`UHD Bluray + WEB`. Its upgrades replace the file, and `arr-reclaim` removes the old torrent.
`task recyclarr:sync` creates it, and `task arr:check` then lists it as existing with
no Remux. The weekly search (Phase 6b) never looks at it.

**Do**

1. **Preview.** This changes nothing:

   ```bash
   task recyclarr:preview
   ```

   It should list both profiles and their custom formats, and **no quality definitions**.
   Recyclarr draws the report as a table, so run it in a real terminal; piped, it shows
   only the log lines.

2. **Apply,** in this order. Each step needs the one before it:

   ```bash
   task recyclarr:sync
   ```

   ```bash
   task arr:configure
   ```

   ```bash
   task seerr:configure
   ```

   `recyclarr:sync` creates the profiles. `arr:configure` then applies the 2160p caps and
   the upgrade allow-list. `seerr:configure` points requests at the new defaults.

**Verify**

- `task arr:check`:
  - Radarr: 2160p capped at 150/100, 1080p at 40/25; upgrades only on `UHD Bluray + WEB`
    (and `4K HDR or 1080p` after Phase 6b); the default profile exists with no Remux.
  - Sonarr: `WEB-1080p`, no upgrades; 1080p sizes with no max, 25 preferred.
- `task seerr:check`: default profiles `UHD Bluray + WEB` and `WEB-1080p`.
- Existing movies keep their profile.
- **End to end:** request a film with 4K HDR releases, after a size check as before.
  - Radarr grabs a **2160p HDR** release within 150 MB/min × runtime.
  - Its custom formats show **HDR**, and not SDR or DV (w/o HDR fallback).
  - Hardlinked import, then Available in Seerr.
- **When an upgrade happens:** `journalctl -u arr-reclaim` shows the old torrent removed:
  `an upgrade replaced it` when the new file has the same name, or `its library files are
  gone` when the extension changed (`.mp4` → `.mkv`).

**Rollback**

- Delete the `UHD Bluray + WEB` and `WEB-1080p` profiles in Radarr and Sonarr. Recyclarr
  only ever wrote profiles and custom formats.
- Set `default_profile` in `arr-configure.sh` and `profile_name` in `seerr-configure.sh`
  back to `HD-1080p`, then re-run `task arr:configure` and `task seerr:configure`.

---

## Phase 6b — `4K HDR or 1080p`: always get something, then 4K

`UHD Bluray + WEB` accepts nothing below 4K HDR. A film with no such release (common for
anything older than about 2015) gets **no download**: Radarr keeps it monitored and
missing, and the Seerr request waits. Radarr also searches a movie in full **only when it is
added**. After that it sees new releases through RSS only, every 30 minutes, and has no
scheduled search for missing movies. Decided 2026-10-02:

| | what | owned by |
|---|---|---|
| profile | **`4K HDR or 1080p`**: the same TRaSH profile and scores as `UHD Bluray + WEB`, with a 1080p group (Bluray, WEB-DL, WEBRip) under the 4K one. Upgrades on, until 4K. No 720p, no Remux. 1080p x265 without HDR is rejected, as TRaSH intends | `apps/recyclarr/recyclarr.yml` (a profile variant, Recyclarr ≥ 8.3) |
| upgrades / no Remux | both 4K movie profiles | `arr-configure.sh` |
| default | **unchanged**: requests default to `UHD Bluray + WEB`. Pick the variant per request in Seerr's request options (admin) | `seerr-configure.sh` |
| re-search | **daily, 04:00**: the variant's monitored, released movies without a 4K file (1080p, or none) get one Radarr search. Movies already in 4K are left to RSS | `jobs/arr-fallback-search/arr-fallback-search.sh`, `arr-fallback-search.timer` |

**What happens to a request.**
- With a 4K HDR release, the variant takes it, as the default profile would.
- Without one, it takes the best-scored 1080p within 40 MB/min.
- A 4K HDR release later replaces that file, found through RSS or the daily search, and
  `arr-reclaim` removes the 1080p torrent (`upgraded`).
- Score upgrades also happen within 1080p, for example an untiered WEB-DL replaced by a
  tiered one.
- 1080p Bluray encodes get no tier score: the UHD formats have none.

**A movie already in Radarr** (for example a 4K request that is still waiting): set its
profile to `4K HDR or 1080p` in Radarr, then *Search Movie*, or run
`task arr-fallback-search:run`.

**Do**

1. **Preview.** It should show `4K HDR or 1080p` as **New**, with the same scores as
   `UHD Bluray + WEB`, and no change to any other profile or custom format:

   ```bash
   task recyclarr:preview
   ```

2. **Apply,** in this order:

   ```bash
   task recyclarr:sync
   ```

   ```bash
   task arr:configure
   ```

3. **Arm the daily search** from the main clone, after the merge. It needs sudo, so it's
   yours to run:

   ```bash
   task deploy
   ```

**Verify**

- `task arr:check`: upgrades only on `UHD Bluray + WEB, 4K HDR or 1080p`; both exist
  with no Remux.
- `task seerr:check`: the default is still `UHD Bluray + WEB`.
- `task deploy:check`: `arr-fallback-search.timer` armed; `task status` shows its next run.
- **End to end:** request a film with no 4K HDR release in Seerr, with `4K HDR or 1080p`
  in the request's options.
  - Radarr grabs a 1080p release within 40 MB/min × runtime.
  - Hardlinked import, then Available.
  - `task arr-fallback-search:dry` lists it.

**Done 2026-10-02 with *Cosmic Sin* (2021),** whose only 4K releases are SDR YTS encodes:
- **The search when it was added grabbed nothing.** 1337x, which has the only usable
  releases, answered with 0 results, and 30 a minute later.
- **`task arr-fallback-search:run` grabbed** a 1080p Bluray listed with 52 seeders that had
  no peers. Decluttarr's `remove_metadata_missing` replaced it about 40 minutes later with
  a 1080p WEBRip (1.8 GB, 1,742 seeders).
- **Import:** hardlinked, 2 links; then Available in Seerr.
- **The re-search timer went from weekly to daily** because of that empty first search.

**Rollback**

- Move any movies on `4K HDR or 1080p` to another profile, since Radarr won't delete a
  profile in use. Then delete the profile in Radarr.
- Remove its entry from `apps/recyclarr/recyclarr.yml` and `upgrade_profiles` in
  `arr-configure.sh`.
- Remove the timer from `stack/deploy.sh`, then
  `sudo systemctl disable --now arr-fallback-search.timer`.

---

## Download health — well-seeded grabs, and a replacement for one that crawls

Public trackers can't **guarantee** a speed; the swarm decides. What the stack can do is
**pick well-seeded releases** and **replace a download that stalls**. Decided 2026-09-29,
after the Phase 6 upgrade grab of *Dune: Part Two* crawled at ~200 kB/s (11 seeders, ~12 h
for 15 GB). The line was not the cause: the three grabs before it imported at 41–45 Mbit/s
(the line is 600 Mbit/s, not the ~50 first assumed, so those were swarm-bound too).

Why that release was picked (a `/release` search, 2026-09-29):
- A **WEB Tier 01** 2160p WEB-DL (DV/HDR, score 5200, **508 seeders**) was refused by the
  150 MB/min cap: 29.3 GB for a 166-minute film. The cap stays; the disk is at 91%.
- Radarr compares **quality before score**, and the TRaSH template ranked Bluray-2160p
  above WEB 2160p. So an untiered Bluray encode (score 3500, 11 seeders) outranked every WEB
  release, whatever its tier or seeders.

| | what | owned by |
|---|---|---|
| seeder floor | **minimum 5 seeders** on every Radarr/Sonarr indexer, pushed from Prowlarr's sync profile | `prowlarr-configure.sh` (`MIN_SEEDERS`) |
| 4K ranking | Bluray-2160p, WEB-DL-2160p and WEBRip-2160p in **one group**, so score (TRaSH's release-group tiers) decides; tiered groups are the well-seeded ones | `apps/recyclarr/recyclarr.yml` |
| replacement | **Decluttarr**: a queued download stalled (no connections), under **500 KB/s**, or stuck on metadata for 3 checks in a row, 10 min apart, is removed, blocklisted, and searched again (~30–40 min) | `apps/decluttarr/config.yaml` |
| qBittorrent | global download limit **64 MiB/s** (~537 Mbit/s, just under the 600 Mbit/s line; first set at 5 MiB/s from a wrong ~50 Mbit/s estimate, corrected 2026-09-30), so Decluttarr's slow check pauses while the line is busy rather than blaming a swarm; a stalled download no longer holds one of the 3 active slots | `qbt-configure.sh` |

**What Decluttarr never does.** It works on the Radarr/Sonarr **queue** only, i.e. downloads
not yet imported, so an imported torrent that is seeding is never touched. A removed
download was never imported, so it never reaches `arr-reclaim`'s import history
(CLAUDE.md trap 9). A replaced *upgrade* leaves the old library file where it is. Only
three jobs are listed, because listing a job turns it on; `remove_orphans` and
`remove_unmonitored` would delete seeding torrents or upgrades. `apps/decluttarr/config.test.sh`
pins that list.

**Do**

1. **Quality ranking.** Preview first; it should show only `UHD Bluray + WEB` changing, with
   its qualities becoming one `UHD 2160p` group and "Upgrade Until Quality" following it:

   ```bash
   task recyclarr:preview
   ```

   Then apply, in the Phase 6 order:

   ```bash
   task recyclarr:sync
   ```

   ```bash
   task arr:configure
   ```

   ```bash
   task seerr:configure
   ```

2. **qBittorrent** (download limit, slow-torrent slots):

   ```bash
   task qbittorrent:configure
   ```

3. **Seeder floor.** This also pushes every indexer to Radarr and Sonarr once:

   ```bash
   task prowlarr:configure
   ```

4. **Decluttarr, in test mode first.** It logs what it would remove, and removes nothing:

   ```bash
   DECLUTTARR_TEST_RUN=true docker compose up -d decluttarr
   ```

   ```bash
   docker logs -f decluttarr
   ```

   Expect `TEST MODE IS ACTIVE`, `OK` for qBittorrent, Radarr and Sonarr, and a
   `detect_deletions … does not have access` warning per root folder (expected: it has no
   media mounts, on purpose). After a few checks a crawling download shows
   `flagged download (n/3 strikes)`. Then run it for real:

   ```bash
   docker compose up -d decluttarr
   ```

   The in-flight *Dune* upgrade (`BE9DBF15…`, ~200 kB/s) will likely be replaced. The next
   acceptable release is a 12.4 GB UHD BRRip with 48 seeders. Phase 6's end-to-end check then
   follows the new hash.

**Verify**

- `task qbittorrent:check`, `task prowlarr:check` and `task arr:check` are clean. The
  arr check reports `minimum seeders 5` on both apps; `1,5` means a push is still on its way.
- A Dune search (Radarr → Interactive Search) ranks WEB Tier 01 releases above untiered
  Bluray encodes, and releases with under 5 seeders are refused.
- On a replacement: Decluttarr's log has the strikes and the removal; Radarr's history
  shows `downloadFailed`, the release is on its blocklist, and a new grab follows.
  `journalctl -u arr-reclaim` shows nothing for it.

**Rollback**

- `docker compose stop decluttarr` stops replacements at once; `docker compose rm decluttarr`
  removes it. Nothing else depends on it.
- Seeder floor: set `MIN_SEEDERS=1` and re-run `task prowlarr:configure`.
- 4K ranking: remove `qualities:` and `until_quality` from `recyclarr.yml`, then
  `task recyclarr:sync`.
- qBittorrent: drop `dl_limit` and `dont_count_slow_torrents` from `want_prefs`, set them
  back in the WebUI (0 and off), and `task qbittorrent:check` is clean again.

---

## Phase 7a — Retire native qBittorrent and `plex-watch`

Start only after Phase 6 is ticked: its upgrade check needs `plex-watch` still running.

After this, `arr-reclaim` is the only watcher and the `:8081` container the only
qBittorrent. Nothing reads a move in the library as a deletion any more.

**The native torrents are dropped, not moved.** Decided 2026-09-29. Every one of them is
already hardlinked into the library, so deleting a torrent *with its data* removes only the
`torrents/` copy:
- **No space is freed and nothing leaves Plex.** The library keeps each file through its
  own link.
- **A later delete in Plex frees the space by itself,** because nothing else links to the
  file. No watcher has to reconcile these titles again.

Moving them into the container was the alternative. Moved torrents aren't in Radarr's or
Sonarr's import history, so `arr-reclaim` would never remove them, and a Plex delete would
free nothing. Loosening `arr-reclaim` to cover them would have weakened its three-condition
rule. They're public-tracker torrents, so the seeding they lose costs nothing.

The container keeps `:8081` and peer port 13762. Ollama stays: it isn't only pms-local's.

**Do**

1. **Stop the watcher first**, so nothing reconciles while torrents go away:

   ```bash
   sudo systemctl disable --now plex-watch
   ```

   Disable, don't mask. `systemctl mask` refuses a unit whose file is in
   `/etc/systemd/system`, and pms-local installs `plex-watch.service` there. A mask wouldn't
   guard against pms-local anyway, because its `npm run deploy-system` reinstalls the unit
   file and then runs `enable` + `restart` on it. **Don't run pms-local's `deploy`,
   `deploy-system` or `deploy-all` again.** If one did run, a revived `plex-watch` could do
   no harm: it can only delete through native qBittorrent, which is stopped after step 4.

2. **Check that every native torrent is in the library.** This is read-only. It logs in to
   `:8080` with `/etc/plex-move.conf`, which is readable through the `qbittorrent-nox`
   group. It then looks for each media file's twin under `/mnt/data/streaming`:

   ```bash
   bash -s check <<'EOF'
   set -euo pipefail
   mode="${1:?check or drop}"
   conf=/etc/plex-move.conf
   val() { sed -n "s/^$1=//p" "$conf" | tr -d "\"'"; }
   qbt=http://127.0.0.1:8080/api/v2
   jar="$(mktemp)"; trap 'rm -f "$jar"' EXIT
   curl -sf -c "$jar" --data-urlencode "username=$(val QBT_USER)" \
        --data-urlencode "password=$(val QBT_PASS)" "$qbt/auth/login" >/dev/null
   hashes=(); bad=0
   while IFS=$'\t' read -r hash dir; do
       name="${dir##*/}"
       n=0; out=0
       while IFS= read -r -d '' f; do
           n=$((n + 1))
           if [[ -z "$(find /mnt/data/streaming -samefile "$f" -print -quit)" ]]; then
               echo "  NOT IN LIBRARY: $f"; out=1
           fi
       done < <(find "$dir" -type f -regextype posix-extended \
                     -iregex '.*\.(mkv|mp4|m4v|avi|mov|ts|wmv)$' -print0)
       if (( n == 0 )); then echo "NO MEDIA        $name"; bad=1
       elif (( out )); then  echo "NOT ALL LINKED  $name"; bad=1
       else                  echo "linked          $name"; hashes+=("$hash")
       fi
   done < <(curl -sf -b "$jar" "$qbt/torrents/info" \
            | jq -r '.[] | [.hash, .content_path] | @tsv')
   echo "${#hashes[@]} linked, bad=$bad"
   if [[ "$mode" == drop ]]; then
       (( bad == 0 )) || { echo "Not dropping anything: fix the lines above first." >&2; exit 1; }
       (IFS='|'; curl -sf -b "$jar" --data-urlencode "hashes=${hashes[*]}" \
            --data "deleteFiles=true" "$qbt/torrents/delete")
       echo "dropped ${#hashes[@]} torrents with their torrents/ copies"
   fi
   EOF
   ```

   Every line must say `linked`.
   - `NOT ALL LINKED` means a file would be lost. Stop and look at it, unless it's only a
     sample.
   - `NO MEDIA` means the torrent has no video file to check.

3. **Drop them.** Run the same block with `drop` in place of `check`. It checks again, and
   it deletes nothing unless every torrent is `linked`. Then confirm:
   - `df -h /mnt/data` is unchanged.
   - The library files now show **1 link**.
   - `/mnt/data/torrents/` holds only `radarr/`, `sonarr/` and `.incomplete*`.

4. **Stop native qBittorrent.** Its config, and the torrent state in
   `/home/qbittorrent-nox`, stay until 7b. Its hand-made unit is in `/etc/systemd/system`
   too, so it's disabled, not masked:

   ```bash
   sudo systemctl disable --now qbittorrent-nox
   ```

5. **Router: nothing to do.** No port was ever forwarded by hand. Native qBittorrent opened
   13761 through UPnP (its default), and the mapping went away when it stopped.

`plex-update.timer` has been disabled since Phase 1b; leave it.

**Verify**

- `plex-watch` and `qbittorrent-nox` are disabled and inactive. Nothing listens on `:8080`
  or `13761`:

  ```bash
  ss -Hltnu 'sport = :8080 or sport = :13761'
  ```

- `task deploy:check`, `task arr:check` and `task qbittorrent:check` are clean, and
  `task arr-reclaim:audit` has nothing to do.
- A Seerr request goes all the way through: Radarr → `:8081` → hardlink import → Plex.

**Rollback**

```bash
sudo systemctl enable --now qbittorrent-nox plex-watch
```

The client comes back empty, and the hook imports new downloads as before. The dropped
torrents don't come back, but their files never left the library.

---

## Phase 7b — Remove native Plex and pms-local's leftovers (done 2026-09-29)

The runbook planned about 2 stable weeks on 7a first. It ran the same day, by choice.
Ollama stays, and so does the `plexmediaserver` mask, which
guards against a reinstall fighting the container for `:32400`. `task deploy` counts a
missing unit as masked too, so the container updater stays armed either way.

1. **Archive native Plex, then remove both packages.** `apt remove` shows exactly these two.
   The `wants` link is a leftover from before the mask, and no package owns it:

   ```bash
   sudo tar -C /var/lib -czf /root/plexmediaserver-native.tgz plexmediaserver && sudo tar -tzf /root/plexmediaserver-native.tgz | wc -l
   ```

   ```bash
   sudo apt remove plexmediaserver qbittorrent-nox
   ```

   ```bash
   sudo rm /etc/systemd/system/multi-user.target.wants/plexmediaserver.service
   ```

   `apt remove` keeps `/var/lib/plexmediaserver` (1.2 GB) and the package's config files,
   and dpkg shows it as `rc`. The `plex` system user stays too.

2. **Remove what pms-local installed, and the hand-made `qbittorrent-nox` unit.** pms-local
   has no uninstall, so this is the list:

   ```bash
   sudo rm -r /opt/scripts /var/cache/plex-update
   ```

   ```bash
   sudo rm /etc/plex-move.conf /etc/sudoers.d/qbittorrent-plex /etc/logrotate.d/plex-move /etc/tmpfiles.d/plex-move.conf /var/log/plex-move.log*
   ```

   ```bash
   sudo rm /etc/systemd/system/plex-watch.service /etc/systemd/system/plex-update.service /etc/systemd/system/plex-update.timer /etc/systemd/system/qbittorrent-nox.service && sudo systemctl daemon-reload
   ```

3. **Remove the `qbittorrent-nox` user, its home and its group.** Its `Downloads/` held
   only one `.nfo`.

   ```bash
   sudo userdel -r qbittorrent-nox && sudo groupdel qbittorrent-nox
   ```

   `userdel` warns that it kept the group because you're a member, and that there's no mail
   spool. Both warnings are harmless, and `groupdel` removes the group.

   With the group gone, pms-local's `deploy.sh` stops before installing anything. That
   joins the unit files being gone as a guard against its deploys.

**Verify**

- Plex still answers as `f3860770…`.
- `task deploy:check` still shows `pms-update.timer` armed.
- `stack/preflight.sh` shows `plexmediaserver` masked and the other three `not-found`.
- `systemctl --failed` is empty.

**Rollback**

Native qBittorrent and pms-local are gone for good.

Native Plex can be reinstalled from Plex's apt repository and restored from
`/root/plexmediaserver-native.tgz`. That database stops at the Phase 1b cutover, so
everything watched or added since then is only in the container's database.

---

## Phase 9 — Bazarr (subtitles) (done 2026-10-01)

**Why.** Plex's own *Search subtitles* is unreliable, and it isn't a permissions problem.
Plex saves a subtitle it downloads into **its own database** (`Saved sub of N bytes to blob db`
in its log), never into the library, so `/mnt/data` permissions don't come into it. When
a download "does nothing", the log says `Got a subtitle of 99 bytes`: those 99 bytes are
Plex's subtitle server answering `<Error … statusCode="500"/>`, which Plex drops without a
word (7 of 12 attempts up to 2026-09-30, on Draft Day and Days of Thunder). It is upstream
and intermittent; the same request worked a minute later.

**Bazarr** fetches subtitles itself and writes them **beside the video**
(`Title (Year).es.srt`, `.en.srt`), where Plex reads them as local subtitles. The two live
together: Plex's own download keeps working, into its database.

- **Spanish and English for every title.** One language profile, the default for movies and
  series. The script owns *all* profiles: one added in the WebUI is removed by the next apply.
- **The whole library, monitored or not.** Bazarr covers what Radarr and Sonarr manage,
  which since Phase 8 is all of `movies/` and `series/`, most of it **unmonitored**. The
  script keeps *only monitored* off so those titles get subtitles too. `photos/`, `videos/`
  and `music/` are not theirs, so Bazarr never sees them.
- **Providers:** OpenSubtitles.com when `.env` has an account (free, ~20 downloads a day;
  the largest catalogue), plus four that need none: subtis (Spanish movies), yifysubtitles
  (movies), subtitulamostv (Spanish/English TV) and gestdown (TV). An embedded Spanish or
  English track counts, so nothing is downloaded for it.
- **Plex is refreshed** for the title after each download, with the `.env` Plex token
  (stored encrypted in Bazarr).
- **Only `streaming/` is mounted**, at its host path. Bazarr never touches `torrents/`, and
  an `.srt` never counts as media for `arr-reclaim`: a sidecar never keeps a torrent alive. A
  Plex delete can leave a stray `.srt` in the folder; it is harmless.
- **Login:** `ARR_USER`/`ARR_PASS`, asked from the LAN too (Bazarr has no local-address
  exemption). Its API key is its own, in `/opt/appdata/bazarr/config/config.yaml`.

**Do**

1. Optional: create a free account at **opensubtitles.com** and put it in `.env`. An
   opensubtitles**.org** account is a different site and its login is refused
   (`AuthenticationError`, provider paused 12 h):

   ```
   OPENSUBTITLES_USER=…
   OPENSUBTITLES_PASS=…
   ```

   Add `bazarr` to `UPDATE_SERVICES` in `.env`.

2. Start it. Only `bazarr` is created:

   ```bash
   task start
   ```

3. Apply the settings:

   ```bash
   task bazarr:configure
   ```

   On the first apply Radarr and Sonarr take a few seconds to connect; the read-back waits
   for them. Bazarr then searches what's missing by itself (new titles at once, the rest
   every 6 hours). *Wanted → Search All* in the WebUI starts it now.

**Verify**

- `task bazarr:check` exits 0:
  - settings, languages `es en` and the one profile as wanted
  - Radarr and Sonarr connected, the Plex token accepted
  - no title without a profile
- A Radarr title (e.g. *Days of Thunder*) gets `Days of Thunder (1990).es.srt` and `.en.srt`
  beside the video, `dario:media`, `-rw-rw-r--`. The video still has its hardlink
  (`stat -c %h` unchanged). Plex lists both as subtitle tracks.
- `task arr-reclaim:audit` is unchanged.
- Plex's own *Search subtitles* still works (retry if Plex's server answers 500).

**Rollback**

```bash
docker compose rm -sf bazarr
```

```bash
rm -rf /opt/appdata/bazarr
```

Then take `bazarr` out of `UPDATE_SERVICES`. The `.srt` files it wrote can stay; Plex keeps
using them. To remove them too, take the list from Bazarr's *History* before removing its
appdata (Radarr's imports may have brought `.srt` files of their own), and confirm before
deleting anything under `/mnt/data`.

---

## Address check — follow the box when DHCP moves it

The router assigns the box's addresses by DHCP and can't reserve one. Since 2026-10-04 they
have flipped on reboots: wired `.86` ↔ `.87`, Wi‑Fi `.66` ↔ `.67`. Static addresses
collided (`.2` is the printer; `.3` dropped in and out), so the box stays on DHCP and
[`jobs/lan-address`](../jobs/lan-address/README.md) keeps the apps in step: after boot and
every 5 minutes it re-runs the configure scripts of qBittorrent, Prowlarr, Radarr, Sonarr
and Seerr, for each one whose recorded addresses are not the box's now.

**Do**

From the main clone, after the merge. It needs sudo, so it's yours to run:

```bash
task deploy
```

**Verify**

- `task deploy:check`: `lan-address.timer armed`; `task status` shows its next run.
- `task lan-address:logs`: the first run applied all five apps and ended
  `Stack now at <addresses>`. Within 5 minutes, `/opt/appdata/.lan-address` has five lines.
- `task check`: no drift.
- **A change:** set one app's line in `/opt/appdata/.lan-address` to an old address. Within
  5 minutes (or with `task lan-address:run`), only that app is applied again.
- **A reboot:** about 2 minutes after boot, `journalctl -u lan-address -b` has a run, and
  `task check` is clean with nothing run by hand.

**Rollback**

```bash
sudo systemctl disable --now lan-address.timer
```

Then take its two lines out of `MANIFEST` and `EXECS` in `stack/deploy.sh`. After an
address change, apply the apps by hand:
`task qbittorrent:configure prowlarr:configure arr:configure seerr:configure`.
