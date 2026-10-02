# recyclarr

Syncs TRaSH's quality profiles and custom formats into Radarr and Sonarr (Phase 6). It is a
one-shot tool, not a long-running service.

## Role

[`recyclarr.yml`](recyclarr.yml) defines:

- **Radarr:** `UHD Bluray + WEB` (4K HDR, the default); its opt-in variant
  **`4K HDR or 1080p`** (Phase 6b), which has the same `trash_id` and so the same scores;
  and the hand-picked **`UHD Fallback`**.
- **Sonarr:** `WEB-1080p`.

## Access

None. It runs as a throwaway container (compose profile `tools`) on the `arr` network, and
`task start` never starts it.

## Secrets

- `RADARR_API_KEY` / `SONARR_API_KEY` (`.env`), passed to it by compose.

## Settings

[`recyclarr.yml`](recyclarr.yml) is the first of the three quality owners. Radarr and
Sonarr's own `configure.sh` (sizes, upgrades, no Remux) comes second, and Seerr (which
profile a request gets) third. State goes in `/opt/appdata/recyclarr`.

## Tasks

| task | does |
|---|---|
| `task recyclarr:preview` | What a sync would change. Changes nothing; run it in a terminal, because the report is a table. |
| `task recyclarr:sync` | Apply the profiles. Then run `task arr:configure` and `task seerr:configure`. |

## Traps

- **Its 4K qualities are one group on purpose.** Radarr ranks quality before score, so with
  them split, any Bluray encode would beat a well-seeded tiered WEB release.
- **`4K HDR or 1080p` is matched by name** in `stack/lib/arr-configure.sh` and
  `jobs/arr-fallback-search/`, and `arr-fallback-search.test.sh` pins it. Rename it in all
  three places or none.
- **`UHD Fallback` is not backed by the guide**, so it gets only the custom formats listed
  for it. HDR is preferred but not required; no tiers, no LQ penalty (YTS passes), no Remux,
  no upgrades.
- **`quality_definition` must stay out**: Radarr and Sonarr's `configure.sh` owns the sizes.
- **Its image tag (`:8`) is its update policy**. It is not on the weekly updater.
