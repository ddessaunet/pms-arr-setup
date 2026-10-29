// jobs/stack-api/stack-api.ts — the docs site's backend: the Plex sign-in that
// gates the whole site, and the request doctor (requests.ts); later, control.
//
//   jobs/stack-api/stack-api.sh    serve until stopped (stack-api.service)
//
// It listens on a Unix socket, never a TCP port:
// /opt/appdata/stack-api/run/api.sock, which apps/docs mounts read-only at /api
// and nginx proxies /api/ to. nginx asks /api/auth/check before serving any
// page or /live/ file, so while this is down the site shows only its login
// page, which says so (the gate fails closed). The routes are in app.ts (the
// sign-in) and requests.ts (the request doctor), and what it keeps (sessions,
// pending PINs, the last release searches) in store.ts, next to the socket's
// folder: /opt/appdata/stack-api/stack-api.sqlite.
//
// Environment: APPDATA (else .env's, else /opt/appdata), STACK_API_SOCKET to
// listen elsewhere (a test, or a second copy by hand). Ask AI's, from the
// environment or .env (stack/lib/ai.ts): AI_MODELS, AI_MODEL, OLLAMA_URL,
// AI_MAX_PER_HOUR (default 20). Read at start: restart it after changing them.
//
// Exit: 0 stopped by SIGTERM/SIGINT · 2 usage · 3 cannot start (socket, store).

import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseModels, providerFor } from '../../stack/lib/ai.ts';
import { headerHelp, parseCli } from '../../stack/lib/cli.ts';
import { envGet, type Env } from '../../stack/lib/env.ts';
import { runMain } from '../../stack/lib/exit.ts';
import { makeHttp, type Http } from '../../stack/lib/http.ts';
import { stamped, type Log } from '../../stack/lib/log.ts';
import { PLEX_IDENTITY } from '../../stack/lib/plex.ts';
import { makeApp, PIN_TTL, RateLimit } from './app.ts';
import { addRequestRoutes } from './requests.ts';
import { Store } from './store.ts';

const USAGE = 'usage: stack-api.sh';
const PRUNE_EVERY = 3600_000; // ms
const AI_PER_HOUR = 20; // Ask AI answers an hour, unless AI_MAX_PER_HOUR says otherwise

export interface Deps {
  http: Http;
  log: Log;
  env: Env;
  /** The install: its .env. */
  repo: string;
  /** Resolves when the service should stop. */
  stopped: () => Promise<void>;
}

/** Where stack-api keeps its store, and the socket's folder (the one apps/docs mounts). */
export function paths(appdata: string, env: Env) {
  const dir = join(appdata, 'stack-api');
  const runDir = join(dir, 'run');
  return { dir, runDir, socket: env.STACK_API_SOCKET || join(runDir, 'api.sock'), db: join(dir, 'stack-api.sqlite') };
}

export async function main(argv: readonly string[], deps: Deps): Promise<number> {
  const cli = parseCli(argv, { flags: [], usage: USAGE });
  if (cli.help) {
    deps.log(headerHelp(await Bun.file(import.meta.path).text()));
    return 0;
  }
  const { log, env } = deps;
  const appdata = envGet('APPDATA', { repo: deps.repo, env }) || '/opt/appdata';
  const p = paths(appdata, env);

  let store: Store;
  try {
    mkdirSync(p.runDir, { recursive: true });
    // 755: the docs container (nginx, uid 101) must reach the socket inside.
    chmodSync(p.runDir, 0o755);
    store = new Store(p.db);
  } catch (e) {
    log(`cannot open ${p.db}: ${e instanceof Error ? e.message : String(e)}`);
    return 3;
  }

  const app = makeApp({
    http: deps.http,
    store,
    now: Date.now,
    log,
    serverId: PLEX_IDENTITY,
    random: (n) => new Uint8Array(randomBytes(n)),
  });
  const conf = (k: string) => envGet(k, { repo: deps.repo, env });
  const ai = parseModels(conf('AI_MODELS'), conf('AI_MODEL'));
  for (const w of ai.warnings) log(w);
  const perHour = Number(conf('AI_MAX_PER_HOUR'));
  const ollamaUrl = conf('OLLAMA_URL');
  log(
    ai.info
      ? `AI: ${ai.info.models.map((m) => m.id).join(', ')} (default ${ai.info.default}), at most ${perHour > 0 ? perHour : AI_PER_HOUR} an hour`
      : 'AI: off',
  );
  addRequestRoutes(app, {
    http: deps.http,
    store,
    now: Date.now,
    log,
    env,
    repo: deps.repo,
    appdata,
    analyses: new RateLimit(10, 3600_000),
    ai: ai.info,
    provider: (m) => providerFor(m, { http: deps.http, ollamaUrl }),
    advices: new RateLimit(perHour > 0 ? Math.floor(perHour) : AI_PER_HOUR, 3600_000),
  });

  // A socket left by a crash would make listen() fail.
  rmSync(p.socket, { force: true });
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ unix: p.socket, fetch: app.fetch });
    // 666: nginx runs as another user; the folder's 755 and the read-only
    // mount are what keep anyone from replacing it.
    chmodSync(p.socket, 0o666);
  } catch (e) {
    store.close();
    log(`cannot listen on ${p.socket}: ${e instanceof Error ? e.message : String(e)}`);
    return 3;
  }
  log(`listening on ${p.socket}`);

  store.prune(Date.now(), PIN_TTL);
  const pruner = setInterval(() => store.prune(Date.now(), PIN_TTL), PRUNE_EVERY);
  await deps.stopped();
  clearInterval(pruner);
  await server.stop();
  rmSync(p.socket, { force: true });
  store.close();
  log('stopped');
  return 0;
}

if (import.meta.main) {
  await runMain(() =>
    main(Bun.argv.slice(2), {
      http: makeHttp(),
      log: stamped('stack-api: '),
      env: process.env,
      repo: resolve(import.meta.dir, '../..'),
      stopped: () =>
        new Promise((done) => {
          process.once('SIGTERM', () => done());
          process.once('SIGINT', () => done());
        }),
    }),
  );
}
