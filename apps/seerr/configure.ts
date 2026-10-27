// apps/seerr/configure.ts — apply Seerr's settings through its API, then read them
// back and test the connections. Idempotent.
//
//   apps/seerr/configure.sh            apply, then verify
//   apps/seerr/configure.sh --check    verify only; changes nothing
//
// Normally run as `task seerr:configure` / `task seerr:check`.
//
// One step cannot be scripted: Seerr's first run needs you to sign in with Plex
// in a browser (OAuth). That creates the admin account the API key acts as —
// until then every settings call is 403, and this script says so and stops.
// Sign in, then run this; it does the rest of the setup wizard, including
// marking it finished.
//
// The API key is Seerr's own, generated on first start into
// $APPDATA/seerr/settings.json — nothing to put in .env. Radarr and Sonarr are
// reached with their .env keys.
//
// Requests from Seerr are ordinary Radarr/Sonarr adds, so everything Phases 4
// and 6 set up applies to them unchanged: the profiles below, hardlinked
// imports, unmonitor on delete, and arr-reclaim freeing the space of a Plex delete.
//
// Exit: 0 applied and verified (or no drift; a FAILING test only warns) ·
// 1 drift, or a step failed · 2 usage · 3 not reachable, or no admin yet.

import { join, resolve } from 'node:path';
import type { components } from '../../stack/lib/api/seerr.d.ts';
import { headerHelp, parseCli } from '../../stack/lib/cli.ts';
import { envGet, envSeconds, type Env } from '../../stack/lib/env.ts';
import { runMain } from '../../stack/lib/exit.ts';
import { httpCode, is2xx, jsonOf, makeHttp, type Http } from '../../stack/lib/http.ts';
import { readSeerrKey } from '../../stack/lib/keys.ts';
import { err, out, type Log } from '../../stack/lib/log.ts';
import { lanIps } from '../../stack/lib/net.ts';
import { apiError, hostDrift, type ApiResult, type JsonObject } from '../../stack/lib/servarr.ts';

type Schemas = components['schemas'];
type PlexSettings = Schemas['PlexSettings'];
type PlexLibrary = Schemas['PlexLibrary'];
type ServiceProfile = Schemas['ServiceProfile'];

// Writes send only the fields this repo owns: Seerr rejects read-only ones
// (id, machineId, name, libraries, apiKey of main…) with a 400 (trap 12).
export type PlexWrite = Pick<PlexSettings, 'ip' | 'port' | 'useSsl'>;
export type MainWrite = Pick<Schemas['MainSettings'], 'newPlexLogin'>;
export type RadarrWrite = Omit<Schemas['RadarrSettings'], 'id'>;
export type SonarrWrite = Omit<Schemas['SonarrSettings'], 'id'>;
export type ServerWrite = RadarrWrite | SonarrWrite;

export type App = 'radarr' | 'sonarr';
export const APPS: readonly App[] = ['radarr', 'sonarr'];

// ─── the settings ─────────────────────────────────────────────────────────────

/** Plex on the host network, through the host gateway. */
export const wantPlex = (): PlexWrite => ({ ip: 'host.docker.internal', port: 32400, useSsl: false });

/**
 * Libraries by NAME: Plex section ids differ between installs. "Other Videos"
 * stays off (not requestable); Plex photo libraries are never offered at all.
 */
export const LIBRARIES = ['Movies', 'TV Shows'] as const;

/** Only the admin (you) signs in; the admin's requests are auto-approved. */
export const wantMain = (): MainWrite => ({ newPlexLogin: false });

/**
 * The profile a request uses by default, per app — the ones Recyclarr creates
 * (apps/recyclarr/recyclarr.yml) and arr-configure.sh's default_profile names.
 * Movies are 4K HDR; series stay 1080p. For a film with no 4K HDR release, pick
 * "4K HDR or 1080p" in the request's options (admin): 1080p now, replaced by 4K
 * HDR when one appears. It stays opt-in, so it is never the default here.
 */
export const PROFILE_NAME: Readonly<Record<App, string>> = { radarr: 'UHD Bluray + WEB', sonarr: 'WEB-1080p' };

const SERVER: Readonly<Record<App, { port: number; root: string }>> = {
  radarr: { port: 7878, root: '/mnt/data/streaming/movies' },
  sonarr: { port: 8989, root: '/mnt/data/streaming/series' },
};

