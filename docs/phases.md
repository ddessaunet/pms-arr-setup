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
- [ ] Phase 4 — Radarr + Sonarr
- [ ] Phase 5 — Jellyseerr
- [ ] Phase 6 — Recyclarr
- [ ] Phase 7 — retire the native setup
- [ ] Phase 8 — library cleanup (import and rename the existing library)

Run `tools/preflight.sh` before each of Phases 0–1b. It is read-only.

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
5. **`plex-watch` is live until Phase 7.** It treats *any* `delete` or `moved_from` under
   `/mnt/data/streaming` as "deleted in Plex" and removes the matching native torrent **and
   its data**. Anything that renames, upgrades or recycles library files — Radarr, Sonarr,
   Recyclarr's upgrades — fires it. Until Phase 7 the arrs only *add* files: **never "Library
   Import", "Rename Files" or "Organize" on existing media before Phase 8.** pms-local is not
   modified by this migration; what the stack needs from it is ported here (`arr-reclaim`).
6. **Nothing upgrades until Phase 6, and only size-capped profiles.** ~20 GB free (98%) is
   one Remux movie.
7. **Media is deleted in Plex, and that frees the space.** For native imports that's
   pms-local's `plex-watch`. For Radarr/Sonarr imports it's this repo's `arr-reclaim`
   service. Both watch the same library, and each only touches its own qBittorrent.

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
tools/preflight.sh 0
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

Native `plexmediaserver` stays installed and masked, with its database untouched in
`/var/lib/plexmediaserver`, until Phase 7. That's the rollback.

**Still to do once:**
- Arm the container updater with `npm run update:dry`, then `npm run deploy`. It's armed
  only while native Plex is masked. See [Updating](updating.md).
- Remove "PMS shadow" from plex.tv → Authorized Devices, then run
  `rm -rf /opt/appdata/plex-shadow`.

**Rollback** (until Phase 7)

```bash
docker compose stop plex
```

```bash
sudo systemctl unmask plexmediaserver && sudo systemctl start plexmediaserver
```

Then swap the updaters. Both deploys read the mask, so re-running each one puts its own timer
right:

```bash
npm run deploy
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

2. Start it. `npm start` runs the preflight first, which checks `:8081`, `:13762/tcp` and
   `:13762/udp` are free.

   ```bash
   npm start
   ```

   > This also recreates `plex` once (about 20 s), picking up the `PLEX_CLAIM` and `UMASK`
   > config changes. The config is unchanged, so it's the same server. Do it when nobody is
   > watching.

3. Apply the settings. The first run logs in with the temporary password the container
   prints and sets your `.env` login. It then applies the paths, categories, peer port and
   host-header domains, and reads everything back:

   ```bash
   npm run qbt:configure
   ```

   The settings themselves are data at the top of
   [`tools/qbt-configure.sh`](../tools/qbt-configure.sh). `npm run qbt:check` reports drift
   and changes nothing.

**Verify**

- `npm run qbt:check` exits 0, and running `qbt:configure` again changes nothing.
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
- `npm run update:dry` covers it (`UPDATE_SERVICES=plex qbittorrent`).

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
  [`tools/prowlarr-configure.sh`](../tools/prowlarr-configure.sh).

**Do**

1. Check `.env`. `PROWLARR_API_KEY` must be 32 hex characters (`openssl rand -hex 16`). Also
   choose `PROWLARR_USER` and `PROWLARR_PASS`:

   ```bash
   $EDITOR .env
   ```

2. Start it. Only `prowlarr` and `flaresolverr` are created; `plex` and `qbittorrent` stay
   running as they are.

   ```bash
   npm start
   ```

3. Apply the login, the FlareSolverr proxy and the indexers. It reads everything back and
   **tests every indexer**. This takes a couple of minutes: each FlareSolverr test is about
   15–20 s.

   ```bash
   npm run prowlarr:configure
   ```

   An indexer that fails its test is reported as `FAILING` but doesn't fail the run, because
   public trackers come and go. If the failure message says *blocked by CloudFlare
   Protection*, switch that entry to `flare` in the script and run it again.

**Verify**

- `npm run prowlarr:check` exits 0, and running `prowlarr:configure` again changes nothing.
- A search returns results through a FlareSolverr indexer and a direct one: search a known
  title in the WebUI (Search), or:

  ```bash
  curl -s -H "X-Api-Key: $(sed -n 's/^PROWLARR_API_KEY=//p' .env)" "http://127.0.0.1:9696/api/v1/search?query=draft%20day&type=search" | jq 'group_by(.indexer) | map({(.[0].indexer): length}) | add'
  ```

- Nothing else touched: `plex` and `qbittorrent` weren't recreated, and `plex-watch` is quiet.
- `npm run update:dry` covers both (`UPDATE_SERVICES=… prowlarr flaresolverr`).

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

**The existing library stays exactly as it is.** 107 of its 134 movies are loose files at
the `movies/` root, the 27 folders hold release-named files, and several series folders are
misfiled. Organising any of that means moves, which `plex-watch` would read as deletions
(rule 5). So nothing existing is imported or renamed now; that's **Phase 8**, after Phase 7
retires `plex-watch`.

| | |
|---|---|
| Radarr | `:7878`, root `/mnt/data/streaming/movies`, new imports `Title (Year)/Title (Year).ext` |
| Sonarr | `:8989`, root `/mnt/data/streaming/series`, `Show/Season 01/Show - S01E01.ext` |
| quality | **1080p** (`HD-1080p`), **no upgrades** on any profile until Phase 6 |
| downloads | the `:8081` qBittorrent, categories `radarr` / `sonarr`, **hardlinked** into the library |
| seeding | ratio 2.0 or 14 days, then the torrent **stops**, and *Remove Completed* removes it (the library keeps its hardlink) |
| deleted in Plex | **unmonitored**, never re-downloaded, and **`arr-reclaim`** removes its torrent **with its data** within about a minute |
| indexers | pushed by Prowlarr (full sync); not configured here |
| Plex | refreshed on import and delete, through `host.docker.internal:32400` |

**How `arr-reclaim` decides.** `tools/arr-reclaim.sh`, run by `arr-reclaim.service`, ports
pms-local's `plex-watch` + reconcile to the `:8081` instance. It watches the library with
inotify and waits 60 s of quiet after a burst of deletions. It then removes a torrent **only
when all three are true**:
- Radarr or Sonarr **imported** it: its hash is in their import history.
- **Every** file imported from it is gone from the library.
- **No other link** to its data remains.

So a finished download that isn't imported yet, one episode deleted out of a season pack, or
a file that was only moved are all kept. There are at most 3 removals per run.

**Do**

1. Choose `ARR_USER` / `ARR_PASS` in `.env`. The API keys and `PLEX_TOKEN` are already
   there. Then run the preflight:

   ```bash
   tools/preflight.sh
   ```

2. Start them. Only `radarr` and `sonarr` are created.

   ```bash
   npm start
   ```

3. Configure. These are idempotent, and each ends with a read-back:

   ```bash
   npm run qbt:configure
   ```

   ```bash
   npm run arr:configure
   ```

   ```bash
   npm run prowlarr:configure
   ```

   - `qbt:configure` sets the seeding limits.
   - `arr:configure` restarts each app once to activate its allowed hosts.
   - `prowlarr:configure` adds Radarr and Sonarr as applications and pushes the indexers.

4. Install and start the `arr-reclaim` watcher (with the updater units):

   ```bash
   npm run deploy
   ```

**Verify**

- `npm run arr:check` and `npm run prowlarr:check` show no drift. The download client and
  Plex tests pass, and both apps list their synced indexers.
- `npm run check` shows `arr-reclaim.service` enabled and running, and
  `npm run reclaim:audit` has nothing to do.
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

## Phase 5 — Jellyseerr

This phase has no risk. It only files requests with Radarr and Sonarr.

**Do:** Jellyseerr and Overseerr were being merged into **Seerr**. Check which image is
current before pinning one. Put it on network `arr`, port `5055`, with
`extra_hosts: host-gateway`.

- Plex: `host.docker.internal:32400`.
- Radarr: `http://radarr:7878`. Sonarr: `http://sonarr:8989`.

