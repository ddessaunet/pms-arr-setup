// jobs/pms-update/update-stack.ts — weekly, safe image updates for the running containers.
//
//   jobs/pms-update/update-stack.sh               update every service in UPDATE_SERVICES
//   jobs/pms-update/update-stack.sh plex          update just these
//   jobs/pms-update/update-stack.sh --dry-run     pull and report; never recreate anything
//
// Run weekly by pms-update.timer (beside this script). It is the container counterpart of
// pms-local's plex-update.sh and keeps that script's rules:
//
//   - never interrupt a stream: Plex with active sessions waits a week
//   - a missing or rejected token is a failure, not a guess
//   - an update counts only once the service is answering again
//
// and adds the one native could not do: go back to the previous image.
//
// --dry-run still pulls. Pulling only downloads; the running container is not
// touched until something recreates it.
//
// Exit codes — the unit's failed state is the alert, as with plex-update:
//   0  updated, already current, deferred for a stream, not running, or locked
//   3  preflight: docker, .env or compose unusable
//   4  Plex token unreadable or rejected: cannot tell whether anyone is streaming
//   5  Plex is running but will not answer: session state unknown
//   6  pull failed
//   9  new image did not come up healthy; rolled back and the old one is serving
//  10  the rollback failed too: the service is DOWN — see docs/updating.md
//
// With several services, each is tried and the worst code wins.

import { existsSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { headerHelp, parseCli } from '../../stack/lib/cli.ts';
import { envGet, type Env } from '../../stack/lib/env.ts';
import { runMain } from '../../stack/lib/exit.ts';
import { makeHttp, type Http } from '../../stack/lib/http.ts';
import { tryLock, type Lock } from '../../stack/lib/lock.ts';
import { err, out, stamped, type Log } from '../../stack/lib/log.ts';
import { plexPrefsPath, readPlexToken } from '../../stack/lib/plex.ts';
import { run, type Run } from '../../stack/lib/run.ts';

export const EXIT = { ok: 0, preflight: 3, token: 4, noAnswer: 5, pull: 6, rolledBack: 9, down: 10 } as const;

// ─── pure helpers (jobs/pms-update/update-stack.test.ts) ──────────────────────

/** An image ID as the log shows it: 12 characters, without "sha256:". */
export const short = (id: string): string => id.replace(/^sha256:/, '').slice(0, 12);

/** The number of sessions in a /status/sessions body; null when it is not one. */
export function sessionCount(body: string): number | null {
  if (!body.includes('<MediaContainer')) return null;
  // sed's greedy `.*<MediaContainer[^>]*[[:space:]]size="\([0-9]*\)".*`: the
  // first line that matches, and on it the last MediaContainer.
  for (const line of body.split('\n')) {
    const m = /.*<MediaContainer[^>]*\ssize="([0-9]*)"/.exec(line);
    if (m) return m[1] === '' ? null : Number(m[1]);
  }
  return null;
}

/** machineIdentifier from an /identity body; "" when there is none. */
export function identityOf(body: string): string {
  for (const line of body.split('\n')) {
    const m = /.*machineIdentifier="([^"]*)"/.exec(line);
    if (m) return m[1] ?? '';
  }
  return '';
}

/** The server version from an /identity body (not the XML's or the API's); "" when there is none. */
export function versionOf(body: string): string {
  for (const line of body.split('\n')) {
    const m = /.*<MediaContainer[^>]*\sversion="([^"]*)"/.exec(line);
    if (m) return m[1] ?? '';
  }
  return '';
}

// ─── per-service hooks ────────────────────────────────────────────────────────

export interface Ctx {
  deps: Deps;
  dry: boolean;
  healthWaitMs: number;
  steadyMs: number;
  plexUrl: string;
  plexPrefs: string;
  plexTimeoutMs: number;
}

/**
 * What a service needs beyond the defaults (no gate, and "running steadily" as
 * health), keyed by its compose name. Adding a service is adding it to
 * UPDATE_SERVICES, plus hooks only if it needs them.
 */