/**
 * One default, non-4K server per app. The profile id is taken from the app's
 * own test response, never assumed. lanIp is the host's LAN address, for the
 * "open in Radarr/Sonarr" links Seerr shows.
 */
export function wantServer(app: App, pid: number, apiKey: string, lanIp: string): ServerWrite {
  const { port, root } = SERVER[app];
  const pname = PROFILE_NAME[app];
  const base = {
    name: app.charAt(0).toUpperCase() + app.slice(1),
    hostname: app,
    port,
    apiKey,
    useSsl: false,
    baseUrl: '',
    activeProfileId: pid,
    activeProfileName: pname,
    activeDirectory: root,
    is4k: false,
    isDefault: true,
    externalUrl: `http://${lanIp}:${port}`,
    syncEnabled: false,
    preventSearch: false,
  };
  return app === 'radarr'
    ? { ...base, minimumAvailability: 'released' }
    : {
        ...base,
        activeAnimeProfileId: pid,
        activeAnimeProfileName: pname,
        activeAnimeDirectory: root,
        enableSeasonFolders: true,
      };
}

// ─── pure helpers (apps/seerr/configure.test.ts) ─────────────────────────────

/** The id of a quality profile by name, from a /settings/<app>/test response; undefined when absent. */
export function profileId(test: unknown, name: string): number | undefined {
  const profiles = (test as { profiles?: unknown } | null | undefined)?.profiles;
  if (!Array.isArray(profiles)) return undefined;
  const id = (profiles as ServiceProfile[]).find((p) => p?.name === name)?.id;
  return typeof id === 'number' ? id : undefined;
}

/** Keys of want that differ in got, ignoring the API key (compared by the test). */
export function serverDrift(got: Readonly<Record<string, unknown>>, want: ServerWrite): string[] {
  const { apiKey: _, ...rest } = want;
  return hostDrift(got, rest as JsonObject);
}

/** Library names enabled in a /settings/plex/library response, sorted. */
export function enabledLibraries(libs: unknown): string[] {
  if (!Array.isArray(libs)) return [];
  return (libs as PlexLibrary[])
    .filter((l) => l?.enabled === true)
    .map((l) => l.name)
    .sort();
}
export const wantedLibraries = (): string[] => [...LIBRARIES].sort();

/** The non-4K server in a /settings/<app> response; undefined when there is none. */
export function defaultServer(list: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(list)) return undefined;
  return (list as Record<string, unknown>[]).find((s) => s?.is4k === false);
}

/**
 * The message of a failed call, for the log. Seerr answers {message}; the
 * Servarr-style list is kept for what it relays from Radarr/Sonarr. (The bash
 * api_error's jq stopped at `.[0]` of an object, so it never showed Seerr's.)
 */
export function seerrError(text: string): string {
  const body = jsonOf({ text });
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const msg = (body as { message?: unknown }).message;
    return typeof msg === 'string' ? msg.slice(0, 160) : '';
  }
  return apiError(text);
}

/** Plex's machineIdentifier from its /identity XML; "" when none. */
export const identityOf = (xml: string): string => /machineIdentifier="([^"]*)"/.exec(xml)?.[1] ?? '';

/** What to tell the user when the profile is not there after the retries. */
export const profileMissingMsg = (app: App, settle: number): string =>
  `${app} has no '${PROFILE_NAME[app]}' profile visible after ~${(settle - 1) * 2}s — did task recyclarr:sync finish? (it creates it)`;

// ─── main ─────────────────────────────────────────────────────────────────────

export interface Deps {
  http: Http;
  log: Log;
  /** Where the missing-key errors go. */
  err: Log;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  lanIps: () => string[];
  env: Env;
  /** The tree whose .env holds the keys and APPDATA: the install, or a source. */
  repo: string;
}

export type Api = (method: string, path: string, body?: unknown) => Promise<ApiResult>;
export type Settled = { kind: 'found'; pid: number } | { kind: 'failed'; res: ApiResult } | { kind: 'missing' };

/**
 * The profile id, as the app reports it through Seerr's connection test.
 * Right after `task recyclarr:sync` a new profile can be missing from what
 * Seerr relays for a few seconds (seen 2026-09-29: seerr:configure run straight
 * after the sync failed, and the same call a minute later listed it). Re-ask
 * for up to `settle` tries (PROFILE_SETTLE), 2 s apart, before calling it missing.
 */
