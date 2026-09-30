# pms-arr-setup

The containerized media stack for this box: Plex, qBittorrent, Prowlarr + FlareSolverr,
Radarr + Sonarr, Seerr, Recyclarr and Decluttarr, all in Docker Compose. It replaces the native
setup in [pms-local](https://github.com/ddessaunet/pms-local), one reversible phase at a
time, without breaking that setup until the last phase.

```
/mnt/data/                        ← one ext4 volume: hardlinks work across the whole tree
├── torrents/                     ← qBittorrent save paths
│   ├── radarr/  sonarr/          ← container qBittorrent, one category per app
│   └── .incomplete*/
└── streaming/                    ← the library; Radarr/Sonarr hardlink into it
    ├── movies/                   ← Title (Year)/Title (Year).mkv
    ├── series/                   ← Show/Season NN/Show - SNNEMM.mkv
    └── music/

/opt/appdata/<app>/               ← container config and state, on / (not /mnt/data)
```

Every container sees data at its **host path** (`/mnt/data/...`). That is what lets the
native Plex database and qBittorrent state move across unchanged.

## Documentation

| document | covers |
|---|---|
| [Phases](docs/phases.md) | The runbook and progress checklist. Each phase has Do / Verify / Rollback. |
| [Updating](docs/updating.md) | The weekly container updater: streaming check, health wait, rollback, exit codes, adding a service. |

## Files

| file | role |
|---|---|
| `package.json` | Task runner only: no dependencies, nothing installed. See [Running it](#running-it). |
| `compose.yaml` | The stack. Services are gated behind profiles until their phase is done. |
| `.env.example` | Copy to `.env` (gitignored): UID/GID, timezone, appdata path, Plex claim. |
| `tools/preflight.sh` | Read-only checks before a phase: docker, `.env`, same-filesystem hardlinks, ports, native service state. |
| `tools/start.sh` | Preflight, then `docker compose up -d` for whatever the current phase has enabled. Never passes `--profile`. |
| `tools/qbt-configure.sh` | Applies the `:8081` qBittorrent's settings through its API (paths, categories, peer port, download limit, host-header domains) and reads them back. Idempotent; `--check` reports drift. |
| `tools/prowlarr-configure.sh` | Applies Prowlarr's login, FlareSolverr proxy, indexer list and minimum seeders through its API, pushes the indexers to Radarr/Sonarr, then tests every indexer. Idempotent; `--check` reports drift. |
| `tools/arr-configure.sh` | Applies Radarr's and Sonarr's login, naming, media management, root folder, no-upgrade profiles, qBittorrent client and Plex connection, then tests them. Never imports or renames existing media. `--check` reports drift. |
| `tools/arr-reclaim.sh` | When media Radarr/Sonarr imported is deleted in Plex, removes its torrent with its data from the `:8081` qBittorrent. Run by `arr-reclaim.service`; `--audit` changes nothing. |
| `tools/seerr-configure.sh` | After your one-time Plex sign-in, finishes Seerr's setup: Plex server and libraries, Radarr/Sonarr at HD-1080p, admin-only sign-in, then a full Plex scan. `--check` reports drift. |
| `recyclarr/recyclarr.yml` | The TRaSH profiles: 4K HDR movies (UHD Bluray + WEB), 1080p series (WEB-1080p), with their custom formats; 4K qualities in one group so release-group tiers decide. |
| `decluttarr/config.yaml` | Which queued downloads Decluttarr replaces: stalled, under 500 KB/s, or stuck on metadata. Nothing already imported. |
| `tools/recyclarr.sh` | Runs Recyclarr once, as a throwaway container (`recyclarr:preview` / `recyclarr:sync`). |
| `tools/lib/servarr.sh` | The API plumbing shared by the Prowlarr, Radarr and Sonarr configure scripts. |
| `tools/deploy.sh` | Installs the `pms-update` units, and arms the timer only while native Plex is masked or removed. `--check` reports drift. |
| `tools/update-stack.sh` | Pulls new images, skips the run if anyone is streaming, recreates the container, verifies it, and rolls back if it's unhealthy. Run weekly by `pms-update.timer`. |
| `systemd/pms-update.{service,timer}` | Sunday 05:00, the same slot as pms-local's native updater. Installed by `npm run deploy`. |
| `systemd/arr-reclaim.service` | The `arr-reclaim` watcher: pms-local's `plex-watch`, ported for the `:8081` instance. Installed, enabled and restarted by `npm run deploy`. |
| `tests/*.test.sh` | Offline unit tests; `tests/run-all.sh` runs them all. |

## Running it

npm is only a task runner here, as in pms-local: there are no dependencies, and node comes
from nvm. Run it as yourself, never `sudo npm …` — sudo strips nvm from `PATH`, and the
scripts ask for sudo themselves where they need it. Compose runs from this clone; the state
lives in `/opt/appdata`.

| command | does |
|---|---|
| `npm start` | Preflight, then start every service the current phase has enabled. |
| `npm stop` | Stop them. Containers and config are kept; nothing here runs `down -v`. |
| `npm run status` | `docker compose ps`, and when the updater runs next. |
| `npm run logs` | Follow the logs; `npm run logs -- plex` for one service. |
| `npm run lint` | `shellcheck` on `tools/` and `tests/`, and check that `compose.yaml` renders. |
| `npm test` | The offline test suites. |
| `npm run check` | Deploy drift: units missing, changed or wrong mode, or the timer armed wrongly. Changes nothing. |
| `npm run deploy` | Lint and test, then install the units and arm or disarm the timer. |
| `npm run update:dry` | Updater rehearsal: pulls, but recreates nothing. |
| `npm run update` | Update now, outside the Sunday schedule. |
| `npm run qbt:configure` | Apply the `:8081` qBittorrent's settings; the first run also sets its login from `.env`. |
| `npm run qbt:check` | Report qBittorrent settings drift. Changes nothing. |
| `npm run prowlarr:configure` | Apply Prowlarr's login, FlareSolverr proxy and indexers, then test each indexer. |
| `npm run prowlarr:check` | Report Prowlarr drift and test the indexers. Changes nothing. |
| `npm run arr:configure` | Apply Radarr's and Sonarr's settings, then test their qBittorrent and Plex connections. |
| `npm run arr:check` | Report Radarr/Sonarr drift. Changes nothing. |
| `npm run reclaim:audit` | What `arr-reclaim` would remove right now. Changes nothing. |
| `npm run seerr:configure` | Finish Seerr's setup after the Plex sign-in, then test its connections. |
| `npm run seerr:check` | Report Seerr drift. Changes nothing. |
| `npm run recyclarr:preview` | What a Recyclarr sync would change. Changes nothing (run in a terminal; the report is a table). |
| `npm run recyclarr:sync` | Apply the TRaSH profiles. Then `arr:configure` and `seerr:configure`. |

Before a phase:

```bash
tools/preflight.sh
```
