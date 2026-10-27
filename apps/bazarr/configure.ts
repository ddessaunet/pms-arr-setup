// apps/bazarr/configure.ts — apply Bazarr's settings through its API, then read them
// back and test the connections. Idempotent.
//
//   apps/bazarr/configure.sh            apply, then verify
//   apps/bazarr/configure.sh --check    verify only; changes nothing
//
// Normally run as `task bazarr:configure` / `task bazarr:check`.
//
// Bazarr fetches Spanish and English subtitles for what Radarr and Sonarr
// manage, and writes them beside the video (Title (Year).es.srt / .en.srt),
// where Plex reads them as local subtitles. Plex's own "Search subtitles" keeps
// working beside it: Plex saves those into its database, never the library.
//
// The API key is Bazarr's own, generated on first start into
// $APPDATA/bazarr/config/config.yaml — nothing to put in .env. Radarr, Sonarr
// and Plex are reached with their .env keys; the WebUI login is ARR_USER/ARR_PASS.
// OpenSubtitles.com is used only when OPENSUBTITLES_USER/PASS are set.
//
// This script owns ALL language profiles: Bazarr replaces the whole list on a
// write, so a profile added in the WebUI is removed by the next apply.
//
// Exit: 0 applied and verified (or no drift; a FAILING connection only warns) ·
// 1 drift, or a step failed · 2 usage · 3 not reachable, or not configured.

import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { headerHelp, parseCli } from '../../stack/lib/cli.ts';
import { envGet, envSeconds, type Env } from '../../stack/lib/env.ts';
import { runMain } from '../../stack/lib/exit.ts';
import { httpCode, is2xx, jsonOf, makeHttp, type Http } from '../../stack/lib/http.ts';
import { readBazarrKey } from '../../stack/lib/keys.ts';
import { err, out, type Log } from '../../stack/lib/log.ts';
import { jsonEqual, type Json } from '../../stack/lib/servarr.ts';

// Bazarr publishes Swagger 2.0 only, so these are hand-written and narrow: the
// fields this script reads.
export interface LanguageProfile {
  profileId?: number;
  name?: string;
  cutoff?: number | null;
  items?: { language?: string }[];
}
export interface Language {
  code2?: string;
  enabled?: boolean;
}

// ─── the settings ─────────────────────────────────────────────────────────────

/** Wanted languages, in profile order. One profile, the default for every movie and series, so each title gets both. */
export const LANGS = ['es', 'en'] as const;
export const PROFILE_ID = 1;
export const PROFILE_NAME = 'Spanish + English';

/**
 * Providers that need no account, by what they cover: subtis (Spanish movies),
 * yifysubtitles (movies), subtitulamostv (Spanish/English TV), gestdown (TV).
 * Bazarr 1.6 dropped podnapisi, and subdivx became subx, which needs an API key.
 */
export const FREE_PROVIDERS = ['subtis', 'yifysubtitles', 'subtitulamostv', 'gestdown'] as const;

export interface Secrets {
  radarrKey: string;
  sonarrKey: string;
  user: string;
  pass: string;
  osUser: string;
  osPass: string;
}

export const opensubtitlesOn = (s: Secrets): boolean => s.osUser !== '' && s.osPass !== '';

export const providers = (s: Secrets): string[] =>
  opensubtitlesOn(s) ? ['opensubtitlescom', ...FREE_PROVIDERS] : [...FREE_PROVIDERS];

/**
 * Every owned setting, as {"section.key": value}. Only these are ever written.
 * auth.password is the md5 Bazarr stores; formBody sends the plain one.
 * only_monitored stays off: most of the library is unmonitored (Phase 8 imported
 * it that way), and those titles need subtitles as much as new ones.
 * chmod 0664: without it a subtitle's mode depends on the code path that wrote
 * it (seen: 0666, world-writable, despite UMASK 002); with it every .srt is
 * rw-rw-r--, like the rest of the library.
 * Not radarr/sonarr.base_url: a written "/" is stored as "", which would read
 * back as drift forever, and the default already works.
 */