export async function settledProfileId(
  app: App,
  body: unknown,
  deps: { api: Api; sleep: (ms: number) => Promise<void>; settle: number },
): Promise<Settled> {
  for (let tries = 1; ; tries++) {
    const r = await deps.api('POST', `/settings/${app}/test`, body);
    if (!r.ok) return { kind: 'failed', res: r };
    const pid = profileId(r.json, PROFILE_NAME[app]);
    if (pid !== undefined) return { kind: 'found', pid };
    if (tries >= deps.settle) return { kind: 'missing' };
    await deps.sleep(2000);
  }
}

export async function main(argv: readonly string[], deps: Deps): Promise<number> {
  const { env, log, repo } = deps;
  const cli = parseCli(argv, { flags: ['--check'], usage: 'usage: configure.sh [--check]' });
  if (cli.help) {
    log(headerHelp(await Bun.file(import.meta.path).text()));
    return 0;
  }
  const mode = cli.flags['--check'] ? 'check' : 'apply';

  const appdata = envGet('APPDATA', { repo, env }) || '/opt/appdata';
  const url = env.SEERR_URL || 'http://127.0.0.1:5055';
  const settingsPath = env.SEERR_SETTINGS || join(appdata, 'seerr/settings.json');
  const plexUrl = env.PLEX_URL || 'http://127.0.0.1:32400'; // from this host, for the identity check
  const timeoutMs = envSeconds(env, 'SEERR_TIMEOUT', 60);
  const waitMs = envSeconds(env, 'SEERR_WAIT', 90);
  const settle = Number(env.PROFILE_SETTLE) || 6;
  const keys: Record<App, string> = {
    radarr: envGet('RADARR_API_KEY', { repo, env }),
    sonarr: envGet('SONARR_API_KEY', { repo, env }),
  };
  const lanIp = deps.lanIps()[0] ?? '';

  const missing = APPS.filter((a) => !keys[a]).map((a) => `${a.toUpperCase()}_API_KEY`);
  if (missing.length > 0) {
    deps.err(`Set ${missing.join(' ')} in ${repo}/.env.`);
    return 3;
  }
  const key = readSeerrKey(settingsPath);
  if (!key) {
    deps.err(`No API key in ${settingsPath} — has Seerr started once?`);
    return 3;
  }

  // Seerr's API is /api/v1 with the same X-Api-Key header as the Servarr apps.
  // POST and PUT always send JSON, an empty body when there is none.
  const api: Api = async (method, path, body) => {
    const sends = method === 'POST' || method === 'PUT';
    const r = await deps.http(`${url}/api/v1${path}`, {
      method,
      headers: { 'X-Api-Key': key, ...(sends ? { 'Content-Type': 'application/json' } : {}) },
      body: sends ? (body === undefined ? '' : JSON.stringify(body)) : undefined,
      timeoutMs,
    });
    return { ok: is2xx(r.status), status: r.status, text: r.text, json: jsonOf(r) };
  };
  const get = (path: string) => api('GET', path);
  const fail = (what: string, r: ApiResult, withError = true) =>
    log(`  FAIL  ${what} (HTTP ${httpCode(r.status)})${withError ? `: ${seerrError(r.text)}` : ''}`);
  const initialized = async (ms: number) => {
    const r = await deps.http(`${url}/api/v1/settings/public`, { timeoutMs: ms });
    return (jsonOf(r) as Partial<Schemas['PublicSettings']> | undefined)?.initialized === true;
  };

  const settled = (app: App, body: unknown) => settledProfileId(app, body, { api, sleep: deps.sleep, settle });

  // ─── apply ──────────────────────────────────────────────────────────────────
  const applyPlex = async (): Promise<boolean> => {
    const r = await get('/settings/plex');
    if (!r.ok) return (fail('read Plex settings', r, false), false);
    const cur = (r.json ?? {}) as Record<string, unknown>;
    if (hostDrift(cur, wantPlex() as JsonObject).length === 0 && cur.machineId) {
      log('  Plex server already set');
    } else {
      // Seerr connects with the admin's Plex token and records the server's
      // machineId — a 2xx here is itself a connection test.
      const w = await api('POST', '/settings/plex', wantPlex());
      if (!w.ok) return (fail('Plex server', w), false);
      const set = (w.json ?? {}) as Partial<PlexSettings>;
      log(`  Plex server set: ${String(set.name ?? null)} (${String(set.machineId ?? null)})`);
    }

    const sync = await api('POST', '/settings/plex/library/sync');
    if (!sync.ok) return (fail('sync Plex libraries', sync, false), false);
    let changed = false;
    for (const lib of Array.isArray(sync.json) ? (sync.json as PlexLibrary[]) : []) {
      const want = (LIBRARIES as readonly string[]).includes(lib.name);
      if (lib.enabled === want) continue;
      const w = await api('PUT', `/settings/plex/library/${lib.id}`, { enabled: want });
      if (!w.ok) return (fail(`library ${lib.name}`, w, false), false);
      changed = true;
    }
    log(changed ? `  libraries set: ${LIBRARIES.join(' ')}` : '  libraries already set');
    return true;
  };

  const applyServer = async (app: App): Promise<boolean> => {
    const s = await settled(app, wantServer(app, 0, keys[app], lanIp));
    if (s.kind === 'failed') return (fail(`${app} connection test`, s.res), false);
    if (s.kind === 'missing') return (log(`  FAIL  ${profileMissingMsg(app, settle)}`), false);
    const want = wantServer(app, s.pid, keys[app], lanIp);

    const r = await get(`/settings/${app}`);
    if (!r.ok) return (fail(`read ${app} servers`, r, false), false);
    const cur = defaultServer(r.json);
    if (cur === undefined) {
      const w = await api('POST', `/settings/${app}`, want);
      if (!w.ok) return (fail(`add ${app}`, w), false);
      log(`  ${app} server added (${PROFILE_NAME[app]})`);
      return true;
    }
    const drift = serverDrift(cur, want);
    if (drift.length === 0) return (log(`  ${app} server already set`), true);
    const w = await api('PUT', `/settings/${app}/${String(cur.id ?? null)}`, want);
    if (!w.ok) return (fail(`update ${app}`, w), false);
    log(`  ${app} server updated (${drift.join(' ')})`);
    return true;
  };

  const applyMain = async (): Promise<boolean> => {
    const r = await get('/settings/main');
    if (!r.ok) return (fail('read main settings', r, false), false);
    if (hostDrift((r.json ?? {}) as Record<string, unknown>, wantMain() as JsonObject).length === 0) {
      log('  sign-in already admin-only');
      return true;
    }
    const w = await api('POST', '/settings/main', wantMain());
    if (!w.ok) return (fail('main settings', w), false);
    log('  sign-in set to admin-only (newPlexLogin off)');
    return true;
  };

  // The wizard's last step. Then one full Plex scan, so every title already in
  // the library shows as Available and cannot be requested again as a duplicate —
  // Seerr reads that from Plex, whatever Radarr/Sonarr know.
  const applyFinish = async (): Promise<boolean> => {
    if (await initialized(timeoutMs)) {
      log('  setup already finished');
      return true;
    }
    const w = await api('POST', '/settings/initialize');
    if (!w.ok) return (fail('finish setup', w, false), false);
    log('  setup wizard marked finished');
    const scan = await api('POST', '/settings/jobs/plex-full-scan/run');
    if (scan.ok) log('  Plex full scan started (marks the existing library Available)');
    else log(`  WARN  could not start the Plex full scan (HTTP ${httpCode(scan.status)}) — Settings → Jobs`);
    return true;
  };

  // ─── verify ─────────────────────────────────────────────────────────────────
  const verify = async (): Promise<boolean> => {
    let ok = true;
    const p = await get('/settings/plex');
    if (!p.ok) return (log('  FAIL  read Plex settings'), false);
    const plex = (p.json ?? {}) as Partial<PlexSettings>;
    const drift = hostDrift(plex as Record<string, unknown>, wantPlex() as JsonObject);
    const mid = plex.machineId ?? '';
    const live = identityOf((await deps.http(`${plexUrl}/identity`, { timeoutMs: 10_000 })).text);
    if (drift.length > 0) {
      log(`  DRIFT    Plex: ${drift.join(' ')}`);
      ok = false;
    } else if (!mid || mid !== live) {
      log(`  DRIFT    Plex server is '${mid || 'none'}', but Plex answers as '${live || 'nothing'}'`);
      ok = false;
    } else log(`  ok       Plex server ${String(plex.name ?? null)} (${mid})`);

    const l = await get('/settings/plex/library');
    if (!l.ok) return (log('  FAIL  read libraries'), false);
    const enabled = enabledLibraries(l.json);
    if (enabled.join('\n') === wantedLibraries().join('\n')) log(`  ok       libraries: ${LIBRARIES.join(' ')}`);
    else {
      log(`  DRIFT    libraries enabled: ${enabled.join(',')}, want ${LIBRARIES.join(' ')}`);
      ok = false;
    }

    for (const app of APPS) {
      const r = await get(`/settings/${app}`);
      if (!r.ok) return (log(`  FAIL  read ${app}`), false);
      const cur = defaultServer(r.json);
      if (cur === undefined) {
        log(`  DRIFT    ${app} server missing`);
        ok = false;
        continue;
      }
      // The wanted profile id comes from the app itself, as in apply — never
      // from what is stored, or a wrong id would be compared with itself.
      const s = await settled(app, cur);
      if (s.kind === 'failed') {
        log(`  FAILING  ${app} server — test fails: ${seerrError(s.res.text)}`);
        continue;
      }
      if (s.kind === 'missing') {
        log(`  DRIFT    ${profileMissingMsg(app, settle)}`);
        ok = false;
        continue;
      }
      const d = serverDrift(cur, wantServer(app, s.pid, keys[app], lanIp));
      if (d.length > 0) {
        log(`  DRIFT    ${app}: ${d.join(' ')}`);
        ok = false;
        continue;
      }
      log(`  ok       ${app} server — test passes, ${PROFILE_NAME[app]} (id ${s.pid})`);
    }

    const m = await get('/settings/main');
    if (!m.ok) return (log('  FAIL  read main'), false);
    if (hostDrift((m.json ?? {}) as Record<string, unknown>, wantMain() as JsonObject).length === 0)
      log('  ok       sign-in admin-only');
    else {
      log('  DRIFT    new Plex users can sign in');
      ok = false;
    }

    if (await initialized(10_000)) log('  ok       setup finished');
    else {
      log('  DRIFT    setup wizard not finished');
      ok = false;
    }

    // Informational: what the Plex scan has marked Available so far.
    const media = await get('/media?filter=available&take=1');
    if (media.ok) {
      const n = (media.json as { pageInfo?: Schemas['PageInfo'] } | undefined)?.pageInfo?.results ?? 0;
      log(`  info     ${n} title(s) Available (from Plex)`);
    }
    return ok;
  };

  // ─── run ────────────────────────────────────────────────────────────────────
  log(`Seerr at ${url} (${mode})`);
  const deadline = deps.now() + waitMs;
  let status = await deps.http(`${url}/api/v1/status`, { timeoutMs: 5000 });
  while (!is2xx(status.status)) {
    if (deps.now() >= deadline) {
      log(`  FAIL  not answering at ${url} — is it running?`);
      return 3;
    }
    await deps.sleep(3000);
    status = await deps.http(`${url}/api/v1/status`, { timeoutMs: 5000 });
  }
  log(`  up: ${String((jsonOf(status) as { version?: unknown } | undefined)?.version ?? null)}`);

  // 403 with the key means no admin exists: the Plex sign-in has not happened.
  const first = await get('/settings/main');
  if (!first.ok) {
    if (first.status === 403)
      log(
        `  Sign in first: open http://${lanIp}:5055 and sign in with Plex (just that — this script does the rest of the wizard).`,
      );
    else log(`  FAIL  settings not readable (HTTP ${httpCode(first.status)})`);
    return 3;
  }

  if (mode === 'apply') {
    const applied =
      (await applyPlex()) &&
      (await applyServer('radarr')) &&
      (await applyServer('sonarr')) &&
      (await applyMain()) &&
      (await applyFinish());
    if (!applied) return 1;
  }
  log('Read-back:');
  if (await verify()) {
    log('No drift.');
    return 0;
  }
  if (mode === 'check') log('To apply: task seerr:configure');
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
      lanIps: () => lanIps(),
      env: process.env,
      repo: resolve(import.meta.dir, '../..'),
    }),
  );
}
