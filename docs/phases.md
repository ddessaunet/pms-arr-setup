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
- [ ] Phase 6 — Recyclarr: 4K HDR as the default for movies
- [x] Phase 7a — retire native qBittorrent and `plex-watch` (2026-09-29: 9 native torrents dropped, all 10 library files kept at 1 link; both services disabled)
- [ ] Phase 7b — remove native Plex and pms-local's leftovers (~2 stable weeks after 7a)
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
5. **`plex-watch` was live until Phase 7a.** It treated *any* `delete` or `moved_from` under
   `/mnt/data/streaming` as "deleted in Plex" and removed the matching native torrent **and
   its data**, so until then the arrs only *added* files. It's retired now, and moves are
   safe. Still, **"Library Import", "Rename Files" or "Organize" on existing media happen
   only as Phase 8 plans them.** pms-local is not modified by this migration; what the stack
   needs from it is ported here (`arr-reclaim`).
6. **Upgrades only in the 4K movie profile (`UHD Bluray + WEB`), and every size is capped**
   (1080p 40, 2160p 150 MB/min; `arr-configure.sh`). Everything else is single-grab.
7. **Media is deleted in Plex, and that frees the space.** For Radarr/Sonarr imports,
   this repo's `arr-reclaim` removes the torrent. For the rest of the library, including
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
`/var/lib/plexmediaserver`, until Phase 7b. That's the rollback.

**Still to do once:**
- Arm the container updater with `npm run update:dry`, then `npm run deploy`. It's armed
  only while native Plex is masked. See [Updating](updating.md).
- Remove "PMS shadow" from plex.tv → Authorized Devices, then run
  `rm -rf /opt/appdata/plex-shadow`.

**Rollback** (until Phase 7b)

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
| quality | **1080p** (`HD-1080p`, **no Remux**), sizes **capped at 40 MB/min** (about 4.8 GB for a 2-hour film, 1.8 GB for a 45-minute episode; 25 preferred), **no upgrades** on any profile until Phase 6 |
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

## Phase 5 — Seerr (requests)

The request UI in front of Radarr and Sonarr. It's **Seerr**, the merged successor of
Jellyseerr and Overseerr (Overseerr is archived, and the old Jellyseerr image isn't updated
any more).

It only files requests and has **no media mounts**. A request becomes an ordinary
Radarr/Sonarr add, so everything from Phase 4 applies to it: 1080p, hardlinked imports, no
upgrades, unmonitor on delete, and `arr-reclaim` freeing the space of a Plex delete.

- **Only you sign in**, and your requests are approved automatically.
- **The existing library shows as Available.** Seerr scans Plex, so titles already there
  can't be requested again, even though Radarr/Sonarr don't know about them until Phase 8.

**Do**

1. Start it. Only `seerr` is created:

   ```bash
   npm start
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
   npm run seerr:configure
   ```

   Its key is Seerr's own, read from `/opt/appdata/seerr/settings.json`; nothing goes in
   `.env`. Run before the sign-in, it stops and tells you to sign in.

**Verify**

- `npm run seerr:check` exits 0:
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
| qualities | Bluray-2160p, WEB-DL/WEBRip-2160p; **no Remux, no 1080p** | WEB-DL/WEBRip-1080p |
| HDR | **HDR +500, HDR10+ +100.** SDR, DV without an HDR10 fallback (purple/green on non-DV screens), x265 without HDR, and generated HDR are all **−10000**, so they're rejected | — |
| size cap | **150 MB/min** (~18 GB for 2 hours: most 4K HDR WEB-DLs, not 30–60 GB Bluray encodes) | 40 MB/min (~1.8 GB for 45 minutes) |
| upgrades | **on**, to a better-scored 4K release | off |

