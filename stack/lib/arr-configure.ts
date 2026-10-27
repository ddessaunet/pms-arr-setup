// stack/lib/arr-configure.ts — apply Radarr's and Sonarr's settings through their APIs,
// then read them back and test the connections. Idempotent.
//
//   stack/lib/arr-configure.sh [radarr|sonarr|all]            apply, then verify
//   stack/lib/arr-configure.sh [radarr|sonarr|all] --check    verify only; changes nothing
//
// Normally run as `task arr:configure` / `task arr:check`, or one app through
// apps/radarr/configure.sh and apps/sonarr/configure.sh.
//
// The API keys are not set here: compose passes RADARR_API_KEY / SONARR_API_KEY
// from .env as <APP>__AUTH__APIKEY, so they are fixed before the first start and
// Prowlarr can push indexers to both (apps/prowlarr/configure.ts, APPLICATIONS).
// Indexers are therefore NOT managed here.
//
// What the apps are held to — default profiles, upgrades, no Remux, size caps —
// is stack/lib/arr-policy.ts, which the docs site reads too.
//
// What this deliberately never does: import or rename media. Renaming below
// applies to each new import.
//
// Exit: 0 applied and verified (or no drift; a FAILING connection test only
// warns) · 1 drift, or a step failed · 2 usage · 3 unreachable/not configured.

import { hostname } from 'node:os';
import { resolve } from 'node:path';
import type { components as RadarrApi } from './api/radarr.d.ts';
import {
  APPS,
  DEFAULT_PROFILE,
  remuxFreeProfiles,
  resolutionOf,
  SIZE_CAPS,
  UPGRADE_PROFILES,
  type App,
  type SizeCap,
} from './arr-policy.ts';
import { headerHelp, parseCli } from './cli.ts';
import { envGet, envSeconds, type Env } from './env.ts';
import { runMain, UsageError } from './exit.ts';
import { httpCode, makeHttp, type Http } from './http.ts';
import { err, out, type Log } from './log.ts';
import { lanIps } from './net.ts';
import { apiError, hostDrift, servarr, splitHosts, type JsonObject, type Servarr } from './servarr.ts';

// Radarr's and Sonarr's resources are the same shape for what this reads.
type Schemas = RadarrApi['schemas'];
export type QualityDefinition = Schemas['QualityDefinitionResource'];
export type QualityProfile = Schemas['QualityProfileResource'];
type RootFolder = Schemas['RootFolderResource'];
type Indexer = Schemas['IndexerResource'];

// ─── the settings ─────────────────────────────────────────────────────────────

/** Per app: port and root folder. */
export const PORT: Readonly<Record<App, number>> = { radarr: 7878, sonarr: 8989 };
export const ROOT: Readonly<Record<App, string>> = {
  radarr: '/mnt/data/streaming/movies',
  sonarr: '/mnt/data/streaming/series',
};
const KEY_VAR: Readonly<Record<App, string>> = { radarr: 'RADARR_API_KEY', sonarr: 'SONARR_API_KEY' };

/** RADARR_URL / SONARR_URL from the environment, else this host. */
export const appUrl = (app: App, env: Env): string =>
  env[`${app.toUpperCase()}_URL`] || `http://127.0.0.1:${PORT[app]}`;

/** Plex-friendly names for new imports. Existing files are never renamed. */
export function wantNaming(app: App): JsonObject {
  return app === 'radarr'
    ? {
        renameMovies: true,
        movieFolderFormat: '{Movie Title} ({Release Year})',
        standardMovieFormat: '{Movie Title} ({Release Year})',
      }
    : {
        renameEpisodes: true,
        seriesFolderFormat: '{Series Title}',
        seasonFolderFormat: 'Season {season:00}',
        standardEpisodeFormat: '{Series Title} - S{season:00}E{episode:00}',
      };
}

/**
 * recycleBin empty: a recycle is a MOVE under streaming/, which pms-local's
 * plex-watch reads as a deletion. Deleted-in-Plex media is unmonitored, never
 * re-grabbed. 10 GB floor: /mnt/data runs near full.
 */