export interface Hooks {
  /** 0 go ahead · 1 defer to next week · anything else: fail with that code. */
  gate?: (c: Ctx) => Promise<number>;
  /** Must be unchanged after the update; health waits for it. "" when unreadable. */
  identity?: (c: Ctx) => Promise<string>;
  /** Logged before and after. */
  version?: (c: Ctx) => Promise<string>;
}

/** An answer from Plex as `curl -sf` gives it: the body, or nothing on an error status. */
async function plexGet(c: Ctx, path: string, headers: Record<string, string> = {}) {
  const r = await c.deps.http(`${c.plexUrl}${path}`, { headers, timeoutMs: c.plexTimeoutMs });
  return { ...r, ok: r.status !== 0 && r.status < 400 };
}

// 0 clear · 1 someone is watching · 4 token missing/rejected · 5 no answer
async function gatePlex(c: Ctx): Promise<number> {
  const { log } = c.deps;
  // The server's own token, straight from its config: nothing to keep in sync,
  // and it is the admin token /status/sessions needs. Sent as a header, so it
  // never lands in a URL, a log line or `ps`.
  const token = readPlexToken(c.plexPrefs);
  if (token === '') {
    log(`plex: ERROR: no PlexOnlineToken in ${c.plexPrefs} — cannot tell whether anyone is streaming`);
    return EXIT.token;
  }
  const r = await plexGet(c, '/status/sessions', { 'X-Plex-Token': token });
  // Any error status, as curl -f's exit 22.
  if (r.status >= 400) {
    log('plex: ERROR: Plex rejected its own token');
    return EXIT.token;
  }
  // Only asked while the container is running, so silence is not "nothing to
  // interrupt" — it is not knowing, and guessing risks killing playback.
  if (r.status === 0) {
    log(`plex: ERROR: Plex is running but not answering (${r.error ?? 'no answer'})`);
    return EXIT.noAnswer;
  }
  const n = sessionCount(r.text);
  if (n === null) {
    log('plex: ERROR: unrecognised /status/sessions response');
    return EXIT.noAnswer;
  }
  if (n !== 0) {
    log(`plex: ${n} active session(s) — deferring to the next run.`);
    return 1;
  }
  return 0;
}

export const HOOKS: Readonly<Record<string, Hooks>> = {
  plex: {
    gate: gatePlex,
    // What must be unchanged after the update: the server identity. A container
    // that answers with a different one came up on a fresh config, which is not a
    // working update however healthy it looks.
    identity: async (c) => {
      const r = await plexGet(c, '/identity');
      return r.ok ? identityOf(r.text) : '';
    },
    version: async (c) => {
      const r = await plexGet(c, '/identity');
      return r.ok ? versionOf(r.text) : '';
    },
  },
};

// ─── docker ───────────────────────────────────────────────────────────────────

export interface Deps {
  run: Run;
  http: Http;
  /** Stamped lines: "[%F %T] …". */
  log: Log;
  /** docker's own output, passed through as the bash script let it. */
  stdout: Log;
  stderr: Log;
  sleep: (ms: number) => Promise<void>;
  /** Milliseconds, for the health deadline. */
  now: () => number;
  env: Env;
  repo: string;
  user: () => string;
}

type Shown = 'all' | 'stderr' | 'none';

/** docker in the repo, where compose.yaml is; its output shown or kept back as the bash did. */
async function docker(deps: Deps, args: readonly string[], shown: Shown = 'none') {
  const r = await deps.run(['docker', ...args], { cwd: deps.repo });
  const show = (text: string, to: Log) => text !== '' && to(text.replace(/\n$/, ''));
  if (shown === 'all') show(r.stdout, deps.stdout);
  if (shown !== 'none') show(r.stderr, deps.stderr);
  return { ok: r.code === 0, text: r.stdout.replace(/\n+$/, '') };
}

// Naming a service on the command line enables its profile, so these also work
// on a service a phase still keeps behind one.
const containerOf = async (d: Deps, svc: string) =>
  (await docker(d, ['compose', 'ps', '-q', svc])).text.split('\n')[0] ?? '';
const inspect = (d: Deps, fmt: string, id: string, shown: Shown = 'none') =>
  docker(d, ['inspect', '-f', fmt, id], shown);
