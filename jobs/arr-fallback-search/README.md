# arr-fallback-search

Asks Radarr to search again for the monitored **`4K HDR or 1080p`** movies that have no 4K
file yet.

## Role

Radarr searches a movie in full only when it is added. After that it sees new releases only
through RSS, every 30 minutes, so a 4K HDR release that appears later is never searched for.
This job closes that gap for the opt-in profile (Phase 6b) that
[Recyclarr](../../apps/recyclarr/README.md) creates.

## Schedule

Daily at 04:00 (up to 30 minutes of jitter): [`arr-fallback-search.timer`](arr-fallback-search.timer)
runs [`arr-fallback-search.service`](arr-fallback-search.service), which runs
[`arr-fallback-search.sh`](arr-fallback-search.sh) from the main clone. `task deploy`
installs both units and always arms the timer.

## Tasks

| task | does |
|---|---|
| `task arr-fallback-search:run` | Queue one search now. |
| `task arr-fallback-search:dry` | List the movies it would search. Changes nothing. |
| `task arr-fallback-search:logs` | The last runs' journal. |

## Traps

- **It finds the profile by its exact name**, as `stack/lib/arr-configure.sh` and
  `apps/recyclarr/recyclarr.yml` do. [`arr-fallback-search.test.sh`](arr-fallback-search.test.sh)
  fails if those three disagree.
