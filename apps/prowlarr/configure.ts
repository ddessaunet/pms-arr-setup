// apps/prowlarr/configure.ts — apply Prowlarr's settings through its API, then read
// them back and test every indexer. Idempotent: re-running changes nothing.
//
//   apps/prowlarr/configure.sh            apply login, FlareSolverr, indexers, apps; sync; verify
//   apps/prowlarr/configure.sh --check    read back and test only; changes nothing
//
// Normally run as `task prowlarr:configure` / `prowlarr:check`.
//
// The API key is not set here: compose passes PROWLARR_API_KEY from .env as
// PROWLARR__AUTH__APIKEY, so it is fixed before the first start and Radarr and
// Sonarr (Phase 4) can use it without anyone copying it out of the UI. The auth
// method (forms, not required from local addresses) comes the same way.
//
// The indexers live below as data. Public trackers come and go: a dead one is
// reported as FAILING, not treated as a configuration error.
//
// Exit: 0 applied and verified (or no drift; FAILING indexers only warn) ·
// 1 drift, or a step failed · 2 usage · 3 unreachable or not configured.

import { hostname } from 'node:os';
import { resolve } from 'node:path';
import type { components } from '../../stack/lib/api/prowlarr.d.ts';
import { headerHelp, parseCli } from '../../stack/lib/cli.ts';
import { envGet, envSeconds, type Env } from '../../stack/lib/env.ts';
import { runMain } from '../../stack/lib/exit.ts';
import { httpCode, makeHttp, type Http } from '../../stack/lib/http.ts';
import { err, out, type Log } from '../../stack/lib/log.ts';
import { lanIps } from '../../stack/lib/net.ts';
import { apiError, servarr, splitHosts, type JsonObject, type Servarr } from '../../stack/lib/servarr.ts';

type Schemas = components['schemas'];
export type Indexer = Schemas['IndexerResource'];
export type AppProfile = Schemas['AppProfileResource'];
export type IndexerProxy = Schemas['IndexerProxyResource'];
type Tag = Schemas['TagResource'];
type Command = Schemas['CommandResource'];

// ─── the settings ─────────────────────────────────────────────────────────────

/**
 * Which indexers, and how each is reached. "flare" sends it through
 * FlareSolverr (via the `flare` tag); keep it to the ones Cloudflare actually
 * blocks, since each search through it costs a headless Chromium and ~15 s.
 * Measured 2026-09-29: 1337x and EZTV each pass once, are then challenged
 * ("blocked by CloudFlare Protection"), and pass through FlareSolverr — both
 * definitions carry a FlareSolverr note. The rest pass direct. Flip an entry to
 * "flare" if its test starts failing on a Cloudflare challenge.
 */
export const INDEXERS: readonly { definition: string; route: 'flare' | 'direct' }[] = [
  { definition: '1337x', route: 'flare' },
  { definition: 'thepiratebay', route: 'direct' },
  { definition: 'limetorrents', route: 'direct' },
  { definition: 'Knaben', route: 'direct' },
  { definition: 'yts', route: 'direct' },
  { definition: 'eztv', route: 'flare' },
];

export const FLARE_TAG = 'flare';

/**
 * Releases with fewer seeders are never grabbed. Set on the sync profile every
 * indexer uses, and pushed from there to each Radarr/Sonarr indexer as its
 * "Minimum Seeders" — so it is owned here, not in arr-configure.sh. 5 drops the
 * dead 1-4-seed releases a public tracker lists; above it, the apps already
 * prefer more seeders when quality and score tie, and a higher floor would
 * starve older TV episodes.
 */
export const MIN_SEEDERS = 5;

/**
 * Applications Prowlarr pushes its indexers to (full sync). Each is applied only
 * when its key is set, so Prowlarr on its own (Phase 3) still configures
 * cleanly. URLs are container names on the arr network; the <SERVICE>_APP_URL
 * overrides exist for rehearsing against throwaway containers.
 */
export const APPLICATIONS: readonly { implementation: string; service: string; port: number; keyEnv: string }[] = [
  { implementation: 'Radarr', service: 'radarr', port: 7878, keyEnv: 'RADARR_API_KEY' },
  { implementation: 'Sonarr', service: 'sonarr', port: 8989, keyEnv: 'SONARR_API_KEY' },
];

// ─── pure helpers (apps/prowlarr/configure.test.ts) ──────────────────────────

