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
- [ ] Phase 3 — Prowlarr + FlareSolverr
- [ ] Phase 4 — Radarr + Sonarr
- [ ] Phase 5 — Jellyseerr
- [ ] Phase 6 — Recyclarr
- [ ] Phase 7 — retire the native setup

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
   Recyclarr's upgrades — fires it. Until Phase 7 the arrs only *add* files.
6. **Nothing upgrades until Phase 6, and only size-capped profiles.** ~20 GB free (98%) is
   one Remux movie.

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
- **No seeding limits yet.** Phase 4 decides how finished torrents are removed. Until then,
  space held by this instance comes back only by hand.

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

These touch no media paths, so this phase has no risk.

**Do:** add `lscr.io/linuxserver/prowlarr` (`9696`) and
`ghcr.io/flaresolverr/flaresolverr` (`8191`), both on network `arr`. In Prowlarr:

- Settings → Indexers → add a FlareSolverr proxy at `http://flaresolverr:8191` with a tag
  such as `flare`.
- Add indexers, and give the `flare` tag only to the ones behind Cloudflare.

**Verify:** each indexer's Test passes, and a manual search returns results.

**Rollback:** remove both services and their appdata.

---

## Phase 4 — Radarr + Sonarr

This is the highest-risk phase. It is the first time something other than pms-local writes
into the library.

**Do:** add `lscr.io/linuxserver/radarr` (`7878`) and `lscr.io/linuxserver/sonarr`
(`8989`) on network `arr`:

- Volumes: `${APPDATA}/<app>:/config` and `/mnt/data:/mnt/data` (rule 2).
- `extra_hosts: ["host.docker.internal:host-gateway"]` so they can reach host-networked
  Plex.

Configure, in this order:

1. **Media Management**
   - Use hardlinks instead of copy: **on**.
   - Recycling bin: **empty**. A recycle is a move, and a move fires `plex-watch`.
   - Minimum free space: `20000` MB.
2. **Naming, to match what pms-local produces**, so existing files are recognised as-is:
   - Radarr folder and file: `{Movie Title} ({Release Year})`
   - Sonarr: series folder `{Series Title}`, season folder `Season {season:00}`, episode
     file `{Series Title} - S{season:00}E{episode:00}`
3. **Root folders:** `/mnt/data/streaming/movies` and `/mnt/data/streaming/series`.
4. **Download client:** qBittorrent at host `qbittorrent`, port `8081`, category `radarr` or
   `sonarr`.
5. **Prowlarr:** Settings → Apps → add both with full sync.
6. **Connect → Plex:** host `host.docker.internal`, port `32400`, update library on import.
7. **Library Import:** add existing titles **unmonitored**. Monitoring queues an upgrade
   search for the whole library.

**Don't:** run *Rename Files* or *Organize* on existing titles, or turn on upgrades. Rule 5
explains why.

**Verify:** request one new movie. Once it imports, both names should share an inode:

```bash
stat -c '%h %i %n' /mnt/data/torrents/radarr/<release>/<file> "/mnt/data/streaming/movies/<Title (Year)>/<Title (Year)>.mkv"
```

The link count should be `2` and the inode the same on both lines. Plex should pick it up
without a manual scan.

**Rollback:** remove both services and their appdata. They only ever added files.

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

1. **Decide on `plex-watch`.** Either:
   - **Retire it** (`sudo systemctl disable --now plex-watch`). Space comes back when the
     container qBittorrent's seeding limits remove the torrent, which is safe because the
     library holds its own hardlink.
   - **Or repoint it**: set `QBT_URL` in `/etc/plex-move.conf` to `http://127.0.0.1:8081`.
     It then reconciles against the container. Test with `plex-reconcile.sh --audit` first.
2. **Move the native torrents into the container.** Stop both instances. Copy the
   `.torrent` and `.fastresume` files from
   `/home/qbittorrent-nox/.local/share/qBittorrent/BT_backup/` into
   `/opt/appdata/qbittorrent/qBittorrent/BT_backup/` (the files are named by infohash, so
   nothing collides) and chown the copies to `1000:1001`. The save paths already match
   (rule 1). Alternatively, let them finish seeding natively.
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
