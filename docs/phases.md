[← Index](../README.md)

# Phases

Moving from the native setup in [pms-local](https://github.com/ddessaunet/pms-local) to a containerized arr stack,
one reversible step at a time. Each phase has **Do**, **Verify** and **Rollback**. The native
setup keeps working until Phase 7, and you can stop between any two phases for as long as
you like.

Tick these as phases finish, and commit the tick. This list is how you (or the next session)
tell what has been done. If it looks stale, check the server rather than trusting it.

- [ ] Phase 0 — foundation
- [ ] Phase 1a — shadow Plex beside the native one
- [ ] Phase 1b — Plex cutover
- [ ] Phase 2 — qBittorrent, parallel instance
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
$EDITOR .env                      # check TZ and the LAN IP in PLEX_SHADOW_ADVERTISE
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

## Phase 1a — Shadow Plex

A second, throwaway Plex server on `:32420` with its own identity and the library mounted
**read-only**. It proves the image scans and plays on this box before anything native is
stopped. Native Plex is untouched.

**Do**

1. Get a claim token from <https://plex.tv/claim>. It expires in 4 minutes, so do this last,
   then put it in `.env` as `PLEX_CLAIM=`.
2. Start it:

   ```bash
   tools/preflight.sh 1a && docker compose --profile shadow up -d plex-shadow
   ```

   ```bash
   docker compose logs -f plex-shadow
   ```

3. Open `http://192.168.0.86:32420/web` and add libraries pointing at
   `/mnt/data/streaming/movies`, `/mnt/data/streaming/series` and `/mnt/data/streaming/music`.
   Plex also offers `photos/` and `videos/`. Add them if the native server has them.
4. Clear `PLEX_CLAIM` in `.env`. It is only read on first start.

**Verify**

- The scan finishes and titles match the native server.
- Direct play works, and a forced transcode (drop the quality in the player) plays smoothly.
  Watch the CPU in `docker stats plex-shadow`. Transcoding is CPU-only, the same as native.

**Don't**

- Copy the native `Preferences.xml` or database here. Two running servers with one machine
  identity confuse plex.tv and every client.
- Turn on Remote Access for the shadow server.

**Rollback**

```bash
docker compose --profile shadow down
```

```bash
sudo rm -rf /opt/appdata/plex-shadow
```

Then remove the extra server from plex.tv → Settings → Authorized Devices.

---

## Phase 1b — Plex cutover

The container takes over with a **copy** of the native database: same server identity, same
watch history, same library paths. The original stays in `/var/lib/plexmediaserver`, never
written, so rollback is a restart.

`tools/cutover-plex.sh` runs the whole phase. It checks every precondition first and changes
nothing if one fails. It stops at the first failing step, and **rolls back by itself** if
the container doesn't come up as the same server with the same library. Plan for about five
minutes of downtime. It asks for sudo once, up front.

**Before:** finish Phase 1a's checks. A 720p transcode plays smoothly, and a delete on the
test server is refused.

**Do**

1. **Rehearse.** This checks everything and changes nothing:

   ```bash
   npm run cutover:dry
   ```

   All of these must pass:
   - no one is streaming
   - the image's Plex version is the same as native, or newer
   - the library paths are present
   - no leftover `/opt/appdata/plex/Library`
   - enough space

2. **Cut over:**

   ```bash
   tools/cutover-plex.sh
   ```

   It prints each step and appends to `/opt/appdata/cutover-plex.log`. Exit `0` means the
   container is serving the same server with the same library counts. Exit `3` means a step
   failed and it rolled back: native Plex is serving again, and the reason is on the last
   `FAIL` line.

3. **Check by hand** (the list under Verify below), then clean up:
   - Remove "PMS shadow" from plex.tv → Settings → Authorized Devices, then run
     `rm -rf /opt/appdata/plex-shadow`.
   - Delete the `profiles: [cutover]` line from `compose.yaml` and commit it. From then on
     `npm start` includes Plex.

4. **Arm the container updater.** It takes the Sunday 05:00 slot that the script took from
   native Plex:

   ```bash
   npm run update:dry
   ```

   ```bash
   npm run deploy
   ```

   The deploy arms the timer because the cutover masked `plexmediaserver`. See
   [Updating](updating.md).

<details>
<summary>What the script does, step by step</summary>

1. Records the server identity, per-section item counts and `autoEmptyTrash` in
   `/opt/appdata/.cutover-plex.state`.
2. Sets **`autoEmptyTrash=0`** on native Plex *before* stopping it, so the copied settings
   carry it. If the container ever started without its library mount, titles would show as
   unavailable instead of being deleted along with their watch state. It's restored once
   the counts match.
3. `systemctl disable --now plex-update.timer`, then `stop` and **`mask`**
   `plexmediaserver`. It waits until no `plex` process is left, so the database is closed.
   pms-local's deploy and updater both stand down while Plex is masked (pms-local#14).
4. Removes the `plex-shadow` container. Its config is left for you.
5. `rsync -a` of `/var/lib/plexmediaserver/Library/Application Support/Plex Media Server`
   into `/opt/appdata/plex/Library/Application Support/`, then `chown -R 1000:1001` on the
   **copy only**.
6. `docker compose --profile cutover up -d plex`.
7. Waits up to 180 s for `/identity` to report the recorded server, and for every section's
   item count to match. It also checks that the container can see every library path.

</details>

**Verify** (what the script can't check)

- Clients reconnect to "Local PMS" without being re-added, and watch state and "On Deck"
  are intact.
- Settings → Library → *Allow media deletion* is still on, and *Empty trash automatically*
  is back on.
- **pms-local still works end to end.** Let a native qBittorrent download finish:
  `/var/log/plex-move.log` should show the library refresh succeed. It still reaches Plex at
  `localhost:32400` because of host networking. Then delete a throwaway title in Plex and
  confirm `plex-watch` reacts:

  ```bash
  journalctl -u plex-watch -f
  ```

**Rollback**

```bash
tools/cutover-plex.sh --rollback
```

This stops the container, then unmasks and starts native Plex, and waits until it's serving
the recorded identity. It also:
- restores `autoEmptyTrash`
- re-arms `plex-update.timer` and disarms `pms-update.timer`
- moves the container's copy aside to `/opt/appdata/plex.rolled-back-<time>`, so a retry
  starts clean

Anything watched while the container was running is lost, because the native database
never saw it.

---

## Phase 2 — qBittorrent, parallel instance

A **second** qBittorrent in a container, used only by Radarr and Sonarr. Native
`qbittorrent-nox` keeps `:8080`, its 15 torrents and its completion hook until Phase 7, so
there is never a window without a working import path.

**Do** — add the service to `compose.yaml`:

- `lscr.io/linuxserver/qbittorrent`, network `arr`, `WEBUI_PORT=8081`, ports `8081`,
  `13762/tcp` and `13762/udp`. Native owns peer port `13761`.
- Volumes: `${APPDATA}/qbittorrent:/config` and `/mnt/data:/mnt/data` (rule 2).

Then in its WebUI:

| setting | value |
|---|---|
| Downloads → Default Save Path | `/mnt/data/torrents` |
| Downloads → Keep incomplete in | `/mnt/data/torrents/.incomplete-arr` |
| Categories | `radarr` → `/mnt/data/torrents/radarr`, `sonarr` → `/mnt/data/torrents/sonarr` |
| Downloads → Run external program | **empty** — the arrs import, not the hook |
| Web UI → Server domains | add `qbittorrent`, or Radarr and Sonarr are refused with no useful error |
| BitTorrent → Seeding limits | a ratio and/or time limit |
| Connection → port | `13762` |

The seeding limits matter because `plex-reconcile` only knows about the native instance. It
iterates the native API's torrents, so it ignores this instance's folders under `torrents/`,
and nothing else will ever remove these torrents.

**Verify:** add a small legal torrent under category `radarr`. It lands in
`/mnt/data/torrents/radarr/` owned by `dario:media`, and native qBittorrent is unaffected.

**Rollback:** remove the service, then `sudo rm -rf /opt/appdata/qbittorrent` and the test
download.

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