**Verify:** a request from its UI shows up in Radarr and downloads.

**Rollback:** remove the service and its appdata.

---

## Phase 6 — Recyclarr

This phase is what turns quality upgrades on. **Do the `plex-watch` decision in Phase 7
first**, because every upgrade deletes a library file.

**Do:** add `ghcr.io/recyclarr/recyclarr` with its config in `${APPDATA}/recyclarr` and the
Radarr and Sonarr API keys in `.env`. Choose TRaSH **1080p, size-capped** profiles (HD
Bluray + WEB, WEB-1080p). No Remux, no 4K.

```bash
docker compose run --rm recyclarr sync --preview
```

**Verify:** the preview output only touches what you expect. Then run a real sync, and
check that profiles and custom formats appear in both apps.

**Rollback:** Recyclarr only writes profiles and custom formats. Remove it and switch titles
back to the profile you used before.

---

## Phase 7 — Retire the native setup

**Do**

1. **Retire `plex-watch`** (`sudo systemctl disable --now plex-watch`). Once the native
   torrents are gone (step 2), it has nothing left to reconcile, and `arr-reclaim` already
   covers the `:8081` instance. pms-local itself isn't changed; its service is just
   switched off. With `plex-watch` gone, moves under `streaming/` are safe, and that is
   what unlocks Phase 8.
2. **Move the native torrents into the container.** Stop both instances. Copy the
   `.torrent` and `.fastresume` files from
   `/home/qbittorrent-nox/.local/share/qBittorrent/BT_backup/` into
   `/opt/appdata/qbittorrent/qBittorrent/BT_backup/` (the files are named by infohash, so
   nothing collides) and chown the copies to `1000:1001`. The save paths already match
   (rule 1). Alternatively, let them finish seeding natively.

   Moved torrents aren't in Radarr's or Sonarr's import history, so **`arr-reclaim` never
   removes them**. Deleting one of those titles in Plex would free nothing, which is the
   case `plex-watch` handles today. Letting them finish seeding natively avoids that
   entirely. Decide this when planning Phase 7.
3. `sudo systemctl disable --now qbittorrent-nox`. Move the container to WebUI `:8080` and
   peer port `13761`, then update the port in Radarr, Sonarr and your router.
4. Retire what only the hook needed: `/opt/scripts`, the Ollama classifier, and the
   `plex-update` units.
5. After ~2 stable weeks, archive and remove native Plex:

   ```bash
   sudo tar -C /var/lib -czf /root/plexmediaserver-native.tgz plexmediaserver
   ```

   ```bash
   sudo apt remove plexmediaserver
   ```

**Verify:** every torrent from the native instance shows in the container, seeding, with no
errors. A new request goes all the way through: Jellyseerr → Radarr → qBittorrent → a
hardlink import → Plex.

**Rollback:** until step 5, start `qbittorrent-nox` and `plex-watch` again. The native
`BT_backup` was copied, not moved.

---

## Phase 8 — Library cleanup

After Phase 7 retires `plex-watch`, nothing reads a move as a deletion any more. Then Radarr
and Sonarr can take over the existing library:
- **Library Import** the 107 loose movie files and the 27 folders.
- Sort out the misfiled series folders.
- Run **Rename** so everything follows the Phase 4 naming.

Plan this phase on its own when you get there. It's the one step that moves most of the
library.
