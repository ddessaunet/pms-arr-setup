# stack-api

The docs site's backend. Today it runs the **Plex sign-in that gates the whole site**:
nginx (in [apps/docs](../../apps/docs/README.md)) asks it before serving any page or
`/live/` file, and only the account that owns this Plex server gets in. Request status
(`/requests/`) and, later, the `/control/` page's actions are its routes too.

## Role

- **Signing in** is Plex's PIN flow, the one Seerr uses, run from here so the account's
  token never reaches a page. The login page asks for a PIN and opens plex.tv in a popup.
  The page polls until the user has approved it, and stack-api then checks with plex.tv
  that the account owns the server with identity `f3860770…` (CLAUDE.md trap 4). Anyone
  else is refused ("owner only").
- **The session is its own:** a random cookie (`pms_session`, HttpOnly, SameSite=Lax, 30
  days), stored as a SHA-256 hash in `/opt/appdata/stack-api/stack-api.sqlite`. The Plex
  token is used for that one check and dropped: no Plex credentials are kept.
- **No TCP port.** It listens on `/opt/appdata/stack-api/run/api.sock`. apps/docs mounts
  that folder read-only at `/api`, and nginx proxies `/api/` to it and uses
  `/api/auth/check` as its `auth_request`.
- **It talks to the apps directly**, through `stack/lib/*.ts`, as the jobs do. It does not
  sit in front of the jobs, and they don't need it: if it's down, they keep running, but
  the site only shows its login page.
- **Built on [Hono](https://hono.dev)**, the stack's one runtime dependency. `stack/install.sh`
  copies `node_modules/hono` into the install (it has no dependencies of its own), and only
  `jobs/stack-api/` may import it (`stack/lib/rules.test.ts`).

[`stack-api.ts`](stack-api.ts) starts it and holds the exit codes; [`app.ts`](app.ts) holds
the routes, and [`store.ts`](store.ts) what it keeps.

## Schedule

Always running: [`stack-api.service`](stack-api.service) runs
[`stack-api.sh`](stack-api.sh) from the install, a launcher for `stack-api.ts`. `task
deploy` installs, enables and restarts it on every run, as it does arr-reclaim, because a
change to the code alone doesn't show in the unit file.

## Tasks

| task | does |
|---|---|
| `task stack-api:health` | Asks the running service through its socket. |
| `task stack-api:status` / `stack-api:logs` | The unit's state / its journal: sign-ins, refusals, errors. |

## Traps

- **While it is down, the site is locked.** nginx's `auth_request` fails closed: every page
  sends you to `/login/`, which says that stack-api is not answering. The jobs and
  `/live/` files keep being written; only reading them waits.
- **Signing in needs plex.tv.** Without the internet, no new sign-in works. A session
  that already exists keeps working, because it is checked here, not at plex.tv.
- **Create `/opt/appdata/stack-api/run` as yourself before the first `up` of docs with its
  mount**, or Docker creates it root-owned and the service cannot make its socket:
  `install -d -m 755 /opt/appdata/stack-api /opt/appdata/stack-api/run`. The service
  creates both itself when they are missing.
- **Never log cookies or tokens.** The journal says who signed in or was refused, nothing
  that would let someone else in.
- **Signing out everywhere:** stop the service and delete the `sessions` rows (or the whole
  `stack-api.sqlite`; a new client identifier is then made and plex.tv lists a new
  device).
