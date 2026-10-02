# decluttarr

Replaces a download that stalls or crawls. It removes the download from qBittorrent,
blocklists that release in Radarr or Sonarr, and has them search for another.

## Role

It touches the queue only: downloads that were never imported. Because of that it never
meets [`arr-reclaim`](../../jobs/arr-reclaim/README.md), which deals only with imported
media.

## Access

None published. It talks to Radarr, Sonarr and qBittorrent by service name on the `arr`
network.

## Secrets

- `RADARR_API_KEY`, `SONARR_API_KEY`, `QBT_ARR_USER` and `QBT_ARR_PASS` (`.env`). They
  reach it as environment variables, read through `!ENV` in its config.
- `DECLUTTARR_TEST_RUN` (optional, default `false`): set it to `true` to start in test mode.

## Settings

[`config.yaml`](config.yaml), mounted read-only, turns on three jobs: `remove_stalled`,
`remove_slow` (under 500 KB/s) and `remove_metadata_missing`. Each removes a download after
three strikes, with a check every 10 minutes. [`config.test.sh`](config.test.sh) pins that
list.

## Tasks

| task | does |
|---|---|
| `task decluttarr:logs` / `ps` / `up` | The standard app tasks. `up` also re-reads `config.yaml`. |

There is no `update`. The image is pinned (`v2.1.0`), because v1 → v2 changed the config
format and a silent major bump would change what gets removed. Bump the tag by hand after
reading its release notes.

## Traps

- **Listing a job turns it on.** `remove_orphans` and `remove_unmonitored` would delete
  seeding torrents or upgrades.
- **Its `detect_deletions` watcher starts even when it isn't listed**, so it gets no media
  mounts at all: it removes torrents through the qBittorrent API.
- **`remove_slow` pauses** while qBittorrent runs above 80% of its download limit.
- **The config is a relative bind** (`./config.yaml`). A container created from a worktree
  points into that worktree, and breaks when the worktree is deleted. Recreate it from the
  main clone (`task decluttarr:up`).
