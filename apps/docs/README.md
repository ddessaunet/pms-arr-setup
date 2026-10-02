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

- `http://<box>:8088/`, which redirects to `/quality-profiles/`. No login, like the other
  apps; nothing secret is on it.

## Secrets

None.

## Settings

[`nginx.conf`](nginx.conf), mounted read-only. The content is the main clone's `site/dist`,
which `task site:build` replaces.

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
