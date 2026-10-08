# qbittorrent

The download client for Radarr and Sonarr (Phase 2). It is the only qBittorrent on the box,
and it seeds real data.

## Role

Radarr and Sonarr grab into their own categories (`radarr`, `sonarr`) and import over its
API; it has no import hook. Torrents added by hand go in its `manual` category: no app looks
there, so they are never imported, replaced or removed, only stopped at the share limits.

## Access

- WebUI on `:8081`; peer port `13762` (TCP and UDP). Both are kept from before the
  migration.
- Other containers reach it as `qbittorrent:8081` on the `arr` network.

## Secrets

- `QBT_ARR_USER` / `QBT_ARR_PASS` (`.env`): its WebUI login. The first `configure` sets it,
  using the temporary password the container prints on its first start.

## Settings

Owned by [`configure.sh`](configure.sh): save paths, categories, the peer port, the download
limit (64 MiB/s, just under the 600 Mbit/s line), slow-torrent accounting, host-header
domains and the file types it never downloads (`*.exe`, `*.scr`, `*.bat`, `*.cmd`, `*.com`,
`*.pif`, `*.lnk`, `*.msi`, `*.vbs`). Change them there, not in the WebUI, or `check` reports
drift.

## Tasks

| task | does |
|---|---|
| `task qbittorrent:configure` (`qbt:configure`) | Apply its settings and read them back. |
| `task qbittorrent:check` (`qbt:check`) | Report drift. Changes nothing. |
| `task qbittorrent:logs` / `ps` / `up` / `update` / `update:dry` | The standard app tasks. |

## Traps

- **`/mnt/data` is ONE bind mount**, at its host path. Radarr and Sonarr hardlink from
  `torrents/` into `streaming/`, and `link()` fails with `EXDEV` across two bind mounts even
  on the same filesystem. The `.fastresume` files store absolute paths.
- **Decluttarr's `remove_slow` reads the download limit:** it pauses while qBittorrent runs
  above 80% of it, and a limit of 0 means it never pauses.
- **A fake that is only an executable finishes empty.** The `.exe` is skipped, so the
  torrent shows as complete with 0 bytes, and Sonarr/Radarr report "No files found are
  eligible for import in …/X.exe". Decluttarr's `remove_failed_imports` removes and
  blocklists it, and the app searches again. Its patterns follow the excluded names one for
  one, so add a type in both places (`apps/decluttarr/config.test.sh` checks it).
- Native `qbittorrent-nox` (`:8080`/13761) is disabled since Phase 7a, not masked: its unit
  file is in `/etc/systemd/system`.