export function wantMedia(app: App): JsonObject {
  const unmon =
    app === 'radarr' ? 'autoUnmonitorPreviouslyDownloadedMovies' : 'autoUnmonitorPreviouslyDownloadedEpisodes';
  return {
    copyUsingHardlinks: true,
    recycleBin: '',
    deleteEmptyFolders: false,
    importExtraFiles: true,
    extraFileExtensions: 'srt',
    minimumFreeSpaceWhenImporting: 10000,
    [unmon]: true,
  };
}

/**
 * The :8081 qBittorrent (Phase 2), one category per app. Remove Completed:
 * once qBittorrent stops a torrent at its seeding limit, the app removes it
 * with its data — the library keeps its own hardlink.
 */
export function wantClientFields(app: App, qbtUser: string): JsonObject {
  return {
    host: 'qbittorrent',
    port: 8081,
    useSsl: false,
    username: qbtUser,
    [app === 'radarr' ? 'movieCategory' : 'tvCategory']: app,
  };
}
export const wantClientTop = (): JsonObject => ({
  name: 'qBittorrent',
  enable: true,
  removeCompletedDownloads: true,
  removeFailedDownloads: true,
});

/** Plex on the host network, reached through the host gateway. */
export const wantPlexFields = (): JsonObject => ({
  host: 'host.docker.internal',
  port: 32400,
  useSsl: false,
  updateLibrary: true,
});
export function wantPlexTop(app: App): JsonObject {
  return app === 'radarr'
    ? {
        name: 'Plex',
        onDownload: true,
        onUpgrade: true,
        onRename: true,
        onMovieDelete: true,
        onMovieFileDelete: true,
        onMovieFileDeleteForUpgrade: true,
      }
    : {
        name: 'Plex',
        onDownload: true,
        onUpgrade: true,
        onRename: true,
        onImportComplete: true,
        onSeriesDelete: true,
        onEpisodeFileDelete: true,
        onEpisodeFileDeleteForUpgrade: true,
      };
}

// ─── pure helpers (stack/lib/arr-configure.test.ts) ──────────────────────────

/** jq -r's text of a value: a string as it is, null or missing as "null". */
const text = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v ?? null));

/**
 * Quality definitions whose caps differ from ours, returned already capped —
 * ready to PUT to /qualitydefinition/update. A missing size counts as null.
 */
export function sizesToFix(defs: readonly QualityDefinition[], caps: readonly SizeCap[]): QualityDefinition[] {
  const byQuality = new Map(caps.map((c) => [c.quality, c]));
  return defs.flatMap((d) => {
    const w = byQuality.get(d.title ?? '');
    if (!w || ((d.maxSize ?? null) === w.max && (d.preferredSize ?? null) === w.preferred)) return [];
    return [{ ...d, maxSize: w.max, preferredSize: w.preferred }];
  });
}

/** Profiles whose upgradeAllowed differs from what we want, already corrected: true for `allowed`, false for the rest. */
export function upgradesToFix(profiles: readonly QualityProfile[], allowed: readonly string[]): QualityProfile[] {
  return profiles.flatMap((p) => {
    const want = allowed.includes(p.name ?? '');
    return (p.upgradeAllowed ?? null) === want ? [] : [{ ...p, upgradeAllowed: want }];
  });
}

const isRemux = (o: Record<string, unknown>): boolean => {
  const name = (o.quality as { name?: unknown } | null | undefined)?.name;
  return typeof name === 'string' && name.includes('Remux');
};

/** A quality profile with every Remux quality disallowed, at any depth (groups included). */
export function profileWithoutRemux<T>(profile: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v === null || typeof v !== 'object') return v;
    const o = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return isRemux(o) ? { ...o, allowed: false } : o;
  };
  return walk(profile) as T;
}

/** Whether any Remux quality is allowed, at any depth. */
export function profileAllowsRemux(profile: unknown): boolean {
  if (Array.isArray(profile)) return profile.some(profileAllowsRemux);
  if (profile === null || typeof profile !== 'object') return false;
  const o = profile as Record<string, unknown>;
  return (o.allowed === true && isRemux(o)) || Object.values(o).some(profileAllowsRemux);
}

