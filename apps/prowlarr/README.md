# prowlarr

The indexer manager (Phase 3). It searches only and has no media mounts.

## Role

Prowlarr holds the indexers and pushes them to Radarr and Sonarr. Indexers tagged `flare`
go through [FlareSolverr](../flaresolverr/README.md).

## Access

- WebUI and API on `:9696`; `prowlarr:9696` on the `arr` network.

## Secrets

- `PROWLARR_API_KEY` (`.env`): fixed before the first start; compose passes it as
  `PROWLARR__AUTH__APIKEY`. Radarr and Sonarr are wired to it, so changing it means
  changing it everywhere.
- `PROWLARR_USER` / `PROWLARR_PASS`: its WebUI login, which the LAN is not asked for.

## Settings

Owned by [`configure.sh`](configure.sh):

- the login and the FlareSolverr proxy;
- the indexer list, and which indexers are tagged `flare`;
- the Radarr/Sonarr applications;
- **Minimum Seeders** (`MIN_SEEDERS`, on the sync profile).

After applying, it runs `ApplicationIndexerSync` and tests every indexer.

## Tasks

| task | does |
|---|---|
| `task prowlarr:configure` | Apply its settings, sync them to Radarr/Sonarr, then test each indexer. |
| `task prowlarr:check` | Report drift and test the indexers. Changes nothing. |
| `task prowlarr:logs` / `ps` / `up` / `update` / `update:dry` | The standard app tasks. |

## Traps

- **Minimum Seeders belongs to the sync profile.** Prowlarr's full sync overwrites it on the
  Radarr/Sonarr indexers, so never set it there. A sync-profile edit doesn't push by itself,
  which is why `configure` runs the sync.
- **Tag `flare` only on indexers Cloudflare actually blocks.** Each such search runs a
  headless Chromium.
- **Servarr reads `allowedHosts` at startup only.** `configure` restarts the app after
  changing it. Without the restart, calls between Prowlarr and Radarr/Sonarr fail with
  "Invalid Hostname" after the next unrelated restart.
