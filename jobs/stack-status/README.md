# stack-status

Writes the stack's status, recent logs and settings drift as JSON for the docs site's front
page (`http://<box>:8088/`).

## Role

The dashboard has to say what this session kept checking by hand: which address the box is
on, whether every app answers, whether the timers ran, and what the logs say. The site is
static, so this job gathers it on the host, and the page polls the files.

- **Every 2 minutes** (`status.json`, `logs.json`):
  - **Containers:** running, restart loops, health checks.
  - **Apps:** each app's own health API (Radarr/Sonarr/Prowlarr `/health`, Bazarr's, Seerr's
    status, Plex's identity `f3860770…`, qBittorrent's connection, FlareSolverr and the docs
    site answering).
  - **Host:** `arr-reclaim` running, every timer armed with the result of its last run,
    `/mnt/data` space, the LAN addresses and any app the address job still has to re-apply.
  - **Logs:** the last 50 lines and the last 50 warnings/errors of each job's journal and
    each container.
- **Hourly** (`drift.json`): each `apps/<app>/configure.sh --check` and
  `stack/deploy.sh --check`, the same checks as `task check`.

Levels: **down** (not running, not answering, or Plex on another identity), **degraded**
(health warnings, a recent Docker restart, a timer disarmed or its last run failed, settings
drift, disk at 95%), **ok**, and **n/a** for Recyclarr, which runs on demand.

The files go to `/opt/appdata/docs-status`, which the docs container mounts at `/live`.

## Schedule

[`stack-status.timer`](stack-status.timer): 1 minute after boot, then every 2 minutes.
[`stack-status-drift.timer`](stack-status-drift.timer): 10 minutes after boot, then hourly.
Each runs its `.service`, which runs [`stack-status.sh`](stack-status.sh) from the main
clone. `task deploy` installs all four units and always arms both timers.

## Tasks

| task | does |
|---|---|
| `task stack-status:run` | Write the status and logs now. |
| `task stack-status:dry` | Print them instead. Writes nothing. |
| `task stack-status:drift` / `:drift:dry` | Run the settings check now / print it. |
| `task stack-status:audit` | How many secrets were loaded and masked, and that none is left. Prints no secret. |
| `task stack-status:logs` | The last runs' journal. It logs only when a level changes. |

## Traps

- **The files are readable by anyone on the LAN**, like the apps themselves, which skip
  login for local addresses. Every string goes through `redact()` and then a leak guard:
  - secrets from `.env`, by key name (`*_KEY`, `*_PASS`, `*_TOKEN`, …);
  - Seerr's and Bazarr's API keys, and Plex's token;
  - anything shaped like a token, key, password, `Authorization:` header or `user:pass@`.

  If a known secret is still in a document, nothing is written and the run fails.
  **A new `.env` key must be classified**: secret by name, or listed in `PUBLIC_ENV_KEYS`.
  The test fails on an `.env.example` key in neither group, and an unclassified one is
  masked anyway.
- **A failed run means the checker broke, not the stack.** A degraded or down stack is still
  a successful run; the page shows it.
- **qBittorrent's login backs off.** After one refused login it waits an hour before trying
  again: five refusals ban the address, and from here that is the docker bridge `arr-reclaim`
  and the configure scripts use too.
- **Create `/opt/appdata/docs-status` as yourself before the docs container first mounts
  it**, or Docker creates it root-owned and the job can't write:
  `install -d -m 755 /opt/appdata/docs-status`.
- **The page calls the data stale after 6 minutes** (three missed runs). It then shows every
  level as stale, with the command to look at the timer.
