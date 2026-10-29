# bazarr

Spanish and English subtitles for everything Radarr and Sonarr manage (Phase 9).

## Role

It writes `.es.srt` / `.en.srt` beside the video (`Title (Year).es.srt`). Plex reads those
as local subtitles, and Bazarr has Plex refresh the title once one lands. A sidecar file
never counts as media for [`arr-reclaim`](../../jobs/arr-reclaim/README.md).

## Access

- WebUI on `:6767`; `bazarr:6767` on the `arr` network. It reaches Plex through the host
  gateway.

## Secrets

- Its WebUI login is `ARR_USER` / `ARR_PASS`.
- `OPENSUBTITLES_USER` / `OPENSUBTITLES_PASS` (optional): an **OpenSubtitles.com** account,
  about 20 downloads a day. An OpenSubtitles.org account is separate and won't work.
- Its API key is its own, in `/opt/appdata/bazarr/config/config.yaml`.

## Settings

Owned by [`configure.ts`](configure.ts) (`configure.sh` launches it):

- Radarr and Sonarr;
- **every** language profile (Spanish and English, for every title);
- the providers (OpenSubtitles.com when `.env` has an account);
- the Plex refresh;
- its login.

## Tasks

| task | does |
|---|---|
| `task bazarr:configure` | Apply its settings, then check its Radarr, Sonarr and Plex connections. |
| `task bazarr:check` | Report drift. Changes nothing. |
| `task bazarr:logs` / `ps` / `up` / `update` / `update:dry` | The standard app tasks. |

## Traps

- **`only_monitored` stays off**: most of the library is unmonitored, and those titles need
  subtitles too.
- **Bazarr replaces the whole language-profile list on a write**, so `configure.ts` owns
  all of the profiles, not just one.
- **Under Plex OAuth it owns how it reaches Plex.** Bazarr 1.6 moved itself from the API
  key to OAuth (`plex.auth_method: oauth`, on the box since 2026-10-18). It then connects
  by `plex.server_url` and clears `plex.ip`/`port`/`ssl` at every start, so `configure.ts`
  leaves those three alone. If the token check fails, apply stores `PLEX_TOKEN`, which puts
  Bazarr back on the API key, and sets `plex.ip` again.
- **It mounts `streaming/` only**, at its host path, so paths match Radarr's and Sonarr's
  with no mapping. It never hardlinks, so it can't touch seeding data.
