# radarr

Radarr manages the movies (Phase 4): the whole library under `/mnt/data/streaming/movies`, though most of it is
unmonitored.

## Role

It grabs through [Prowlarr](../prowlarr/README.md)'s indexers into
[qBittorrent](../qbittorrent/README.md)'s `radarr` category, imports by hardlink into the library
as `Title (Year)/Title (Year).ext`, and tells [Plex](../plex/README.md) to refresh. Unmonitored titles are never
searched or upgraded; monitor one by hand to get it improved.

## Access

- WebUI and API on `:7878`; `radarr:7878` on the `arr` network.
- It reaches Plex through the host gateway (`host.docker.internal`).

## Secrets

- `RADARR_API_KEY` (`.env`): fixed before the first start, passed as `RADARR__AUTH__APIKEY`. Prowlarr
  pushes indexers with it, and [`arr-reclaim`](../../jobs/arr-reclaim/README.md) reads the
  import history with it.
- `ARR_USER` / `ARR_PASS`: one WebUI login for Radarr and Sonarr.
- `PLEX_TOKEN`: for its Plex connection. `QBT_ARR_USER` / `QBT_ARR_PASS`: for its download client.

## Settings

There are three owners, applied in this order:

1. **[Recyclarr](../recyclarr/README.md)**: the quality profiles and custom formats. `UHD Bluray + WEB` (4K HDR) by default; the opt-in `4K HDR or 1080p` and the hand-picked `UHD Fallback` are picked per request.
2. **[`configure.sh`](configure.sh)**, which shares
   [`stack/lib/arr-configure.sh`](../../stack/lib/arr-configure.sh) with Sonarr: login,
   naming, media management, root folder, sizes (1080p at most 40 MB/min, 2160p at most 150 MB/min), the qBittorrent client and the Plex
   connection.
3. **[Seerr](../seerr/README.md)**: which profile a request gets.

- Upgrades, and no Remux, **only** on the two 4K movie profiles (`UHD Fallback` never upgrades).
- [`arr-fallback-search`](../../jobs/arr-fallback-search/README.md) re-searches the `4K HDR or 1080p` movies daily: Radarr searches a movie in full only when it is added, and after that only through RSS.

It never imports or renames existing media; renaming applies to new imports.

## Tasks

| task | does |
|---|---|
| `task radarr:configure` | Apply its settings, then test its qBittorrent and Plex connections. |
| `task radarr:check` | Report drift. Changes nothing. |
| `task arr:configure` / `arr:check` | The same for Radarr and Sonarr together. |
| `task radarr:logs` / `ps` / `up` / `update` / `update:dry` | The standard app tasks. |

## Traps

- **`/mnt/data` is ONE bind mount**, at its host path. Separate mounts for `torrents/` and
  `streaming/` make `link()` fail with `EXDEV`, and imports turn into copies on a nearly
  full volume.
- **Deleting a title here wipes its history.** `arr-reclaim` keeps its own record of
  imports for that reason.
- **Recyclarr's `quality_definition` must stay out.** `configure.sh` owns the sizes.
- **It reports quality sizes a few seconds late after a write.** The read-back re-reads for up
  to about 10 s before it calls the difference drift.
- `photos/`, `videos/` and `music/` belong to Plex only, not to the arrs.