const imageId = async (d: Deps, ref: string) => {
  const r = await docker(d, ['image', 'inspect', '-f', '{{.Id}}', ref]);
  return r.ok ? r.text : '';
};
const running = async (d: Deps, cid: string) => (await inspect(d, '{{.State.Running}}', cid)).text === 'true';
const startedAt = async (d: Deps, cid: string) => (await inspect(d, '{{.State.StartedAt}}', cid)).text;
const recreate = async (d: Deps, svc: string) => (await docker(d, ['compose', 'up', '-d', '--no-deps', svc], 'all')).ok;

// ─── health ───────────────────────────────────────────────────────────────────
// With an identity hook: up when it reports the identity from before. Without:
// up when the same container has run for STEADY_SECS without restarting.
// StartedAt, not "running" twice: a crash loop under restart: unless-stopped
// can be caught running at both looks, but never with the same start time.
async function waitHealthy(c: Ctx, svc: string, want: string): Promise<boolean> {
  const d = c.deps;
  const deadline = d.now() + c.healthWaitMs;
  const identity = HOOKS[svc]?.identity;
  while (d.now() < deadline) {
    const cid = await containerOf(d, svc);
    if (cid !== '' && (await running(d, cid))) {
      if (want !== '' && identity) {
        if ((await identity(c)) === want) return true;
      } else {
        const t0 = await startedAt(d, cid);
        await d.sleep(c.steadyMs);
        if ((await running(d, cid)) && (await startedAt(d, cid)) === t0) return true;
      }
    }
    await d.sleep(5000);
  }
  return false;
}

// ─── one service ──────────────────────────────────────────────────────────────
export async function updateOne(c: Ctx, svc: string): Promise<number> {
  const d = c.deps;
  const { log } = d;
  const hooks = HOOKS[svc] ?? {};

  const cid = await containerOf(d, svc);
  if (cid === '') {
    log(`${svc}: not running — skipping.`);
    return EXIT.ok;
  }
  const refR = await inspect(d, '{{.Config.Image}}', cid, 'stderr');
  const oldR = refR.ok ? await inspect(d, '{{.Image}}', cid, 'stderr') : refR;
  if (!refR.ok || !oldR.ok) {
    log(`${svc}: ERROR: cannot inspect the running container`);
    return EXIT.preflight;
  }
  const ref = refR.text;
  const old = oldR.text;
  log(`${svc}: running ${short(old)} (${ref})`);

  if (!(await docker(d, ['compose', 'pull', '-q', svc], 'all')).ok) {
    log(`${svc}: ERROR: pull failed`);
    return EXIT.pull;
  }
  const next = await imageId(d, ref);
  if (next === '' || next === old) {
    log(`${svc}: already current — nothing to do.`);
    return EXIT.ok;
  }
  log(`${svc}: new image ${short(next)}`);

  if (hooks.gate) {
    const rc = await hooks.gate(c);
    if (rc === 1) return EXIT.ok; // deferred; the pulled image waits for next week
    if (rc !== 0) return rc;
  }

  if (c.dry) {
    log(`${svc}: dry run — would recreate on ${short(next)}.`);
    return EXIT.ok;
  }

  let want = '';
  if (hooks.identity) {
    want = await hooks.identity(c);
    if (want === '') {
      log(`${svc}: ERROR: cannot read its identity before updating`);
      return EXIT.noAnswer;
    }
  }
  if (hooks.version) log(`${svc}: version before: ${await hooks.version(c)}`);

  log(`${svc}: recreating on ${short(next)}`);
  if ((await recreate(d, svc)) && (await waitHealthy(c, svc, want))) {
    if (hooks.version) log(`${svc}: version after:  ${await hooks.version(c)}`);
    log(`${svc}: updated.`);
    // Only this image, and only if nothing else still uses it: never a
    // blanket prune on a box with other work.
    await docker(d, ['image', 'rm', old]);
    return EXIT.ok;
  }

  const waitS = c.healthWaitMs / 1000;
  log(`${svc}: ERROR: not healthy within ${waitS}s on ${short(next)} — rolling back to ${short(old)}`);
  if ((await docker(d, ['tag', old, ref], 'all')).ok && (await recreate(d, svc)) && (await waitHealthy(c, svc, want))) {
    log(`${svc}: rolled back; ${short(old)} is serving. Next week's run will try ${short(next)} again.`);
    return EXIT.rolledBack;
  }
  log(`${svc}: ERROR: rollback failed — ${svc} is DOWN. See docs/updating.md.`);
  return EXIT.down;
}

