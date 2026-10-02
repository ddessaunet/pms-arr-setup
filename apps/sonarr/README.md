# sonarr

Sonarr manages the series (Phase 4): the whole library under `/mnt/data/streaming/series`, though most of it is
unmonitored.

## Role

It grabs through [Prowlarr](../prowlarr/README.md)'s indexers into
[qBittorrent](../qbittorrent/README.md)'s `sonarr` category, imports by hardlink into the library
as `Show/Season NN/Show - SNNEMM.ext`, and tells [Plex](../plex/README.md) to refresh. Unmonitored titles are never
searched or upgraded; monitor one by hand to get it improved.

## Access

- WebUI and API on `:8989`; `sonarr:8989` on the `arr` network.
- It reaches Plex through the host gateway (`host.docker.internal`).

## Secrets

- `SONARR_API_KEY` (`.env`): fixed before the first start, passed as `SONARR__AUTH__APIKEY`. Prowlarr
  pushes indexers with it, and [`arr-reclaim`](../../jobs/arr-reclaim/README.md) reads the
  import history with it.
- `ARR_USER` / `ARR_PASS`: one WebUI login for Radarr and Sonarr.
- `PLEX_TOKEN`: for its Plex connection. `QBT_ARR_USER` / `QBT_ARR_PASS`: for its download client.

## Settings

There are three owners, applied in this order:

1. **[Recyclarr](../recyclarr/README.md)**: the quality profiles and custom formats. `WEB-1080p` by default.
2. **[`configure.sh`](configure.sh)**, which shares
   [`stack/lib/arr-configure.sh`](../../stack/lib/arr-configure.sh) with Radarr: login,
   naming, media management, root folder, sizes (1080p with no maximum), the qBittorrent client and the Plex
   connection.
3. **[Seerr](../seerr/README.md)**: which profile a request gets.

- No upgrades.

It never imports or renames existing media; renaming applies to new imports.

## Tasks

| task | does |
|---|---|
| `task sonarr:configure` | Apply its settings, then test its qBittorrent and Plex connections. |
| `task sonarr:check` | Report drift. Changes nothing. |
| `task arr:configure` / `arr:check` | The same for Radarr and Sonarr together. |
| `task sonarr:logs` / `ps` / `up` / `update` / `update:dry` | The standard app tasks. |

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
