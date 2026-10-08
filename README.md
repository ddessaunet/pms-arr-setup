# pms-arr-setup

The containerized media stack for this box: Plex, qBittorrent, Prowlarr + FlareSolverr,
Radarr + Sonarr, Seerr, Recyclarr, Decluttarr and Bazarr, all in Docker Compose. It replaces the native
setup in [pms-local](https://github.com/ddessaunet/pms-local), one reversible phase at a
time, without breaking that setup until the last phase.

```
/mnt/data/                        ← one ext4 volume: hardlinks work across the whole tree
├── torrents/                     ← qBittorrent save paths
│   ├── radarr/  sonarr/          ← container qBittorrent, one category per app
│   ├── manual/                   ← torrents added by hand; no app touches them
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
| `apps/<app>/README.md` | One per app: what it does, its ports, secrets, who owns its settings, its tasks and traps. |
| `jobs/<job>/README.md` | One per host job: what it does, when it runs, its tasks. |

## Layout

One folder per app and per job, every one the same shape:

```
compose.yaml          name: pms, the arr network, and an include for every apps/*/compose.yaml
Taskfile.yml          every task (task --list); includes every app and job under its own name
.env.example          copy to .env (gitignored): UID/GID, timezone, appdata, API keys, logins
apps/<app>/           one compose service
  compose.yaml        that service alone, with its comments
  Taskfile.yml        which standard tasks it gets (from stack/taskfiles/), plus its own
  README.md           Role · Access · Secrets · Settings · Tasks · Traps
  configure.sh        if this repo owns its settings: apply idempotently, --check reports drift
  configure.test.sh   offline tests, beside what they test
  <config>            recyclarr.yml, decluttarr's config.yaml
jobs/<job>/           a host-side systemd job that spans apps: script, unit(s), test, README, Taskfile
site/                 the docs website's source (Starlight); apps/docs serves what it builds
stack/                what the whole stack shares
  taskfiles/          the per-app task templates: service, update, configure
  lib/                servarr.sh (Servarr API plumbing), arr-configure.sh (Radarr + Sonarr)
  start.sh  preflight.sh  deploy.sh  run-tests.sh  main-clone.sh
  layout.test.sh      the app contract, below
docs/                 the runbook and the updater (Markdown, read in the repo)
```

`docs/` is the runbook, `site/` the website's source, and `apps/docs` the container that
serves the built website.

| app | port | role |
|---|---|---|
| [plex](apps/plex/README.md) | 32400 (host network) | The media server; the live library and watch history. |
| [qbittorrent](apps/qbittorrent/README.md) | 8081, peer 13762 | The download client for Radarr/Sonarr. |
| [prowlarr](apps/prowlarr/README.md) | 9696 | Indexers, pushed to Radarr/Sonarr. |
| [flaresolverr](apps/flaresolverr/README.md) | — | Cloudflare solver for the indexers tagged `flare`. |
| [radarr](apps/radarr/README.md) | 7878 | Movies. |
| [sonarr](apps/sonarr/README.md) | 8989 | Series. |
| [seerr](apps/seerr/README.md) | 5055 | Requests. |
| [recyclarr](apps/recyclarr/README.md) | — | TRaSH quality profiles, on demand. |
| [decluttarr](apps/decluttarr/README.md) | — | Replaces stalled or crawling downloads. |
| [bazarr](apps/bazarr/README.md) | 6767 | Spanish and English subtitles. |
| [docs](apps/docs/README.md) | 8088 | This repo's docs website: for now, the quality-profiles map. |

| job | runs | role |
|---|---|---|
| [arr-reclaim](jobs/arr-reclaim/README.md) | always (watcher) | Frees a torrent once the media it imported is deleted. |
| [arr-fallback-search](jobs/arr-fallback-search/README.md) | daily 04:00 | Re-searches the `4K HDR or 1080p` movies without a 4K file. |
| [pms-update](jobs/pms-update/README.md) | Sunday 05:00 | Updates the containers, with a streaming check and a rollback. |
| [lan-address](jobs/lan-address/README.md) | after boot, every 5 min | Re-applies the apps that list the box's addresses when DHCP moves it. |

## The app contract

`stack/layout.test.sh` (part of `task test`) fails unless:

- Every folder in `apps/` is included by `compose.yaml` and `Taskfile.yml`. Its
  `compose.yaml` defines exactly the service of that name, with `container_name` the same
  and no project name. A linuxserver image sets `PUID`, `PGID`, `TZ` and `UMASK`. Anchors
  can't cross files, so each app writes those four out.
- Every app has a `README.md` with the sections **Role, Access, Secrets, Settings, Tasks**.
  **Traps** is added when it has some.
- Every app has the standard tasks for what it is:
  - a long-running service gets `logs`, `ps` and `up`;
  - one on the weekly updater also gets `update` and `update:dry`;
  - one whose settings live here also gets `configure` and `check`, takes `--check`, has a
    test, and is in `CONFIGURED` in `Taskfile.yml`, so `task check` covers it.

  There are two exceptions, each with its reason in the test. Recyclarr is one-shot
  (`preview` and `sync` only). Decluttarr is pinned, so it has no `update`.
- Every job has a script, a test, a unit in `stack/deploy.sh`'s manifest whose `ExecStart`
  exists, a `README.md` (**Role, Schedule, Tasks**) and a `Taskfile.yml`.
- Every script resolves the repo root correctly from where it lives.

Adding an app:

1. Create `apps/<app>/` with those files.
2. Add one `include` line to `compose.yaml` and one to `Taskfile.yml`.
3. Add it to `UPDATE_SERVICES` in `.env` if the weekly updater should cover it.

## Running it

[Task](https://taskfile.dev) is the task runner: a single binary, at version 3.44 or later.
This box installs and updates its tools with Homebrew, whose formula is `go-task`. The
binary is still `task`:

```bash
brew install go-task
```

Run tasks as yourself, never `sudo task`: sudo's `PATH` has no Homebrew in it. The scripts
ask for sudo themselves where they need it. The systemd units never call `task`, so the
timers don't depend on it. Compose runs from the main clone, and state lives in
`/opt/appdata`.

**Tasks that change containers or units run from the main clone only.** These are `start`,
`stop`, `<app>:up`, `<app>:update`, `update` and `deploy`. `compose.yaml` fixes the project
name, so compose run from a worktree acts on the live stack, and a relative bind (decluttarr's
config) would then point into a checkout that is deleted later. `stack/main-clone.sh`
enforces this.

| command | does |
|---|---|
| `task --list` | Every task, with a line on what it does. |
| `task start` | Preflight, then start every service the current phase has enabled. |
| `task stop` | Stop them. Containers and config are kept; nothing here runs `down -v`. |
| `task status` | `docker compose ps`, and when the updater, the fallback search and the address check run next. |
| `task logs` | Follow the logs. `task logs -- plex` or `task plex:logs` for one service. |
| `task preflight` | Read-only checks before a phase: docker, `.env`, same-filesystem hardlinks, ports, native service state. |
| `task lint` | `shellcheck` on every script, and check that `compose.yaml` renders. |
| `task test` | The offline test suites, the app contract included. |
| `task check` | Deploy drift and every app's settings drift, in one report. Changes nothing. |
| `task deploy:check` | Deploy drift only: units missing, changed or with the wrong mode, or a timer armed wrongly. |
| `task deploy` | Lint and test, then install the units and arm or disarm the timers. |
| `task update` / `update:dry` | Update now, outside the Sunday schedule / rehearse: pull, recreate nothing. |
| `task <app>:configure` / `<app>:check` | Apply an app's settings / report its drift. `task arr:configure` covers Radarr and Sonarr. |
| `task <app>:logs` / `ps` / `up` / `update` | One app's logs, container, recreate (to apply a compose edit), update. |
| `task recyclarr:preview` / `recyclarr:sync` | What a Recyclarr sync would change / apply it. Then `arr:configure` and `seerr:configure`. |
| `task arr-reclaim:audit` | What `arr-reclaim` would remove right now. Changes nothing. |
| `task arr-fallback-search:run` / `:dry` | Search Radarr again now for the `4K HDR or 1080p` movies without a 4K file / list them. |
| `task lan-address:dry` / `:run` / `:logs` | Which apps are behind the box's addresses / apply them now / each change, with the new address. |
| `task site:build` | Build the docs website and swap it in; in the main clone this publishes it on `:8088`. |
| `task site:check` / `site:test` / `site:dev` | Prove it builds / its unit tests / a live preview on `:4321`. These need node (nvm) and pnpm (Homebrew). |

`qbt:` is an alias for `qbittorrent:`.