// ─── main ─────────────────────────────────────────────────────────────────────

/** The reason the stack can't be updated from here, or null. */
async function preflight(d: Deps, appdata: string): Promise<string | null> {
  if (!(await docker(d, ['info'])).ok) return `docker is not reachable as ${d.user()}`;
  if (!existsSync(join(d.repo, '.env'))) return `${d.repo}/.env is missing`;
  if (!(await docker(d, ['compose', 'config', '-q'])).ok) return 'compose.yaml does not render';
  let isDir = false;
  try {
    isDir = statSync(appdata).isDirectory();
  } catch {
    isDir = false;
  }
  return isDir ? null : `${appdata} does not exist`;
}

/** Milliseconds from a number of seconds; unset or empty is the default, as `${X:-20}`. */
const secondsOr = (v: string | undefined, fallback: number): number => (v ? Number(v) : fallback) * 1000;

/** Seconds from the environment, else .env, else the default; as `${X:-$(env_get X)}`. */
const seconds = (d: Deps, key: string, fallback: number): number =>
  secondsOr(envGet(key, { repo: d.repo, env: d.env }), fallback);

const USAGE = 'usage: update-stack.sh [--dry-run] [service...]';

export async function main(argv: readonly string[], d: Deps): Promise<number> {
  const cli = parseCli(argv, { flags: ['--dry-run'], positionals: true, usage: USAGE });
  if (cli.help) {
    d.stdout(headerHelp(await Bun.file(import.meta.path).text()));
    return 0;
  }
  const { env } = d;
  const appdata = envGet('APPDATA', { repo: d.repo, env }) || '/opt/appdata';
  const dryRun = cli.flags['--dry-run'] ? '1' : env.DRY_RUN || '0';
  const services = cli.positionals.length
    ? cli.positionals
    : (envGet('UPDATE_SERVICES', { repo: d.repo, env }) || 'plex').split(/\s+/).filter(Boolean);
  const c: Ctx = {
    deps: d,
    dry: dryRun === '1',
    healthWaitMs: seconds(d, 'UPDATE_HEALTH_WAIT', 180),
    steadyMs: secondsOr(env.STEADY_SECS, 20),
    // Host-networked, so this is the real server, as it is for pms-local's scripts.
    plexUrl: env.PLEX_URL || 'http://127.0.0.1:32400',
    plexPrefs: env.PLEX_PREFS || plexPrefsPath(appdata),
    plexTimeoutMs: secondsOr(env.PLEX_TIMEOUT, 10),
  };

  const why = await preflight(d, appdata);
  if (why !== null) {
    d.stderr(why);
    return EXIT.preflight;
  }

  const lockPath = env.UPDATE_LOCK || join(appdata, '.update-stack.lock');
  let lock: Lock | null;
  try {
    lock = tryLock(lockPath);
  } catch {
    d.stderr(`cannot open ${lockPath}`);
    return EXIT.preflight;
  }
  if (lock === null) {
    d.log(`Another update holds ${lockPath} — exiting.`);
    return EXIT.ok;
  }

  try {
    d.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    d.log(`Services:   ${services.join(' ')}`);
    d.log(`Dry run:    ${dryRun}`);
    let worst = 0;
    for (const svc of services) worst = Math.max(worst, await updateOne(c, svc));
    return worst;
  } finally {
    lock.release();
  }
}

if (import.meta.main) {
  await runMain(() =>
    main(Bun.argv.slice(2), {
      run,
      http: makeHttp(),
      log: stamped(),
      stdout: out,
      stderr: err,
      sleep: (ms) => Bun.sleep(ms),
      now: () => performance.now(),
      env: process.env,
      repo: resolve(import.meta.dir, '../..'),
      user: () => userInfo().username,
    }),
  );
}