/**
 * The distinct "Minimum Seeders" of an /indexer list, e.g. "5" or "1,5" while a
 * Prowlarr sync is still on its way (MIN_SEEDERS, apps/prowlarr/configure.ts).
 */
export function indexerMinSeeders(indexers: readonly Indexer[]): string {
  const values = indexers.flatMap((ix) =>
    (ix.fields ?? [])
      .filter((f) => f.name === 'minimumSeeders')
      .map((f) => (f.value === undefined || f.value === null || f.value === false ? 'unset' : text(f.value))),
  );
  return [...new Set(values)].sort().join(',') || 'unset';
}

/**
 * "1080p 40/25, WEBDL-1080p 80/25, 2160p 200/100 MB/min" (or "1080p no max/25
 * MB/min") for the log: one cap per resolution, then each quality that differs.
 */
export function sizesSummary(caps: readonly SizeCap[]): string {
  const first = new Map<string, string>();
  const parts: string[] = [];
  for (const c of caps) {
    const r = resolutionOf(c.quality);
    const v = `${c.max === null ? 'no max' : c.max}/${c.preferred}`;
    if (!first.has(r)) {
      first.set(r, v);
      parts.push(`${r} ${v}`);
    } else if (first.get(r) !== v) parts.push(`${c.quality} ${v}`);
  }
  return `${parts.join(', ')} MB/min`;
}

/** "UHD Bluray + WEB, 4K HDR or 1080p", or "(none)". */
const listOrNone = (names: readonly string[]) => names.join(', ') || '(none)';

const hasRoot = (folders: readonly RootFolder[], root: string) =>
  folders.some((f) => f.path === root || f.path === `${root}/`);

// ─── one app ──────────────────────────────────────────────────────────────────

interface Ctx {
  app: App;
  px: Servarr;
  log: Log;
  sleep: (ms: number) => Promise<void>;
  sizeSettle: number;
  qbtUser: string;
  qbtPass: string;
  plexToken: string;
}

const asList = <T>(json: unknown): T[] => (Array.isArray(json) ? (json as T[]) : []);

async function applyConfig({ px, log }: Ctx, section: string, want: JsonObject): Promise<boolean> {
  const r = await px.get(`/config/${section}`);
  if (!r.ok) return (log(`  FAIL  read ${section} config (HTTP ${httpCode(r.status)})`), false);
  const cur = (r.json ?? {}) as Record<string, unknown>;
  const drift = hostDrift(cur, want);
  if (drift.length === 0) return (log(`  ${section} already set`), true);
  const w = await px.api('PUT', `/config/${section}/${text(cur.id)}`, { ...cur, ...want });
  if (!w.ok) return (log(`  FAIL  ${section} config (HTTP ${httpCode(w.status)}): ${apiError(w.text)}`), false);
  log(`  ${section} set (${drift.join(' ')})`);
  return true;
}

async function applyRoot({ app, px, log }: Ctx): Promise<boolean> {
  const root = ROOT[app];
  const r = await px.get('/rootfolder');
  if (!r.ok) return (log(`  FAIL  read root folders (HTTP ${httpCode(r.status)})`), false);
  if (hasRoot(asList<RootFolder>(r.json), root)) return (log(`  root folder ${root} already set`), true);
  const w = await px.api('POST', '/rootfolder', { path: root });
  if (!w.ok) return (log(`  FAIL  root folder ${root} (HTTP ${httpCode(w.status)}): ${apiError(w.text)}`), false);
  log(`  root folder ${root} added`);
  return true;
}

// Upgrades only where UPGRADE_PROFILES says (the two 4K movie profiles); an
// upgrade replaces a library file, so everything else stays single-grab.
async function applyProfiles({ app, px, log }: Ctx): Promise<boolean> {
  const r = await px.get('/qualityprofile');
  if (!r.ok) return (log(`  FAIL  read quality profiles (HTTP ${httpCode(r.status)})`), false);
  const fix = upgradesToFix(asList<QualityProfile>(r.json), UPGRADE_PROFILES[app]);
  for (const p of fix) {
    const w = await px.api('PUT', `/qualityprofile/${text(p.id)}`, p);
    if (!w.ok) return (log(`  FAIL  profile ${text(p.name)} (HTTP ${httpCode(w.status)})`), false);
    log(`  upgrades ${p.upgradeAllowed ? 'on' : 'off'} for ${text(p.name)}`);
  }
  if (fix.length === 0) log(`  upgrades already only on: ${listOrNone(UPGRADE_PROFILES[app])}`);
  return true;
}