const sorted = (a: readonly number[]) => [...a].sort((x, y) => x - y);
const sortedEqual = (a: readonly number[], b: readonly number[]) => {
  const [x, y] = [sorted(a), sorted(b)];
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/** A new indexer from its schema entry. */
export function indexerNew(schema: Indexer, appProfileId: number | null, tags: number[]): Indexer {
  return { ...schema, enable: true, appProfileId: appProfileId as number, tags };
}

/** An existing indexer brought to what we want. */
export function indexerFix(ix: Indexer, tags: number[]): Indexer {
  return { ...ix, enable: true, tags };
}

/** Disabled, or tags other than these (in any order). */
export function indexerDiffers(ix: Indexer, tags: readonly number[]): boolean {
  return ix.enable !== true || !Array.isArray(ix.tags) || !sortedEqual(ix.tags, tags);
}

/** The sync profile brought to MIN_SEEDERS. */
export function syncprofileFix(p: AppProfile, minSeeders: number): AppProfile {
  return { ...p, minimumSeeders: minSeeders };
}
export const syncprofileDiffers = (p: AppProfile, minSeeders: number) => p.minimumSeeders !== minSeeders;

const hostOf = (proxy: IndexerProxy) => proxy.fields?.find((f) => f.name === 'host')?.value;

/** Another FlareSolverr host, or tags other than exactly [tagId]. */
export function proxyDiffers(proxy: IndexerProxy, host: string, tagId: number): boolean {
  return hostOf(proxy) !== host || !(proxy.tags?.length === 1 && proxy.tags[0] === tagId);
}

/** The proxy with our host and tag in. */
export function proxyWant(base: IndexerProxy, host: string, tagId: number): IndexerProxy {
  return {
    ...base,
    tags: [tagId],
    fields: base.fields?.map((f) => (f.name === 'host' ? { ...f, value: host } : f)) ?? null,
  };
}

/** An application's base URL: <SERVICE>_APP_URL, or its container name and port. */
export function appUrl(app: (typeof APPLICATIONS)[number], env: Env): string {
  return env[`${app.service.toUpperCase()}_APP_URL`] || `http://${app.service}:${app.port}`;
}

const tagsFor = (route: string, flareId: number | undefined) =>
  route === 'flare' && flareId !== undefined ? [flareId] : [];
const first = <T>(list: unknown, pick: (x: T) => boolean): T | undefined =>
  (Array.isArray(list) ? (list as T[]) : []).find(pick);
const str = (v: unknown) => String(v ?? null);

// ─── main ─────────────────────────────────────────────────────────────────────

export interface Deps {
  http: Http;
  log: Log;
  err: Log;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  hostname: () => string;
  lanIps: () => string[];
  env: Env;
  /** The tree whose .env holds the keys and the login: the install, or a source. */
  repo: string;
}

interface Ctx {
  px: Servarr;
  log: Log;
  env: Env;
  repo: string;
  flareUrl: string;
  selfUrl: string;
  waitMs: number;
  sleep: Deps['sleep'];
  now: Deps['now'];
  keyOf: (app: (typeof APPLICATIONS)[number]) => string;
}

const appTop = (app: (typeof APPLICATIONS)[number]): JsonObject => ({
  name: app.implementation,
  syncLevel: 'fullSync',
});
const appFields = (c: Ctx, app: (typeof APPLICATIONS)[number]): JsonObject => ({
  prowlarrUrl: c.selfUrl,
  baseUrl: appUrl(app, c.env),
});

/** The `flare` tag (Prowlarr answers an existing label with it) and the FlareSolverr proxy. */
async function applyFlare(c: Ctx): Promise<number | undefined> {
  const { px, log } = c;
  const tag = await px.api('POST', '/tag', { label: FLARE_TAG });
  const flareId = (tag.json as Tag | undefined)?.id;
  if (!tag.ok || typeof flareId !== 'number') {
    log(`  FAIL  tag (HTTP ${httpCode(tag.status)})`);
    return undefined;
  }
  const proxies = await px.get('/indexerProxy');
  if (!proxies.ok) {
    log(`  FAIL  read proxies (HTTP ${httpCode(proxies.status)})`);
    return undefined;
  }
  const cur = first<IndexerProxy>(proxies.json, (p) => p.implementation === 'FlareSolverr');
  if (!cur) {
    const schemas = await px.get('/indexerProxy/schema');
    const schema = first<IndexerProxy>(schemas.json, (p) => p.implementation === 'FlareSolverr');
    if (!schemas.ok || !schema) {
      log(`  FAIL  proxy schema (HTTP ${httpCode(schemas.status)})`);
      return undefined;
    }
    const add = await px.api('POST', '/indexerProxy', {
      ...proxyWant(schema, c.flareUrl, flareId),
      name: 'FlareSolverr',
    });
    if (!add.ok) {
      log(`  FAIL  add FlareSolverr proxy (HTTP ${httpCode(add.status)}): ${apiError(add.text)}`);
      return undefined;
    }
    log(`  FlareSolverr proxy added (${c.flareUrl}, tag ${FLARE_TAG})`);
  } else if (proxyDiffers(cur, c.flareUrl, flareId)) {
    const put = await px.api('PUT', `/indexerProxy/${str(cur.id)}`, proxyWant(cur, c.flareUrl, flareId));
    if (!put.ok) {
      log(`  FAIL  update FlareSolverr proxy (HTTP ${httpCode(put.status)})`);
      return undefined;
    }
    log('  FlareSolverr proxy updated');
  } else log('  FlareSolverr proxy already set');
  return flareId;
}

/** The one sync profile (Prowlarr's "Standard"); every indexer gets the first one, so it holds MIN_SEEDERS. */
async function applySyncprofile(c: Ctx): Promise<boolean> {
  const { px, log } = c;
  const r = await px.get('/appprofile');
  if (!r.ok) {
    log(`  FAIL  read sync profiles (HTTP ${httpCode(r.status)})`);
    return false;
  }
  const cur = (Array.isArray(r.json) ? r.json[0] : undefined) as AppProfile | undefined;
  if (!cur) {
    log('  FAIL  no sync profile in Prowlarr');
    return false;
  }
  if (!syncprofileDiffers(cur, MIN_SEEDERS)) {
    log(`  sync profile ${str(cur.name)} already at minimum seeders ${MIN_SEEDERS}`);
    return true;
  }
  const put = await px.api('PUT', `/appprofile/${str(cur.id)}`, syncprofileFix(cur, MIN_SEEDERS));
  if (!put.ok) {
    log(`  FAIL  sync profile (HTTP ${httpCode(put.status)}): ${apiError(put.text)}`);
    return false;
  }
  log(`  sync profile ${str(cur.name)}: minimum seeders ${str(cur.minimumSeeders)} → ${MIN_SEEDERS}`);
  return true;
}

async function applyIndexers(c: Ctx, flareId: number): Promise<boolean> {
  const { px, log } = c;
  const schema = await px.get('/indexer/schema');
  if (!schema.ok) {
    log(`  FAIL  indexer schema (HTTP ${httpCode(schema.status)})`);
    return false;
  }
  const existing = await px.get('/indexer');
  if (!existing.ok) {
    log(`  FAIL  read indexers (HTTP ${httpCode(existing.status)})`);
    return false;
  }
  const profiles = await px.get('/appprofile');
  if (!profiles.ok) {
    log(`  FAIL  app profiles (HTTP ${httpCode(profiles.status)})`);
    return false;
  }
  const profileId =
    (Array.isArray(profiles.json) ? (profiles.json[0] as AppProfile | undefined)?.id : undefined) ?? null;

  for (const { definition, route } of INDEXERS) {
    const tags = tagsFor(route, flareId);
    const cur = first<Indexer>(existing.json, (x) => x.definitionName === definition);
    if (!cur) {
      const s = first<Indexer>(schema.json, (x) => x.definitionName === definition);
      if (!s) {
        log(`  FAIL  ${definition}: no such indexer definition in Prowlarr`);
        return false;
      }
      const add = await px.api('POST', '/indexer', indexerNew(s, profileId, tags));
      if (!add.ok) {
        log(`  FAIL  add ${definition} (HTTP ${httpCode(add.status)}): ${apiError(add.text)}`);
        return false;
      }
      log(`  ${definition} added (${route})`);
    } else if (indexerDiffers(cur, tags)) {
      const put = await px.api('PUT', `/indexer/${str(cur.id)}`, indexerFix(cur, tags));
      if (!put.ok) {
        log(`  FAIL  update ${definition} (HTTP ${httpCode(put.status)})`);
        return false;
      }
      log(`  ${definition} updated (${route})`);
    } else log(`  ${definition} already set (${route})`);
  }
  return true;
}

async function applyApplications(c: Ctx): Promise<boolean> {
  for (const app of APPLICATIONS) {
    const key = c.keyOf(app);
    if (!key) {
      c.log(`  ${app.implementation}: no API key in .env — skipped`);
      continue;
    }
    const ok = await c.px.applyResource({
      label: `application ${app.implementation}`,
      endpoint: 'applications',
      implementation: app.implementation,
      top: appTop(app),
      fields: appFields(c, app),
      secretName: 'apiKey',
      secret: key,
    });
    if (!ok) return false;
  }
  return true;
}

/**
 * A full push to every application. Editing the sync profile does NOT push by
 * itself (checked on Prowlarr 2.x: Radarr kept 1 until this ran), and a push that
 * times out while an indexer is added is not retried — Sonarr once lost 1337x
 * that way. Unchanged indexers are left alone, so running it every time is safe.
 */
async function applySync(c: Ctx): Promise<boolean> {
  const { px, log } = c;
  const deadline = c.now() + c.waitMs;
  const start = await px.api('POST', '/command', { name: 'ApplicationIndexerSync' });
  if (!start.ok) {
    log(`  FAIL  start the indexer sync (HTTP ${httpCode(start.status)})`);
    return false;
  }
  const id = str((start.json as Command | undefined)?.id);
  for (;;) {
    const r = await px.get(`/command/${id}`);
    if (!r.ok) {
      log(`  FAIL  read the indexer sync (HTTP ${httpCode(r.status)})`);
      return false;
    }
    const cmd = r.json as Command | undefined;
    const status = str(cmd?.status);
    if (status === 'completed') {
      log('  indexers synced to the applications');
      return true;
    }
    if (['failed', 'aborted', 'cancelled', 'orphaned'].includes(status)) {
      log(`  FAIL  indexer sync ${status}: ${(cmd?.message ?? '').slice(0, 160)}`);
      return false;
    }
    if (c.now() >= deadline) {
      log(`  FAIL  indexer sync still ${status} after ${c.waitMs / 1000}s`);
      return false;
    }
    await c.sleep(2000);
  }
}

/** Drift fails; an indexer failing its own test only warns — trackers go down. */
async function verify(c: Ctx): Promise<boolean> {
  const { px, log } = c;
  let ok = await px.verifyHost();

  for (const app of APPLICATIONS) {
    if (!c.keyOf(app)) continue;
    const v = await px.verifyResource({
      label: `application ${app.implementation}`,
      endpoint: 'applications',
      implementation: app.implementation,
      top: appTop(app),
      fields: appFields(c, app),
    });
    ok &&= v;
  }

  const profiles = await px.get('/appprofile');
  if (!profiles.ok) {
    log('  FAIL  read sync profiles');
    return false;
  }
  const sp = (Array.isArray(profiles.json) ? profiles.json[0] : undefined) as AppProfile | undefined;
  if (!sp) {
    log('  DRIFT    no sync profile');
    ok = false;
  } else if (syncprofileDiffers(sp, MIN_SEEDERS)) {
    log(`  DRIFT    sync profile ${str(sp.name)}: minimum seeders ${str(sp.minimumSeeders)}, want ${MIN_SEEDERS}`);
    ok = false;
  } else log(`  ok       sync profile ${str(sp.name)}: minimum seeders ${MIN_SEEDERS}`);

  const tags = await px.get('/tag');
  if (!tags.ok) {
    log('  FAIL  read tags');
    return false;
  }
  const flareId = first<Tag>(tags.json, (t) => t.label === FLARE_TAG)?.id;
  const proxies = await px.get('/indexerProxy');
  if (!proxies.ok) {
    log('  FAIL  read proxies');
    return false;
  }
  const proxy = first<IndexerProxy>(proxies.json, (p) => p.implementation === 'FlareSolverr');
  if (flareId !== undefined && proxy && !proxyDiffers(proxy, c.flareUrl, flareId)) {
    const t = await px.api('POST', '/indexerProxy/test', proxy);
    if (t.ok) log(`  ok       FlareSolverr proxy ${c.flareUrl} answers`);
    else log(`  WARN     FlareSolverr proxy set, but its test fails (HTTP ${httpCode(t.status)})`);
  } else {
    log(`  DRIFT    FlareSolverr proxy or '${FLARE_TAG}' tag missing or changed`);
    ok = false;
  }

  const existing = await px.get('/indexer');
  if (!existing.ok) {
    log('  FAIL  read indexers');
    return false;
  }
  for (const { definition, route } of INDEXERS) {
    const ix = first<Indexer>(existing.json, (x) => x.definitionName === definition);
    if (!ix) {
      log(`  DRIFT    ${definition} missing`);
      ok = false;
      continue;
    }
    const name = str(ix.name);
    if (indexerDiffers(ix, tagsFor(route, flareId))) {
      log(`  DRIFT    ${name} disabled or tags changed (want ${route})`);
      ok = false;
      continue;
    }
    const t = await px.api('POST', '/indexer/test', ix);
    if (t.ok) log(`  ok       ${name} (${route}) — test passes`);
    else log(`  FAILING  ${name} (${route}) — test fails: ${apiError(t.text).slice(0, 120)}`);
  }
  return ok;
}

export async function main(argv: readonly string[], deps: Deps): Promise<number> {
  const { env, log, repo } = deps;
  const cli = parseCli(argv, { flags: ['--check'], usage: 'usage: configure.sh [--check]' });
  if (cli.help) {
    log(headerHelp(await Bun.file(import.meta.path).text()));
    return 0;
  }
  const mode = cli.flags['--check'] ? 'check' : 'apply';

  const get = (k: string) => envGet(k, { repo, env });
  const url = env.PROWLARR_URL || 'http://127.0.0.1:9696';
  const key = get('PROWLARR_API_KEY');
  const user = get('PROWLARR_USER');
  const pass = get('PROWLARR_PASS');
  const missing = Object.entries({ PROWLARR_API_KEY: key, PROWLARR_USER: user, PROWLARR_PASS: pass })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    deps.err(`Set ${missing.join(' ')} in ${repo}/.env.`);
    return 3;
  }
  // Adding or testing an indexer makes Prowlarr fetch the site first; through
  // FlareSolverr that alone is ~15-20 s, and a slow tracker adds to it.
  const timeoutMs = envSeconds(env, 'PROWLARR_TIMEOUT', 120);
  const waitMs = envSeconds(env, 'PROWLARR_WAIT', 90);

  // The last answer, as bash's $HTTP and $BODY: what waitReady saw.
  let last = { status: 0, text: '' };
  const http: Http = async (u, req) => {
    const r = await deps.http(u, req);
    last = r;
    return r;
  };
  const px = servarr(
    {
      name: 'prowlarr',
      url,
      key,
      api: 'v1',
      user,
      pass,
      timeoutMs,
      waitMs,
      extraHosts: splitHosts(env.ALLOWED_HOSTS_EXTRA),
    },
    { http, log, sleep: deps.sleep, now: deps.now, hostname: deps.hostname, lanIps: deps.lanIps },
  );
  const c: Ctx = {
    px,
    log,
    env,
    repo,
    flareUrl: env.FLARESOLVERR_URL || 'http://flaresolverr:8191/',
    selfUrl: env.PROWLARR_SELF_URL || 'http://prowlarr:9696',
    waitMs,
    sleep: deps.sleep,
    now: deps.now,
    keyOf: (app) => get(app.keyEnv),
  };

  log(`Prowlarr at ${url} (${mode})`);
  if (!(await px.waitReady())) {
    log(
      `  FAIL  not answering with PROWLARR_API_KEY (HTTP ${httpCode(last.status)}) — is it running, and started with this key?`,
    );
    return 3;
  }
  // As `jq -r .version`: "null" when it has none, nothing when it is not JSON.
  let up = '';
  try {
    up = str((JSON.parse(last.text) as { version?: unknown } | null)?.version);
  } catch {
    up = '';
  }
  log(`  API up: ${up}`);

  if (mode === 'apply') {
    if (!(await px.applyHost())) return 1;
    const flareId = await applyFlare(c);
    if (flareId === undefined) return 1;
    if (!(await applySyncprofile(c))) return 1;
    if (!(await applyIndexers(c, flareId))) return 1;
    if (!(await applyApplications(c))) return 1;
    if (!(await applySync(c))) return 1;
  }

  log('Read-back:');
  if (await verify(c)) {
    log('No drift.');
    return 0;
  }
  if (mode === 'check') log('To apply: task prowlarr:configure');
  return 1;
}

if (import.meta.main) {
  await runMain(() =>
    main(Bun.argv.slice(2), {
      http: makeHttp(),
      log: out,
      err,
      sleep: (ms) => Bun.sleep(ms),
      now: () => Date.now(),
      hostname,
      lanIps: () => lanIps(),
      env: process.env,
      repo: resolve(import.meta.dir, '../..'),
    }),
  );
}
