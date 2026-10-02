# seerr

The request UI in front of Radarr and Sonarr (Phase 5). It is the merged successor of
Jellyseerr and Overseerr.

## Role

A request becomes an ordinary Radarr or Sonarr add, so their rules apply to it. Nothing in
Seerr touches files, and it has no media mounts.

## Access

- WebUI on `:5055`. Sign-in is Plex accounts, admin only.
- `seerr:5055` on the `arr` network. It reaches Plex through the host gateway.

## Secrets

Its API key is its own, generated on first start into `/opt/appdata/seerr/settings.json`,
not `.env`. [`configure.sh`](configure.sh) reads it there.

## Settings

Owned by [`configure.sh`](configure.sh), after **one browser sign-in with Plex**:

- the Plex server and its libraries;
- Radarr at `UHD Bluray + WEB` and Sonarr at `WEB-1080p` by default (the variant profiles
  are picked per request, never set as the default);
- admin-only sign-in;
- then a full Plex scan.

## Tasks

| task | does |
|---|---|
| `task seerr:configure` | Finish its setup, then test its connections. Run it after `recyclarr:sync` and `arr:configure`. |
| `task seerr:check` | Report drift. Changes nothing. |
| `task seerr:logs` / `ps` / `up` / `update` / `update:dry` | The standard app tasks. |

## Traps

- **Its API key is refused (403) until the admin exists**, so sign in with Plex in the browser
  once before the first `configure`.
- **It rejects read-only fields in writes**, so `configure.sh` only ever sends the fields it
  owns.
- **It runs unprivileged** (as `node`), so `/opt/appdata/seerr` must exist and belong to
  you before the first start. `task start` creates it.