/**
 * The capped definitions, each read by id. Radarr 6.4 reports quality sizes a
 * few seconds late after a write — both the list and by-id reads — which made
 * a successful update read back as DRIFT; verifySizes waits that out.
 */
async function cappedDefinitions({ app, px }: Ctx): Promise<{ defs?: QualityDefinition[]; status: number }> {
  const capped = SIZE_CAPS[app].map((c) => c.quality);
  const r = await px.get('/qualitydefinition');
  if (!r.ok) return { status: r.status };
  const defs: QualityDefinition[] = [];
  for (const d of asList<QualityDefinition>(r.json).filter((d) => capped.includes(d.title ?? ''))) {
    const one = await px.get(`/qualitydefinition/${text(d.id)}`);
    if (!one.ok) return { status: one.status };
    defs.push(one.json as QualityDefinition);
  }
  return { defs, status: r.status };
}

async function applySizes(c: Ctx): Promise<boolean> {
  const { app, px, log } = c;
  const caps = SIZE_CAPS[app];
  const { defs, status } = await cappedDefinitions(c);
  if (!defs) return (log(`  FAIL  read quality definitions (HTTP ${httpCode(status)})`), false);
  const fix = sizesToFix(defs, caps);
  if (fix.length === 0) return (log(`  sizes already capped (${sizesSummary(caps)})`), true);
  const w = await px.api('PUT', '/qualitydefinition/update', fix);
  if (!w.ok) return (log(`  FAIL  quality sizes (HTTP ${httpCode(w.status)}): ${apiError(w.text)}`), false);
  log(`  sizes capped: ${sizesSummary(caps)} (${fix.length} quality/ies changed)`);
  return true;
}

async function applyNoRemux({ px, log }: Ctx, name: string): Promise<boolean> {
  const r = await px.get('/qualityprofile');
  if (!r.ok) return (log(`  FAIL  read quality profiles (HTTP ${httpCode(r.status)})`), false);
  const p = asList<QualityProfile>(r.json).find((x) => x.name === name);
  // Recyclarr creates it; say so rather than fail the rest of the settings.
  if (!p) return (log(`  WARN  no '${name}' profile yet — run task recyclarr:sync first`), true);
  if (!profileAllowsRemux(p)) return (log(`  ${name} already without Remux`), true);
  const w = await px.api('PUT', `/qualityprofile/${text(p.id)}`, profileWithoutRemux(p));
  if (!w.ok) return (log(`  FAIL  ${name} profile (HTTP ${httpCode(w.status)}): ${apiError(w.text)}`), false);
  log(`  Remux removed from ${name}`);
  return true;
}

async function applyApp(c: Ctx): Promise<boolean> {
  const { app, px } = c;
  if (!(await px.applyHost())) return false;
  if (!(await applyConfig(c, 'naming', wantNaming(app)))) return false;
  if (!(await applyConfig(c, 'mediamanagement', wantMedia(app)))) return false;
  if (!(await applyRoot(c))) return false;
  if (!(await applyProfiles(c))) return false;
  for (const name of remuxFreeProfiles(app)) if (!(await applyNoRemux(c, name))) return false;
  if (!(await applySizes(c))) return false;
  if (
    !(await px.applyResource({
      label: 'download client',
      endpoint: 'downloadclient',
      implementation: 'QBittorrent',
      top: wantClientTop(),
      fields: wantClientFields(app, c.qbtUser),
      secretName: 'password',
      secret: c.qbtPass,
    }))
  )
    return false;
  return px.applyResource({
    label: 'Plex connection',
    endpoint: 'notification',
    implementation: 'PlexServer',
    top: wantPlexTop(app),
    fields: wantPlexFields(),
    secretName: 'authToken',
    secret: c.plexToken,
  });
}

