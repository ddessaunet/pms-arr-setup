[← Index](../README.md)

# Bun migration

Porting the API-heavy bash scripts to TypeScript on [Bun](https://bun.com), for
readability: about 3,700 lines of bash, most of it calling app APIs and reshaping JSON
through `jq --arg` strings, with helpers copied between scripts (`env_get` five times, the
qBittorrent login rule three, the Plex token reader three). One PR per step. Bash and
TypeScript live side by side until the last one, and nothing on the box changes behaviour
except where a step says so.

Tick these as steps merge, and commit the tick, as in [Phases](phases.md). If the list
looks stale, check the repo and the box rather than trusting it.

- [x] Step 0 — foundation: toolchain, `stack/lib/bun.sh`, the shared `stack/lib/*.ts` with tests (2026-10-23: no script ported; `task lint test` and the site's checks pass)
- [x] Step 1 — `arr-fallback-search` (2026-10-26: `--dry-run` matches the bash one on the box; Radarr types hand-written, generation left to step 2b)
- [x] Step 2a — `apps/plex/configure.sh` (2026-10-26: `--check` matches the bash one against the live Plex 1.43.5, exit 0 both)
- [x] Step 2b — `apps/prowlarr/configure.sh` (2026-10-26: `--check` matches the bash one against the live Prowlarr 2.6.5, 6 indexers and 2 apps; Prowlarr's API types generated)
- [x] Step 2c — `apps/qbittorrent/configure.sh`, with `EXCLUDED_EXTS` and decluttarr's pin (2026-10-26: `--check` matches the bash one against the live qBittorrent; the list is `apps/qbittorrent/excluded.ts`, pinned by `apps/decluttarr/config.test.ts`)
- [x] Step 2d — `apps/seerr/configure.sh` (2026-10-27: `--check` matches the bash one against the live Seerr 3.5.1; Seerr's API types generated from its YAML spec; stack-status reads Seerr's key with `jq`, not by sourcing the script)
- [x] Step 2e — `apps/bazarr/configure.sh` (2026-10-27: `--check` matches the bash one against the live Bazarr 1.6.2, the known `plex.ip` drift included; stack-status reads Bazarr's key with `awk`, not by sourcing the script)
- [x] Step 3 — `arr-policy` and `arr-configure` (Radarr/Sonarr); the site imports the policy (2026-10-27: `--check` for both matches the bash one against the live Radarr 6.4.4 and Sonarr 4.0.20; their API types generated; Seerr and arr-fallback-search take their profile names from the policy)
- [x] Step 4 — `stack-status` (2026-10-27: against the live stack, the old and new `--stdout` status match after the timestamps, `--drift` matches, the logs match source for source, and `--audit` loads the same 10 secrets in the same order; `testdata/status.golden.json` unchanged)
- [ ] Step 5 — `lan-address`
- [ ] Step 6 — `pms-update`
- [ ] Step 7 — `arr-reclaim`, rehearsed
- [ ] Step 8 — cleanup: `servarr.sh` deleted, shellcheck targets trimmed, docs pass

---

## Scope

Ported: `jobs/{stack-status,arr-reclaim,lan-address,pms-update,arr-fallback-search}`,
`apps/{plex,seerr,bazarr,prowlarr,qbittorrent}/configure.sh` and
`stack/lib/{servarr,arr-configure}.sh`.

Staying bash: `stack/{install,deploy,preflight,start,installed,run-tests}.sh`,
`stack/lib/pms-home.sh`, `apps/recyclarr/run.sh` and the Radarr/Sonarr wrappers. They
move files, run systemd and docker, and are as readable in bash as they would be in
anything else.

## How it fits together

- **Runtime: Bun and the `.ts` sources, nothing else.** `package.json` lists dev tools
  only (`typescript`, `@types/bun`, `openapi-typescript`, `vite-plus`, exact versions), and
  the install is still an rsync copy without them, `bun.lock`, `tsconfig.json`,
  `vite.config.ts`, `.bun-version`, `node_modules` or the tests (`stack/install.sh`,
  checked by `stack/install.test.sh`).
- **Launchers keep every `.sh` path.** Units, `deploy.sh`'s manifest, `pms-home.sh`'s
  install discovery (through `arr-reclaim.service`), the Taskfiles, and stack-status and
  lan-address calling `configure.sh --check` all name the `.sh`. So it stays, as a
  launcher for the `.ts` beside it (the form is in the README's app contract, and
  `stack/layout.test.sh` checks it). `exec` passes exit codes and signals straight
  through. `--no-install` stops Bun fetching a stray bare import from npm at runtime.
- **Finding Bun.** systemd units set no `PATH`, and neither does sudo. `stack/lib/bun.sh`
  tries `PMS_BUN`, then `bun` on `PATH`, then `~/.proto/bin/bun` (the units run as the
  installing user, with its `HOME`), then `/home/linuxbrew/.linuxbrew/bin/bun`. It skips
  one older than `PMS_BUN_MIN` or one that can't report its version (a proto shim with
  nothing pinned), and exits 3 with a message when none is usable. `stack/preflight.sh`
  checks the same, and warns when Bun has no global proto pin (or no `brew pin`).
- **Runtime rules**, enforced by `stack/lib/rules.test.ts`: a non-test `.ts` imports only
  relative paths, `bun:*` and `node:*`, or anything in an `import type` line. No `Bun.$`
  (its own shell, throws on a non-zero exit, no timeout): commands go through
  `stack/lib/run.ts`. No `process.exit()`: `main` runs in `runMain` (`stack/lib/exit.ts`),
  which sets `process.exitCode` and maps an unexpected error to the script's "broken"
  code (3 for the configure scripts, never 1, which means drift).
- **HTTP** goes through `stack/lib/http.ts`: the timeout covers the body too, and a
  network error is status 0 (curl's `000`). There is no cookie jar: `qbittorrent.ts`
  keeps the `SID` and `Referer` by hand. Passwords go in request bodies, never argv.
- **Output formats stay exactly as they are**: `[ts] reclaim: …`, and the indented
  `DRIFT/FAIL/FAILING/WARN` lines that stack-status's `classify_drift` parses. Logs are
  written synchronously (`stack/lib/log.ts`), so piped output reaches journald in full.
- **Seams by dependency injection**: a `Deps` object (http, run, clock, paths) passed to
  `main`. Tests pass fakes rather than mocking modules, and set `TZ` for the clock.
- **Locks are shared.** `stack/lib/lock.ts` takes `flock(2)` through `bun:ffi` on the same
  lock files, so a bash and a TypeScript run of a job exclude each other while both exist
  (`lock.test.ts` checks it against util-linux `flock`, both ways).
- **Watching stays `inotifywait`**, through `Bun.spawn`. `fs.watch` only reports `rename`,
  so it can't tell a delete from a move, and a move must keep its torrent (traps 3 and 9).

### The shared library

`stack/lib/*.ts`, each with a `*.test.ts`:

| module | what | replaces |
|---|---|---|
| `env.ts` | `envGet`: last `KEY=` line wins, no unquoting, a non-empty variable wins | `env_get` (×5) |
| `log.ts` | synchronous lines, `stamped()`, a `strftime` for `%F %T %z` | each script's `log()` |
| `cli.ts` | flags and positionals; `-h` prints the `.ts` header | the `case` loops |
| `exit.ts` | `EXIT`, `UsageError`, `runMain` | — |
| `run.ts` | `Bun.spawn` with timeout (124) and stdin | `timeout`, `$(…)` |
| `http.ts` | `fetch` with curl's habits | `curl -s --max-time … -w '%{http_code}'` |
| `servarr.ts` | `api`, `waitReady`, apply/verify host and resource | `stack/lib/servarr.sh` |
| `qbittorrent.ts` | the login rule (204, or 200 `Ok.`), once, and a session | `qbt_login_ok` (×3) |
| `plex.ts` | the token from `Preferences.xml` | `prefs_token` / `plex_token` |
| `net.ts` | the box's LAN IPv4 addresses | `lan_ips` |
| `keys.ts` | `seerrKey`, `bazarrKey` | `seerr_key`, `bazarr_key` (stack-status keeps a bash copy of each until step 4) |
| `lock.ts` | `flock(2)`, now or with a timeout | `flock -n` / `flock -w` |

`env.ts`, `servarr.ts`, `plex.ts` and `keys.ts` are tested against the bash functions
themselves, on the same inputs.

### API types

- **Radarr, Sonarr, Prowlarr, Seerr:** generated by `openapi-typescript` from each app's
  OpenAPI spec, at the git tag of the running version, which goes into the generated
  file's header (`// version: …`). `stack/lib/api/gen.ts` lists the apps; each joins it
  with its port (Prowlarr since step 2b, Seerr since 2d: a YAML spec, and a version from
  its keyless `/api/v1/status`; Radarr and Sonarr since step 3).
  `task types:gen` regenerates them; the
  read-only `task types:check` compares that version with each app's `/system/status`.
  The weekly updater moves the apps on, so being behind is normal: regenerate when a
  port needs it. Checked in under `stack/lib/api/`, imported with `import type` only
  (`rules.test.ts`), and left out of the install.
- **Step 1** (arr-fallback-search) reads a handful of fields from two Radarr endpoints,
  so it keeps hand-written narrow types beside its code. Radarr's and Sonarr's are
  generated since step 3, so they can give way to those whenever it is next touched.
- **Bazarr** (Swagger 2.0 only), **qBittorrent** and **Plex** (no spec): hand-written
  narrow types.
- Small runtime guards check the fields each script relies on. Seerr writes keep narrow
  types that send only the fields this repo owns (trap 12).

### Data the site and other tests read

- **`stack/lib/arr-policy.ts`** (step 3): size caps, the default profile per app, the
  upgrade and no-Remux profiles, and the `4K HDR or 1080p` name as one constant. Pure
  data, no Bun APIs. `site/src/lib/profiles.ts` imports it instead of regex-parsing
  `arr-configure.sh` (trap 17), and arr-configure and arr-fallback-search share the name
  (trap 11).
- **`EXCLUDED_EXTS`** (step 2c) moves to a data module used by qBittorrent's configure
  script. `apps/decluttarr/config.test.sh` becomes `config.test.ts` and keeps trap 14's pin.

## Tooling

| what | where |
|---|---|
| dev tools | `package.json`, `bun.lock` (`task bun:install`, run by `task lint`) |
| Bun version | `.bun-version` (CI, `packageManager`); `PMS_BUN_MIN` in `stack/lib/bun.sh` at or below it |
| types | `tsconfig.json`: `apps`, `jobs`, `stack`; `verbatimModuleSyntax`; no `paths` |
| lint, format | `vite.config.ts` (Vite+: Oxlint, Oxfmt; the site's style; `site/` and `.claude/` left out) |
| `task lint` | shellcheck, `bun --bun vp check`, `bun --bun tsc --noEmit`, compose |
| `task test` | every `*.test.sh`, then `bun test ./apps ./jobs ./stack` (a bare `bun test` would also find the site's Vitest suites and the worktrees) |
| `task fmt` | `vp fmt` |
| CI | `oven-sh/setup-bun` from `.bun-version` in the `task lint test` job |

On the box, Bun comes from proto and is pinned globally (Homebrew's `brew install bun`
and `brew pin bun` work too):

```bash
proto install bun 1.4.4
```

```bash
proto pin bun 1.4.4 --to global
```

## Each port PR is done when

- The `.sh` is a launcher, and the logic, help text and exit codes are documented in the
  `.ts` beside it.
- Every `.test.sh` case is ported to `.test.ts` under the same name, and the `.test.sh` is
  deleted.
- On the box, old and new read-only output (`--check`, `--dry-run`, `--audit`) is diffed,
  and the diff goes in the PR.
- The job ran once under its own unit: `systemctl start`, then the journal.
  **Sandboxing:** Bun reads interfaces over netlink, and arr-reclaim, arr-fallback-search
  and pms-update don't allow `AF_NETLINK` (`RestrictAddressFamilies`). Either keep
  `stack/lib/net.ts` out of those, or add the address family, deliberately.
- `task lint test` and `task site:lint site:test site:check` pass. The READMEs, the
  CLAUDE.md traps that name the `.sh`, and site comments are updated.

## The steps

**0. Foundation.** The tooling above, `stack/lib/bun.sh`, and the shared library with
tests, including the lock interop and `envGet` parity tests. `vp` runs from the
Bun-managed root under `bun --bun`, so node isn't needed. No script ported.

**1. arr-fallback-search.** Small, and proves the foundation end to end, including under
its own unit.

**2. The configure scripts, one PR each: plex → prowlarr → qbittorrent → seerr → bazarr.**
Each one's `--check` can be compared old against new on the box without changing
anything. qBittorrent's brings `EXCLUDED_EXTS` and the decluttarr pin with it.

**3. arr-policy and arr-configure (Radarr/Sonarr).** The site switches to importing
`arr-policy.ts` in the same PR, and `task site:check` must agree.

**4. stack-status.** It uses everything above. Its contracts: `testdata/status.golden.json`
unchanged (the site's schema test reads it), and trap 19: `publish` redacts and then runs
the leak guard, `PUBLIC_ENV_KEYS` classifies `.env` keys, and the qBittorrent login backs
off for an hour.

**5. lan-address**, then **6. pms-update**, which keeps its exit codes 0–10, its positional
services and `--dry-run`.

**7. arr-reclaim**, last, rehearsed:

- **Ledger:** reading a copy of the real `.arr-reclaim.imports` and writing it back is
  byte-identical.
- **Audit parity:** old and new `--audit` match on the box over several days.
- **Shadow watch:** a new `watch --dry-run` logs decisions and never sends a DELETE or a
  Radarr removal. It runs beside the bash unit on a scratch `LIBRARY` of hardlinked
  fixtures (a delete, a move, a rename, a second link remaining, an import not made yet),
  with `RECLAIM_IMPORTS` pointed at a scratch file.
- **Locks:** a bash `run` and a TypeScript `run` exclude each other.
- **Switch:** `task deploy` restarts the watcher. Rolling back means reverting the
  launcher.

**8. Cleanup.** Delete `servarr.sh` once its last bash user is gone, trim the shellcheck
targets, and do a final pass over CLAUDE.md and the README.
