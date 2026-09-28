# pms-arr-setup

The containerized media stack for this box: Plex, qBittorrent, Prowlarr + FlareSolverr,
Radarr + Sonarr, Jellyseerr and Recyclarr, all in Docker Compose. It replaces the native
setup in [pms-local](https://github.com/ddessaunet/pms-local), one reversible phase at a
time, without breaking that setup until the last phase.

```
/mnt/data/                        ← one ext4 volume: hardlinks work across the whole tree
├── torrents/                     ← qBittorrent save paths
│   ├── <release name>/           ← native qBittorrent (pms-local), until Phase 7
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
| `compose.yaml` | The stack. Services are gated behind profiles until their phase is done. |
| `.env.example` | Copy to `.env` (gitignored): UID/GID, timezone, appdata path, Plex claim. |
| `tools/preflight.sh` | Read-only checks before a phase: docker, `.env`, same-filesystem hardlinks, ports, native service state. |
| `tools/update-stack.sh` | Pulls new images, skips the run if anyone is streaming, recreates the container, verifies it, and rolls back if it's unhealthy. Run weekly by `pms-update.timer`. |
| `systemd/pms-update.{service,timer}` | Sunday 05:00, the same slot as pms-local's native updater. Installed in Phase 1b. |
| `tests/*.test.sh` | Offline unit tests. Run each directly. |

## Running it

Compose runs from this repo; the state lives in `/opt/appdata`.

```bash
tools/preflight.sh
```

```bash
docker compose ps
```
