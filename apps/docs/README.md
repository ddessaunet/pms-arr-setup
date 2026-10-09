# docs

This repo's documentation website, on the LAN. For now it has one page: the
[quality-profiles map](../../site/src/content/docs/quality-profiles.mdx).

## Role

nginx serving the static site that [`site/`](../../site/Taskfile.yml) builds (Starlight). The
site reads the repo when it is built: the map comes from `apps/recyclarr/recyclarr.yml` and
`stack/lib/arr-configure.sh`, and its explanations from `site/src/data/profiles.yml`.

Three names, three things: `docs/` is the runbook (Markdown in the repo), `site/` is the
website's source, and `apps/docs` is the container that serves the built website.

## Access

- `http://<box>:8088/` is the **stack dashboard**: a link to every service (built from the
  address you opened it on, so it follows DHCP), each one's status, the host's jobs, and the
  logs worth checking. `/quality-profiles/` is the profile map.
- No login, like the other apps. The live data is written by `jobs/stack-status` with every
  secret masked before it reaches the page.

## Secrets

None. The dashboard's files hold no secret: `jobs/stack-status` masks them and refuses to
publish a document that still has one. They do show container logs, torrent names and
addresses to anyone on the LAN, as the apps themselves do.

## Settings

[`nginx.conf`](nginx.conf), mounted read-only. The content is the main clone's `site/dist`,
which `task site:build` replaces. `/live/` is `/opt/appdata/docs-status`, mounted read-only:
the dashboard's `status.json`, `logs.json` and `drift.json`, never cached and never in the
access log (the page polls every 30 s).

The site's look is [`DESIGN.md`](../../DESIGN.md) (Pacman: pixel headings, a plain sans for
prose, maze-blue walls and pellet-dotted lines on one dark theme), implemented in
[`site/src/styles/pacman.css`](../../site/src/styles/pacman.css). Starlight's theme picker is
replaced (`site/src/components/overrides/`), and the fonts are self-hosted. The design skills
used on it are committed in `.agents/skills/` (listed in `skills-lock.json`).

## Tasks

| task | does |
|---|---|
| `task site:build` | Build the site and swap it into `site/dist`. In the main clone this publishes it; nginx needs no restart. |
| `task site:check` | Build into a scratch folder to prove it builds. Publishes nothing. |
| `task site:test` | The unit tests of the profile map's data. |
| `task site:dev` | Live preview on `:4321`, reachable from the LAN. |
| `task docs:logs` / `ps` / `up` / `update` / `update:dry` | The standard app tasks. |

## Traps

- **Build before the first `up`.** With no `site/dist` yet, nginx answers 404 until
  `task site:build` runs.
- **The build is a check.** It fails if `recyclarr.yml` and `profiles.yml` list different
  profiles, or if they disagree with `arr-configure.sh` on defaults or upgrades. A failed
  build leaves the published site as it was.
- **Mount `site/`, never `site/dist`.** The build swaps `dist` for a new folder, and a bind
  of the old one would keep serving it.
- **Node comes from nvm, which `~/.profile` loads.** In a shell without it, the `site:*`
  tasks stop and say how to load it.
- **Create `/opt/appdata/docs-status` as yourself before the first `up` with the `/live`
  mount**, or Docker creates it root-owned and `jobs/stack-status` cannot write:
  `install -d -m 755 /opt/appdata/docs-status`.
- **After editing `nginx.conf`, recreate the container** (`task docs:up`): a single-file bind
  keeps the old file after `git pull` replaces it.