async function verifyConfig({ px, log }: Ctx, section: string, want: JsonObject): Promise<boolean> {
  const r = await px.get(`/config/${section}`);
  if (!r.ok) return (log(`  FAIL  read ${section} config (HTTP ${httpCode(r.status)})`), false);
  const drift = hostDrift((r.json ?? {}) as Record<string, unknown>, want);
  if (drift.length === 0) return (log(`  ok       ${section}`), true);
  log(`  DRIFT    ${section}: ${drift.map((k) => `${k} `).join('')}`);
  return false;
}

// Up to SIZE_SETTLE reads, 2 s apart, before a difference counts as drift.
async function verifySizes(c: Ctx): Promise<boolean> {
  const caps = SIZE_CAPS[c.app];
  let n = 0;
  for (let tries = 1; ; tries++) {
    const { defs } = await cappedDefinitions(c);
    if (!defs) return (c.log('  FAIL  read quality definitions'), false);
    n = sizesToFix(defs, caps).length;
    if (n === 0) return (c.log(`  ok       sizes capped: ${sizesSummary(caps)}`), true);
    if (tries >= c.sizeSettle) break;
    await c.sleep(2000);
  }
  c.log(`  DRIFT    ${n} quality size(s) not capped (${sizesSummary(caps)})`);
  return false;
}

async function verifyApp(c: Ctx): Promise<boolean> {
  const { app, px, log } = c;
  let ok = true;
  if (!(await px.verifyHost())) ok = false;
  if (!(await verifyConfig(c, 'naming', wantNaming(app)))) ok = false;
  if (!(await verifyConfig(c, 'mediamanagement', wantMedia(app)))) ok = false;

  const root = ROOT[app];
  const rf = await px.get('/rootfolder');
  if (!rf.ok) return (log('  FAIL  read root folders'), false);
  if (hasRoot(asList<RootFolder>(rf.json), root)) log(`  ok       root folder ${root}`);
  else {
    log(`  DRIFT    root folder ${root} missing`);
    ok = false;
  }

  const qp = await px.get('/qualityprofile');
  if (!qp.ok) return (log('  FAIL  read quality profiles'), false);
  const profiles = asList<QualityProfile>(qp.json);
  const wrong = upgradesToFix(profiles, UPGRADE_PROFILES[app]);
  if (wrong.length === 0) log(`  ok       upgrades only on: ${listOrNone(UPGRADE_PROFILES[app])}`);
  else {
    log(
      `  DRIFT    ${wrong.length} profile(s) with upgrades set the wrong way: ${wrong.map((p) => text(p.name)).join(', ')}`,
    );
    ok = false;
  }

  for (const name of remuxFreeProfiles(app)) {
    const what = name === DEFAULT_PROFILE[app] ? `default profile '${name}'` : `profile '${name}'`;
    const p = profiles.find((x) => x.name === name);
    if (!p) {
      log(`  DRIFT    ${what} missing — task recyclarr:sync`);
      ok = false;
    } else if (profileAllowsRemux(p)) {
      log(`  DRIFT    '${name}' allows Remux`);
      ok = false;
    } else log(`  ok       ${what} exists, no Remux`);
  }

  if (!(await verifySizes(c))) ok = false;

  const client = {
    label: 'download client',
    endpoint: 'downloadclient',
    implementation: 'QBittorrent',
    top: wantClientTop(),
    fields: wantClientFields(app, c.qbtUser),
  };
  if (!(await px.verifyResource(client))) ok = false;
  const plex = {
    label: 'Plex connection',
    endpoint: 'notification',
    implementation: 'PlexServer',
    top: wantPlexTop(app),
    fields: wantPlexFields(),
  };
  if (!(await px.verifyResource(plex))) ok = false;

  // Pushed by Prowlarr, not by this script: only reported.
  const ix = await px.get('/indexer');
  if (!ix.ok) return (log('  FAIL  read indexers'), false);
  const indexers = asList<Indexer>(ix.json);
  if (indexers.length > 0)
    log(
      `  ok       ${indexers.length} indexer(s), synced from Prowlarr, minimum seeders ${indexerMinSeeders(indexers)}`,
    );
  else log('  WARN     no indexers yet — task prowlarr:configure pushes them');
  return ok;
}

