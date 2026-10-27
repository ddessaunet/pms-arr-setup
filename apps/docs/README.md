# docs

This repo's documentation website, on the LAN. It has three pages, the
[stack dashboard](../../site/src/content/docs/index.mdx), the
[quality-profiles map](../../site/src/content/docs/quality-profiles.mdx) and the
[control page](../../site/src/content/docs/control.mdx), in Starlight's doc
layout: a sidebar between them, and each page's contents beside it (on the map, down to
each profile).

## Role

nginx serving the static site that [`site/`](../../site/Taskfile.yml) builds (Starlight). The
site reads the repo when it is built: the map comes from `apps/recyclarr/recyclarr.yml` and
`stack/lib/arr-configure.sh`, and its explanations from `site/src/data/profiles.yml`.

Three names, three things: `docs/` is the runbook (Markdown in the repo), `site/` is the
website's source, and `apps/docs` is the container that serves the built website.

## Access

- `http://<box>:8088/` is the **stack dashboard**: a link to every service (built from the
  address you opened it on, so it follows the box), each one's status, the host's jobs, and the
  logs worth checking. `/quality-profiles/` is the profile map.
- `/control/` is a **mock** of a control section: Deploy now with its streaming log, what is
  running (from `/live/`), restart, run a job now, a drift check, and the history. Every
  action is simulated in the browser and changes nothing; nginx still serves files only.
- No login, like the other apps. The live data is written by `jobs/stack-status` with every
  secret masked before it reaches the page.

## Secrets

None. The dashboard's files hold no secret: `jobs/stack-status` masks them and refuses to
publish a document that still has one. They do show container logs, torrent names and
addresses to anyone on the LAN, as the apps themselves do.

## Settings

[`nginx.conf`](nginx.conf), mounted read-only. The content is the install's `site/dist`,
which `task deploy` replaces with the source's build. `/live/` is `/opt/appdata/docs-status`, mounted read-only:
the dashboard's `status.json`, `logs.json` and `drift.json`, never cached and never in the
access log (the page polls every 30 s).

The site's look is [`DESIGN.md`](../../DESIGN.md) (Pacman: pixel headings, a plain sans for
prose, maze-blue walls and pellet-dotted lines on one dark theme), implemented in
[`site/src/styles/pacman.css`](../../site/src/styles/pacman.css). Starlight's theme picker is
replaced (`site/src/components/overrides/`), and the fonts are self-hosted. The map's
contents list the profile cards through Starlight's route middleware
([`site/src/routeData.ts`](../../site/src/routeData.ts)): the cards are a component, so
their headings don't reach the contents by themselves. The design skills
used on it are committed in `.agents/skills/` (listed in `skills-lock.json`).

## Tasks

| task | does |
|---|---|
| `task site:build` | Build the site and swap it into the source's `site/dist`. `task deploy` publishes it; nginx needs no restart. |
| `task site:check` | Build into a scratch folder to prove it builds. Publishes nothing. |
| `task site:test` | The unit tests of the profile map's data. |
| `task site:dev` | Live preview on `:4321`, reachable from the LAN. |
| `task docs:logs` / `ps` / `up` / `update` / `update:dry` | The standard app tasks. |

## Traps

- **Deploy a build before the first `up`.** With no `site/dist` in the install yet, nginx
  answers 404 until `task deploy` runs with node and pnpm on `PATH`.
- **The build is a check.** It fails if `recyclarr.yml` and `profiles.yml` list different
  profiles, or if they disagree with `arr-configure.sh` on defaults or upgrades. A failed
  build leaves the published site as it was.
- **Mount `site/`, never `site/dist`.** The build and the install swap `dist` for a new
  folder, and a bind of the old one would keep serving it.
- **Node comes from nvm, which `~/.profile` loads.** In a shell without it, the `site:*`
  tasks stop and say how to load it.
- **Create `/opt/appdata/docs-status` as yourself before the first `up` with the `/live`
  mount**, or Docker creates it root-owned and `jobs/stack-status` cannot write:
  `install -d -m 755 /opt/appdata/docs-status`.
- **A changed `nginx.conf` needs a restart**: a single-file bind keeps the old file after
  the install replaces it. `task deploy` restarts `docs` when it changed.
