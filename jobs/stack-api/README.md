# stack-api

The docs site's backend. It runs the **Plex sign-in that gates the whole site**: nginx
(in [apps/docs](../../apps/docs/README.md)) asks it before serving any page or `/live/`
file, and only the account that owns this Plex server gets in. Behind that it runs the
**request doctor** (`/requests/`): why each open Seerr request has no file yet, and what
to do about it, and Ask AI, which has a model say the same in plain words. Later, the `/control/` page's actions will be its routes too.

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
- **The request doctor** ([`requests.ts`](requests.ts), verdicts in
  [`stack/lib/request-doctor.ts`](../../stack/lib/request-doctor.ts)) reads each open Seerr
  request, its title, queue entries and history in Radarr or Sonarr, and Prowlarr's
  failing indexers, and says where it stands: waiting for approval, not out yet, waiting
  for an episode to air, downloading, stuck in the queue, failed, and so on. Those reads
  are cheap and kept for a minute.
- **Analyse** runs a release search for one request (Radarr's or Sonarr's `/release`,
  what Interactive Search shows) and groups the refusals: no 4K release under the 4K
  profile, over the size cap (with the MB/min and the cap from `arr-policy.ts`), no HDR,
  too few seeders, wrong language. The advice names the profile or cap to change. A
  search asks every indexer, FlareSolverr's included, so it runs only when asked: one at
  a time, at most 10 an hour, and its summary is kept 6 hours (in the SQLite file). It
  never grabs, and nothing here writes to Seerr, Radarr, Sonarr or Prowlarr.
- **Ask AI** has a model put one request's facts into a few sentences and a next step:
  the doctor's verdict, the title in Radarr/Sonarr, its queue and history, the last
  search's summary, and the policy from `arr-policy.ts` (prompt in
  [`stack/lib/request-ai.ts`](../../stack/lib/request-ai.ts), clients in
  [`stack/lib/ai.ts`](../../stack/lib/ai.ts)). The facts are redacted before the prompt is
  built, so no key reaches a model. Only when asked, one at a time, at most
  `AI_MAX_PER_HOUR` (20) an hour. It runs in the background: `POST
  /api/requests/:id/advise` answers 202 at once, and the page polls `GET` on the same
  path (running, done, failed, idle) and finds a running one again after a reload. The
  answer is kept (SQLite, up to 7 days) and shown while the verdict and the last search
  are the same ones it was about.
- **Which models**: `AI_MODELS` in the install's `.env` is the allowlist the page's picker
  shows (`ollama/qwen2.5:3b,ollama/llama3.2,…`; `off` for none), `AI_MODEL` the default.
  stack-api refuses any model not on it, so a paid one is reachable only once listed.
  Read at start: `sudo systemctl restart stack-api` after a change. A paid API is one more
  client in `ai.ts`, with its key in `.env` (`*_KEY`, secret by name).
- **Built on [Hono](https://hono.dev)**, the stack's one runtime dependency. `stack/install.sh`
  copies `node_modules/hono` into the install (it has no dependencies of its own), and only
  `jobs/stack-api/` may import it (`stack/lib/rules.test.ts`).

[`stack-api.ts`](stack-api.ts) starts it and holds the exit codes; [`app.ts`](app.ts) holds
the sign-in routes, [`requests.ts`](requests.ts) the doctor's, and [`store.ts`](store.ts)
what it keeps.

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
- **An Analyse is a real search.** It is the same request as Interactive Search: every
  indexer is asked, and a FlareSolverr one starts a headless Chromium. That is why it is
  a button and not a timer.
- **Ollama is native, not a container**: `ollama.service` on `127.0.0.1:11434`, outside
  compose and `pms-update`, so it updates itself (or not) and `task check` doesn't see it.
  On this box it runs on the CPU (an i7-2600 without AVX2; the GTX 560 is too old):
  qwen2.5:3b reads the prompt at ~5 tokens/s and writes at ~2.5, so an answer takes
  minutes and holds the cores a Plex transcode wants. That is why it is a button, one at
  a time, in the background (past nginx's 180 s), and why the prompt is compact JSON.
  Ollama reuses the shared system prompt between asks while the model stays loaded
  (`keep_alive` 10 min), so a second ask is quicker. A 7B model (mistral) is slower still. A model it has not pulled answers "run: ollama pull …"; a model's answer can be
  wrong, and the page says to check it.
- **Never log cookies or tokens.** The journal says who signed in or was refused, nothing
  that would let someone else in.
- **Signing out everywhere:** stop the service and delete the `sessions` rows (or the whole
  `stack-api.sqlite`; a new client identifier is then made and plex.tv lists a new
  device).