// ─── main ─────────────────────────────────────────────────────────────────────

export interface Deps {
  http: Http;
  log: Log;
  /** Where the missing-.env errors go. */
  err: Log;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  hostname: () => string;
  lanIps: () => string[];
  env: Env;
  /** The tree whose .env holds the keys: the install, or a source. */
  repo: string;
}

const USAGE = 'usage: arr-configure.sh [radarr|sonarr|all] [--check]';

async function runApp(app: App, mode: 'apply' | 'check', deps: Deps): Promise<number> {
  const { env, log, repo } = deps;
  const get = (k: string) => envGet(k, { repo, env });
  const keyVar = KEY_VAR[app];
  const key = get(keyVar);
  if (!key) return (log(`${app}: ${keyVar} is not set in .env`), 3);
  const url = appUrl(app, env);

  // The last answer, as bash's $HTTP and $BODY: what waitReady saw.
  let last = { status: 0, text: '' };
  const http: Http = async (u, req) => {
    const r = await deps.http(u, req);
    last = r;
    return r;
  };
  const px = servarr(
    {
      name: app,
      url,
      key,
      api: 'v3',
      user: get('ARR_USER'),
      pass: get('ARR_PASS'),
      timeoutMs: envSeconds(env, 'ARR_TIMEOUT', 60),
      waitMs: envSeconds(env, 'ARR_WAIT', 90),
      extraHosts: splitHosts(env.ALLOWED_HOSTS_EXTRA),
    },
    { http, log, sleep: deps.sleep, now: deps.now, hostname: deps.hostname, lanIps: deps.lanIps },
  );
  const c: Ctx = {
    app,
    px,
    log,
    sleep: deps.sleep,
    sizeSettle: Number(env.SIZE_SETTLE) || 5,
    qbtUser: get('QBT_ARR_USER'),
    qbtPass: get('QBT_ARR_PASS'),
    plexToken: get('PLEX_TOKEN'),
  };

  log(`${app.charAt(0).toUpperCase()}${app.slice(1)} at ${url} (${mode})`);
  if (!(await px.waitReady())) {
    log(
      `  FAIL  not answering with ${keyVar} (HTTP ${httpCode(last.status)}) — is it running, and started with this key?`,
    );
    return 3;
  }
  // As `jq -r .version`: "null" when it has none, nothing when it is not JSON.
  let up = '';
  try {
    up = text((JSON.parse(last.text) as { version?: unknown } | null)?.version);
  } catch {
    up = '';
  }
  log(`  API up: ${up}`);
  if (mode === 'apply' && !(await applyApp(c))) return 1;
  log('Read-back:');
  if (!(await verifyApp(c))) return 1;
  log('No drift.');
  return 0;
}

export async function main(argv: readonly string[], deps: Deps): Promise<number> {
  const { env, log, repo } = deps;
  const cli = parseCli(argv, { flags: ['--check'], positionals: true, usage: USAGE });
  if (cli.help) {
    log(headerHelp(await Bun.file(import.meta.path).text()));
    return 0;
  }
  if (cli.positionals.some((p) => p !== 'all' && !(APPS as readonly string[]).includes(p))) throw new UsageError(USAGE);
  const target = cli.positionals.at(-1) ?? 'all';
  const mode = cli.flags['--check'] ? 'check' : 'apply';

  const required = ['ARR_USER', 'ARR_PASS', 'QBT_ARR_USER', 'QBT_ARR_PASS', 'PLEX_TOKEN'];
  const missing = required.filter((k) => !envGet(k, { repo, env }));
  if (missing.length > 0) {
    deps.err(`Set ${missing.join(' ')} in ${repo}/.env.`);
    return 3;
  }

  let worst = 0;
  for (const app of target === 'all' ? APPS : [target as App]) {
    worst = Math.max(worst, await runApp(app, mode, deps));
    log('');
  }
  if (worst === 1 && mode === 'check') log('To apply: task arr:configure');
  return worst;
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