export function wantSettings(s: Secrets): Record<string, Json> {
  return {
    'general.use_radarr': true,
    'radarr.ip': 'radarr',
    'radarr.port': 7878,
    'radarr.ssl': false,
    'radarr.apikey': s.radarrKey,
    'radarr.only_monitored': false,
    'general.use_sonarr': true,
    'sonarr.ip': 'sonarr',
    'sonarr.port': 8989,
    'sonarr.ssl': false,
    'sonarr.apikey': s.sonarrKey,
    'sonarr.only_monitored': false,
    'general.movie_default_enabled': true,
    'general.movie_default_profile': PROFILE_ID,
    'general.serie_default_enabled': true,
    'general.serie_default_profile': PROFILE_ID,
    'general.enabled_providers': providers(s),
    'general.use_embedded_subs': true,
    'general.subfolder': 'current',
    'general.chmod_enabled': true,
    'general.chmod': '0664',
    'general.use_plex': true,
    'plex.ip': 'host.docker.internal',
    'plex.port': 32400,
    'plex.ssl': false,
    'plex.movie_library': ['Movies'],
    'plex.series_library': ['TV Shows'],
    'plex.update_movie_library': true,
    'plex.update_series_library': true,
    'plex.set_movie_added': false,
    'plex.set_episode_added': false,
    'auth.type': 'form',
    'auth.username': s.user,
    'auth.password': createHash('md5').update(s.pass).digest('hex'),
    ...(opensubtitlesOn(s) ? { 'opensubtitlescom.username': s.osUser, 'opensubtitlescom.password': s.osPass } : {}),
  };
}

export function wantProfiles() {
  return [
    {
      profileId: PROFILE_ID,
      name: PROFILE_NAME,
      cutoff: null,
      items: LANGS.map((language, i) => ({
        id: i + 1,
        language,
        audio_exclude: 'False',
        audio_only_include: 'False',
        hi: 'False',
        forced: 'False',
      })),
      mustContain: [],
      mustNotContain: [],
      originalFormat: false,
      tag: null,
    },
  ];
}

// ─── pure helpers (apps/bazarr/configure.test.ts) ────────────────────────────

/** jq's @uri: everything but A-Z a-z 0-9 - _ . ~ is %-encoded. */
export const uri = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** jq's tostring / string interpolation: a string as it is, anything else as JSON. */
const text = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v ?? null));

/** jq's getpath: null where the path is missing. */
function getpath(obj: unknown, path: readonly string[]): unknown {
  let cur = obj;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return null;
    cur = (cur as Record<string, unknown>)[k] ?? null;
  }
  return cur;
}

/** Owned keys whose value differs in a GET /system/settings response, in want's order. */
export function settingsDrift(got: unknown, want: Readonly<Record<string, Json>>): string[] {
  return Object.keys(want).filter((k) => !jsonEqual(getpath(got, k.split('.')), want[k]));
}

/**
 * The url-encoded form body that writes the named keys: settings-<section>-<key>,
 * one pair per list item. The plain password goes in; Bazarr hashes it.
 */
export function formBody(want: Readonly<Record<string, Json>>, keys: readonly string[], plainPass: string): string {
  const pairs: string[] = [];
  for (const k of keys) {
    if (!k) continue;
    const v = k === 'auth.password' ? plainPass : (want[k] ?? null);
    const name = `settings-${k.replace('.', '-')}`;
    for (const item of Array.isArray(v) ? v : [v]) pairs.push(`${uri(name)}=${uri(text(item))}`);
  }
  return pairs.join('&');
}

export const noun = (kind: Kind): string => (kind === 'movies' ? 'movie(s)' : 'series');

/** What matters of a language profile list: names, cutoffs and languages in order. */
export function profilesShape(profiles: unknown): unknown[] {
  if (!Array.isArray(profiles)) return [];
  return (profiles as LanguageProfile[]).map((p) => ({
    profileId: p?.profileId ?? null,
    name: p?.name ?? null,
    cutoff: p?.cutoff ?? null,
    langs: (p?.items ?? []).map((i) => i?.language ?? null),
  }));
}
export const profilesDrift = (profiles: unknown): boolean =>
  !jsonEqual(profilesShape(profiles), profilesShape(wantProfiles()));

/** Enabled language codes from GET /system/languages, sorted. */
export function enabledLangs(langs: unknown): string[] {
  if (!Array.isArray(langs)) return [];
  return (langs as Language[])
    .filter((l) => l?.enabled)
    .map((l) => text(l.code2))
    .sort();
}
export const wantedLangs = (): string[] => [...LANGS].sort();