**Who owns what,** so no two tools fight:
- **Recyclarr** (`recyclarr/recyclarr.yml`): those two profiles and their custom formats.
- **`arr-configure.sh`:** sizes (Recyclarr's `quality_definition` is deliberately left out),
  and upgrades off on every other profile.
- **`seerr-configure.sh`:** requests default to those two profiles.

**Upgrades are safe with both watchers.**
- An upgrade replaces the library file at the same path. `plex-watch` ignores it, because
  it isn't a native torrent.
- `arr-reclaim` sees the path re-imported by a newer download, and removes the **old**
  torrent once nothing links to its data (`upgraded`).

**Playback:** transcoding is CPU-only, so 4K HDR has to **direct-play** (a 4K HDR TV app,
Shield or Apple TV). **Films with no 4K release:** request them with `HD-1080p` from Seerr's
request options; that profile stays as it was, without upgrades.

**Do**

1. **Preview.** This changes nothing:

   ```bash
   npm run recyclarr:preview
   ```

   It should list both profiles and their custom formats, and **no quality definitions**.
   Recyclarr draws the report as a table, so run it in a real terminal; piped, it shows
   only the log lines.

2. **Apply,** in this order. Each step needs the one before it:

   ```bash
   npm run recyclarr:sync
   ```

   ```bash
   npm run arr:configure
   ```

   ```bash
   npm run seerr:configure
   ```

   `recyclarr:sync` creates the profiles. `arr:configure` then applies the 2160p caps and
   the upgrade allow-list. `seerr:configure` points requests at the new defaults.

**Verify**

- `npm run arr:check`:
  - Radarr: 2160p capped at 150/100, 1080p at 40/25; upgrades only on `UHD Bluray + WEB`;
    the default profile exists with no Remux.
  - Sonarr: `WEB-1080p`, no upgrades.
- `npm run seerr:check`: default profiles `UHD Bluray + WEB` and `WEB-1080p`.
- Existing movies keep their profile. Iron Man 2 and Dune stay on `HD-1080p`.
- **End to end:** request a film with 4K HDR releases, after a size check as before.
  - Radarr grabs a **2160p HDR** release within 150 MB/min × runtime.
  - Its custom formats show **HDR**, and not SDR or DV (w/o HDR fallback).
  - Hardlinked import, then Available in Seerr.
- **When an upgrade happens:** `journalctl -u arr-reclaim` shows the old torrent
  `Removed … an upgrade replaced it`, and `plex-watch` changes nothing.

**Rollback**

- Delete the `UHD Bluray + WEB` and `WEB-1080p` profiles in Radarr and Sonarr. Recyclarr
  only ever wrote profiles and custom formats.
- Set `default_profile` in `arr-configure.sh` and `profile_name` in `seerr-configure.sh`
  back to `HD-1080p`, then re-run `npm run arr:configure` and `npm run seerr:configure`.

---

## Phase 7a — Retire native qBittorrent and `plex-watch`

Start only after Phase 6 is ticked: its upgrade check needs `plex-watch` still running.

After this, `arr-reclaim` is the only watcher and the `:8081` container the only
qBittorrent. Nothing reads a move in the library as a deletion any more, and that is what
unlocks Phase 8.

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

- `npm run check`, `npm run arr:check` and `npm run qbt:check` are clean, and
  `npm run reclaim:audit` has nothing to do.
- A Seerr request goes all the way through: Radarr → `:8081` → hardlink import → Plex.

**Rollback**

```bash
sudo systemctl enable --now qbittorrent-nox plex-watch
```

The client comes back empty, and the hook imports new downloads as before. The dropped
torrents don't come back, but their files never left the library.

---

## Phase 7b — Remove native Plex and pms-local's leftovers

After about 2 stable weeks on 7a. Everything here is sudo, and none of it is needed for
Phase 8.

1. **Archive native Plex, then remove it.** Keep the mask: it guards against a reinstall
   fighting the container for `:32400`. `npm run deploy` counts a missing unit as masked
   too, so the container updater stays armed either way.

   ```bash
   sudo tar -C /var/lib -czf /root/plexmediaserver-native.tgz plexmediaserver
   ```

   ```bash
   sudo apt remove plexmediaserver
   ```

2. **Remove what pms-local installed.** It has no uninstall, so this is the list:
   - `/opt/scripts/`
   - `/etc/plex-move.conf`
   - `/etc/sudoers.d/qbittorrent-plex`
   - `/etc/logrotate.d/plex-move`
   - `/etc/tmpfiles.d/plex-move.conf`
   - `/var/log/plex-move.log*`
   - `/var/cache/plex-update`
   - `/etc/systemd/system/plex-watch.service`
   - `/etc/systemd/system/plex-update.{service,timer}`

   Then run `sudo systemctl daemon-reload`.

3. **Remove native qBittorrent:** the `qbittorrent-nox` package, its hand-made unit
   `/etc/systemd/system/qbittorrent-nox.service`, and the user, group and `/home/qbittorrent-nox`. **Look in its `Downloads/`
   first**; it predates pms-local. Once the group is gone, pms-local's `deploy.sh` stops
   before installing anything, which is a second guard.

4. **Keep Ollama.**

**Verify:** `npm run check` still shows `pms-update.timer` armed, and Plex still answers
as `f3860770…`.

**Rollback:** `/root/plexmediaserver-native.tgz` holds the native database. Everything
else is gone for good, which is why 7b waits for two quiet weeks.

---

## Phase 8 — Library cleanup

After Phase 7a retires `plex-watch`, nothing reads a move as a deletion any more. Then Radarr
and Sonarr can take over the existing library:
- **Library Import** the 107 loose movie files and the 27 folders.
- Sort out the misfiled series folders.
- Run **Rename** so everything follows the Phase 4 naming.

Plan this phase on its own when you get there. It's the one step that moves most of the
library.