/** Ids of titles with no language profile, from GET /movies or /series. */
export function unprofiled(list: unknown, field: string): string[] {
  const data = (list as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data)) return [];
  return (data as Record<string, unknown>[]).filter((t) => (t?.profileId ?? null) === null).map((t) => text(t[field]));
}

/** The drift keys as the apply log names them: secrets marked, never shown. */
export const driftNames = (drift: readonly string[]): string[] =>
  drift.map((k) => k.replace(/\.password$/, '.password (hidden)').replace(/\.apikey$/, '.apikey (hidden)'));

export type Kind = 'movies' | 'series';
const KINDS: readonly { kind: Kind; field: string; idKey: string }[] = [
  { kind: 'movies', field: 'radarrId', idKey: 'radarrid' },
  { kind: 'series', field: 'sonarrSeriesId', idKey: 'seriesid' },
];

// ─── main ─────────────────────────────────────────────────────────────────────

export interface Deps {
  http: Http;
  log: Log;
  /** Where the missing-key errors go. */
  err: Log;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  env: Env;
  /** The tree whose .env holds the keys and APPDATA: the install, or a source. */
  repo: string;
}

interface BzResult {
  ok: boolean;
  status: number;
  text: string;
  json: unknown;
}

export async function main(argv: readonly string[], deps: Deps): Promise<number> {
  const { env, log, repo } = deps;
  const cli = parseCli(argv, { flags: ['--check'], usage: 'usage: configure.sh [--check]' });
  if (cli.help) {
    log(headerHelp(await Bun.file(import.meta.path).text()));
    return 0;
  }
  const mode = cli.flags['--check'] ? 'check' : 'apply';

  const get = (key: string) => envGet(key, { repo, env });
  const appdata = get('APPDATA') || '/opt/appdata';
  const url = env.BAZARR_URL || 'http://127.0.0.1:6767';
  const configPath = env.BAZARR_CONFIG || join(appdata, 'bazarr/config/config.yaml');
  const timeoutMs = envSeconds(env, 'BAZARR_TIMEOUT', 60);
  const waitMs = envSeconds(env, 'BAZARR_WAIT', 90);
  const connectSettle = Number(env.CONNECT_SETTLE) || 10;
  const plexToken = get('PLEX_TOKEN');
  // Optional, so set-but-empty in the environment means "no account" and wins
  // over .env (the tests rely on it).
  const secrets: Secrets = {
    radarrKey: get('RADARR_API_KEY'),
    sonarrKey: get('SONARR_API_KEY'),
    user: get('ARR_USER'),
    pass: get('ARR_PASS'),
    osUser: envGet('OPENSUBTITLES_USER', { repo, env, emptyWins: true }),
    osPass: envGet('OPENSUBTITLES_PASS', { repo, env, emptyWins: true }),
  };

  const required: [string, string][] = [
    ['RADARR_API_KEY', secrets.radarrKey],
    ['SONARR_API_KEY', secrets.sonarrKey],
    ['ARR_USER', secrets.user],
    ['ARR_PASS', secrets.pass],
    ['PLEX_TOKEN', plexToken],
  ];
  const missing = required.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    deps.err(`Set ${missing.join(' ')} in ${repo}/.env.`);
    return 3;
  }

  // On a first start Bazarr writes config.yaml, key included, some 20 s after
  // the container is up — `task start && task bazarr:configure` lands in that
  // gap. Wait for the key as for the API, within the same BAZARR_WAIT.
  const deadline = deps.now() + waitMs;
  let key = readBazarrKey(configPath);
  while (!key) {
    if (deps.now() >= deadline) {
      deps.err(`No API key in ${configPath} after ${waitMs / 1000}s — is bazarr running? (docker compose ps bazarr)`);
      return 3;
    }
    await deps.sleep(3000);
    key = readBazarrKey(configPath);
  }

  // A form body only on POST; everything else is a plain GET.
  const bz = async (method: 'GET' | 'POST', path: string, form = ''): Promise<BzResult> => {
    const post = method === 'POST';
    const r = await deps.http(`${url}/api${path}`, {
      method,
      headers: { 'X-API-KEY': key, ...(post ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: post ? form : undefined,
      timeoutMs,
    });
    return { ok: is2xx(r.status), status: r.status, text: r.text, json: jsonOf(r) };
  };
  const bzGet = (path: string) => bz('GET', path);
  const failHttp = (what: string, r: BzResult) => log(`  FAIL  ${what} (HTTP ${httpCode(r.status)})`);

  // The stored Plex token works: plex.tv answers Bazarr's account call with it.
  // (Bazarr keeps it encrypted, so it cannot be compared with .env.)
  const plexTokenOk = async () => {
    const r = await bzGet('/plex/webhook/list');
    const data = (r.json as { data?: unknown } | undefined)?.data;
    return r.ok && data !== null && typeof data === 'object' && !Array.isArray(data) && 'webhooks' in data;
  };

  // ─── apply ──────────────────────────────────────────────────────────────────
  const applySettings = async (): Promise<boolean> => {
    const want = wantSettings(secrets);
    const s = await bzGet('/system/settings');
    if (!s.ok) return (failHttp('read settings', s), false);
    const drift = settingsDrift(s.json, want);
    const l = await bzGet('/system/languages');
    if (!l.ok) return (failHttp('read languages', l), false);
    const langsDrift = !jsonEqual(enabledLangs(l.json), wantedLangs());
    const p = await bzGet('/system/languages/profiles');
    if (!p.ok) return (failHttp('read language profiles', p), false);
    const profDrift = profilesDrift(p.json);

    if (drift.length === 0 && !langsDrift && !profDrift) {
      log('  settings already set');
      return true;
    }
    const parts = [formBody(want, drift, secrets.pass)];
    if (langsDrift) parts.push(...LANGS.map((lang) => `languages-enabled=${uri(lang)}`));
    if (profDrift) parts.push(`languages-profiles=${uri(JSON.stringify(wantProfiles()))}`);
    const w = await bz('POST', '/system/settings', parts.filter(Boolean).join('&'));
    if (!w.ok) return (log(`  FAIL  write settings (HTTP ${httpCode(w.status)}): ${w.text.slice(0, 160)}`), false);
    const what = [
      ...driftNames(drift),
      ...(langsDrift ? [`languages:${LANGS.join(' ')}`] : []),
      ...(profDrift ? [`profile:'${PROFILE_NAME}'`] : []),
    ];
    log(`  settings set: ${what.join(' ')}`);
    return true;
  };

  const applyPlexToken = async (): Promise<boolean> => {
    if (await plexTokenOk()) return (log('  Plex token already set'), true);
    const w = await bz('POST', '/plex/apikey', `apikey=${uri(plexToken)}`);
    if (!w.ok) return (failHttp('Plex token', w), false);
    log('  Plex token set (stored encrypted)');
    return true;
  };

  // Titles synced before a default profile existed have none. Give them the one
  // profile; titles added later get it as the default.
  const applyProfilesToTitles = async (): Promise<boolean> => {
    for (const { kind, field, idKey } of KINDS) {
      const r = await bzGet(`/${kind}?start=0&length=-1`);
      if (!r.ok) return (failHttp(`read ${kind}`, r), false);
      const ids = unprofiled(r.json, field);
      if (ids.length === 0) continue;
      const w = await bz('POST', `/${kind}`, ids.map((id) => `${idKey}=${id}&profileid=${PROFILE_ID}`).join('&'));
      if (!w.ok) return (failHttp(`profile for ${kind}`, w), false);
      log(`  '${PROFILE_NAME}' given to ${ids.length} ${noun(kind)} that had no profile`);
    }
    return true;
  };

  // ─── verify ─────────────────────────────────────────────────────────────────
  // Radarr/Sonarr are connected once Bazarr reports their versions. Right after
  // they are enabled that takes a few seconds; re-ask for up to CONNECT_SETTLE tries.
  const appVersion = async (app: 'radarr' | 'sonarr'): Promise<string | undefined> => {
    for (let tries = 1; ; tries++) {
      const r = await bzGet('/system/status');
      const v = r.ok ? (r.json as { data?: Record<string, unknown> } | undefined)?.data?.[`${app}_version`] : undefined;
      if (v !== undefined && v !== null && v !== false && text(v) !== '') return text(v);
      if (tries >= connectSettle) return undefined;
      await deps.sleep(3000);
    }
  };

  const verify = async (): Promise<boolean> => {
    let ok = true;
    const s = await bzGet('/system/settings');
    if (!s.ok) return (log('  FAIL  read settings'), false);
    const drift = settingsDrift(s.json, wantSettings(secrets));
    if (drift.length > 0) {
      log(`  DRIFT    settings: ${drift.join(' ')}`);
      ok = false;
    } else
      log(
        `  ok       settings: Radarr/Sonarr, default profile, providers ${providers(secrets).join(',')}, Plex refresh, form login`,
      );
    if (!opensubtitlesOn(secrets))
      log('  warn     OpenSubtitles.com off — set OPENSUBTITLES_USER/PASS in .env for its catalogue');

    const l = await bzGet('/system/languages');
    if (!l.ok) return (log('  FAIL  read languages'), false);
    const langs = enabledLangs(l.json);
    if (jsonEqual(langs, wantedLangs())) log(`  ok       languages: ${LANGS.join(' ')}`);
    else {
      log(`  DRIFT    languages enabled: ${langs.join(',')}, want ${LANGS.join(' ')}`);
      ok = false;
    }

    const p = await bzGet('/system/languages/profiles');
    if (!p.ok) return (log('  FAIL  read language profiles'), false);
    if (profilesDrift(p.json)) {
      log(`  DRIFT    language profiles: ${JSON.stringify(profilesShape(p.json))}`);
      ok = false;
    } else log(`  ok       one profile: '${PROFILE_NAME}' (${LANGS.join(' ')})`);

    for (const app of ['radarr', 'sonarr'] as const) {
      const v = await appVersion(app);
      if (v !== undefined) log(`  ok       ${app} connected (${v})`);
      else log(`  FAILING  ${app} not connected — Bazarr reports no version`);
    }

    if (await plexTokenOk()) log('  ok       Plex token accepted');
    else log('  FAILING  Plex token refused — Plex will not refresh after a download');

    for (const { kind, field } of KINDS) {
      const r = await bzGet(`/${kind}?start=0&length=-1`);
      if (!r.ok) return (log(`  FAIL  read ${kind}`), false);
      const n = unprofiled(r.json, field).length;
      if (n > 0) {
        log(`  DRIFT    ${n} ${noun(kind)} without a language profile`);
        ok = false;
      }
    }

    // Informational: what is still wanted, and anything Bazarr flags.
    const badges = await bzGet('/badges');
    if (badges.ok) {
      const b = (badges.json ?? {}) as { movies?: unknown; episodes?: unknown };
      log(`  info     wanted: ${text(b.movies)} movie(s), ${text(b.episodes)} episode(s)`);
    }
    const health = await bzGet('/system/health');
    if (health.ok) {
      const data = (health.json as { data?: unknown } | undefined)?.data;
      for (const h of Array.isArray(data) ? (data as Record<string, unknown>[]) : [])
        log(`  warn     health: ${text(h?.object ?? '')} ${text(h?.issue ?? h)}`);
    }
    return ok;
  };

  // ─── run ────────────────────────────────────────────────────────────────────
  log(`Bazarr at ${url} (${mode})`);
  let status = await bzGet('/system/status');
  while (!status.ok) {
    if (status.status === 401) {
      log(`  FAIL  the key from ${configPath} is refused`);
      return 3;
    }
    if (deps.now() >= deadline) {
      log(`  FAIL  not answering at ${url} — is it running?`);
      return 3;
    }
    await deps.sleep(3000);
    status = await bzGet('/system/status');
  }
  log(`  up: ${text((status.json as { data?: { bazarr_version?: unknown } } | undefined)?.data?.bazarr_version)}`);

  if (mode === 'apply') {
    const applied = (await applySettings()) && (await applyPlexToken()) && (await applyProfilesToTitles());
    if (!applied) return 1;
  }
  log('Read-back:');
  if (await verify()) {
    log('No drift.');
    return 0;
  }
  if (mode === 'check') log('To apply: task bazarr:configure');
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
      env: process.env,
      repo: resolve(import.meta.dir, '../..'),
    }),
  );
}
