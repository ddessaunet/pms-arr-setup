// apps/bazarr/configure.test.ts — the pure helpers, and main against a fake Bazarr.
//
// Offline, and changes nothing outside a temp dir. The live behaviour was
// checked on a throwaway Bazarr 1.6.2 (linuxserver v1.6.2-ls366) against the
// real Radarr, Sonarr and Plex, and the fake below answers the same way:
// - the API key is generated into /config/config/config.yaml (auth.apikey) and
//   works as X-API-KEY with form login on; GET /api/system/settings returns
//   every section with secrets in clear, except auth.password (md5) and the Plex
//   token (encrypted, set through POST /api/plex/apikey)
// - POST /api/system/settings takes a form: settings-<section>-<key>, one pair
//   per list item, languages-enabled, and languages-profiles as JSON, which
//   REPLACES the whole profile list; a written base_url "/" is stored as ""
// - Radarr/Sonarr count as connected once /system/status reports their
//   versions; GET /api/plex/webhook/list succeeds only with a valid Plex token
// - podnapisi no longer exists, and subdivx became subx (API key required)
// - POST /api/movies (radarrid, profileid pairs) gives titles a profile

import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpRequest, HttpResponse } from '../../stack/lib/http.ts';
import { readBazarrKey } from '../../stack/lib/keys.ts';
import type { Json } from '../../stack/lib/servarr.ts';
import {
  enabledLangs,
  formBody,
  main,
  profilesDrift,
  settingsDrift,
  unprofiled,
  uri,
  wantedLangs,
  wantProfiles,
  wantSettings,
  type Secrets,
} from './configure.ts';

const tmp = mkdtempSync(join(tmpdir(), 'bazarr-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const md5 = (s: string) => createHash('md5').update(s).digest('hex');

const SECRETS: Secrets = { radarrKey: 'rk', sonarrKey: 'sk', user: 'admin', pass: 'p&ss=1', osUser: '', osPass: '' };

/** A GET /system/settings response holding the flat keys, nested. */
function nest(flat: Readonly<Record<string, Json>>): Record<string, Record<string, Json>> {
  const out: Record<string, Record<string, Json>> = {};
  for (const [k, v] of Object.entries(flat)) {
    const [section = '', key = ''] = k.split('.');
    (out[section] ??= {})[key] = v;
  }
  return out;
}

// ─── the API key ──────────────────────────────────────────────────────────────
describe('bazarr_key', () => {
  const file = (name: string, text: string) => {
    writeFileSync(join(tmp, name), text);
    return join(tmp, name);
  };
  test('auth.apikey from config.yaml', () =>
    expect(
      readBazarrKey(
        file(
          'config.yaml',
          "---\nassrt:\n  token: ''\nauth:\n  apikey: 059777b50de7e69b9a20dbeb07b4deda\n  password: ''\n  type: null\nbackup:\n  apikey: not-this-one\n",
        ),
      ),
    ).toBe('059777b50de7e69b9a20dbeb07b4deda'));
  test('quotes stripped', () => expect(readBazarrKey(file('quoted.yaml', 'auth:\n  apikey: "abc"\n'))).toBe('abc'));
  test("another section's apikey → empty", () =>
    expect(readBazarrKey(file('noauth.yaml', 'plex:\n  apikey: wrong\n'))).toBe(''));
  test('missing file → empty, no error', () => expect(readBazarrKey(join(tmp, 'none.yaml'))).toBe(''));
});

// ─── the wanted settings ──────────────────────────────────────────────────────
describe('want_settings', () => {
  const W = wantSettings(SECRETS);
  test('radarr by container name and port', () =>
    expect([W['radarr.ip'], W['radarr.port'], W['radarr.apikey']]).toEqual(['radarr', 7878, 'rk']));
  test('sonarr by container name and port', () =>
    expect([W['sonarr.ip'], W['sonarr.port'], W['sonarr.apikey']]).toEqual(['sonarr', 8989, 'sk']));
  test('unmonitored titles covered (most of the library is)', () =>
    expect([W['radarr.only_monitored'], W['sonarr.only_monitored']]).toEqual([false, false]));
  test('base_url not owned (a written / reads back as "")', () =>
    expect('radarr.base_url' in W || 'sonarr.base_url' in W).toBe(false));
  test('the one profile is the default for both', () =>
    expect([
      W['general.movie_default_enabled'],
      W['general.movie_default_profile'],
      W['general.serie_default_enabled'],
      W['general.serie_default_profile'],
    ]).toEqual([true, 1, true, 1]));
  test('subtitles beside the video', () => expect(W['general.subfolder']).toBe('current'));
  test('subtitles rw-rw-r--, mode as text (Bazarr reads it as octal)', () =>
    expect([W['general.chmod_enabled'], W['general.chmod']]).toEqual([true, '0664']));
  test('embedded es/en tracks count', () => expect(W['general.use_embedded_subs']).toBe(true));
  test('Plex through the host gateway', () =>
    expect(`${W['plex.ip']}:${W['plex.port']}`).toBe('host.docker.internal:32400'));
  test('Plex libraries by name', () =>
    expect([W['plex.movie_library'], W['plex.series_library']]).toEqual([['Movies'], ['TV Shows']]));
  test('Plex refreshed, added dates untouched', () =>
    expect([
      W['plex.update_movie_library'],
      W['plex.update_series_library'],
      W['plex.set_movie_added'],
      W['plex.set_episode_added'],
    ]).toEqual([true, true, false, false]));
  test('form login as ARR_USER', () => expect([W['auth.type'], W['auth.username']]).toEqual(['form', 'admin']));
  test("password compared as Bazarr's md5", () => expect(W['auth.password']).toBe(md5('p&ss=1')));
  test('no OpenSubtitles without an account', () =>
    expect(W['general.enabled_providers']).toEqual(['subtis', 'yifysubtitles', 'subtitulamostv', 'gestdown']));
  test('…and its login not owned', () => expect('opensubtitlescom.username' in W).toBe(false));
  const WO = wantSettings({ ...SECRETS, osUser: 'me', osPass: 'pw' });
  test('OpenSubtitles first with an account', () =>
    expect((WO['general.enabled_providers'] as string[])[0]).toBe('opensubtitlescom'));
  test('…with its login', () =>
    expect([WO['opensubtitlescom.username'], WO['opensubtitlescom.password']]).toEqual(['me', 'pw']));
  test('only one of the account fields → off', () =>
    expect('opensubtitlescom.username' in wantSettings({ ...SECRETS, osUser: 'me' })).toBe(false));
});

// ─── drift ────────────────────────────────────────────────────────────────────
describe('settings_drift', () => {
  const W = wantSettings(SECRETS);
  const GOT = nest(W);
  GOT.general!.auto_update = true;
  GOT.radarr!.base_url = '';
  test('match, unowned keys ignored → no drift', () => expect(settingsDrift(GOT, W)).toEqual([]));
  test('a changed port → named', () =>
    expect(settingsDrift({ ...GOT, radarr: { ...GOT.radarr, port: 7879 } }, W)).toEqual(['radarr.port']));
  test('providers reordered → named', () =>
    expect(
      settingsDrift(
        {
          ...GOT,
          general: { ...GOT.general, enabled_providers: [...(W['general.enabled_providers'] as string[])].reverse() },
        },
        W,
      ),
    ).toEqual(['general.enabled_providers']));
  test('a missing section → its keys named', () => {
    const { auth: _, ...noAuth } = GOT;
    expect(settingsDrift(noAuth, W)).toEqual(['auth.type', 'auth.username', 'auth.password']);
  });
  test('fresh install (defaults) → drift', () =>
    expect(settingsDrift({ general: { use_radarr: false } }, W)).toContain('general.use_radarr'));
});

// ─── the form ─────────────────────────────────────────────────────────────────
describe('form_body', () => {
  const W = wantSettings(SECRETS);
  const F = formBody(
    W,
    ['auth.password', 'general.enabled_providers', 'radarr.port', 'general.use_radarr', 'plex.series_library'],
    'p&ss=1',
  ).split('&');
  test('plain password, url-encoded (Bazarr hashes it)', () =>
    expect(F.filter((p) => p === 'settings-auth-password=p%26ss%3D1')).toHaveLength(1));
  test('one pair per list item', () =>
    expect(F.filter((p) => p.startsWith('settings-general-enabled_providers='))).toHaveLength(4));
  test('numbers and booleans as text', () =>
    expect(F.filter((p) => /radarr-port|use_radarr/.test(p))).toEqual([
      'settings-radarr-port=7878',
      'settings-general-use_radarr=true',
    ]));
  test('only the first dot becomes a dash; spaces encoded', () =>
    expect(F.filter((p) => p.includes('series_library'))).toEqual(['settings-plex-series_library=TV%20Shows']));
  test('nothing drifted → empty body', () => expect(formBody(W, [], 'p&ss=1')).toBe(''));
  test("jq's @uri: only unreserved characters stay", () =>
    expect(uri("a-b_c.d~e!'()* /")).toBe('a-b_c.d~e%21%27%28%29%2A%20%2F'));
});

// ─── languages ────────────────────────────────────────────────────────────────
describe('languages and profiles', () => {
  const P = wantProfiles();
  test('one profile, id 1, es then en', () =>
    expect(P.map((p) => `${p.profileId} ${p.name} ${p.items.map((i) => i.language).join(',')}`)).toEqual([
      '1 Spanish + English es,en',
    ]));
  test('plain subtitles: not forced, not hearing-impaired', () =>
    expect([...new Set(P[0]!.items.flatMap((i) => [i.forced, i.hi]))]).toEqual(['False']));
  test('stored form (originalFormat 0) → same', () =>
    expect(profilesDrift([{ ...P[0]!, originalFormat: 0 }])).toBe(false));
  test('no profiles (fresh) → drift', () => expect(profilesDrift([])).toBe(true));
  test('an extra profile from the WebUI → drift (the script owns all)', () =>
    expect(profilesDrift([...P, { ...P[0]!, profileId: 2, name: 'Extra' }])).toBe(true));
  test('en before es → drift', () =>
    expect(profilesDrift([{ ...P[0]!, items: [...P[0]!.items].reverse() }])).toBe(true));
  const L = [
    { code2: 'en', enabled: true },
    { code2: 'es', enabled: true },
    { code2: 'fr', enabled: false },
  ];
  test('enabled = wanted', () => expect(enabledLangs(L)).toEqual(wantedLangs()));
  test('a third enabled language is visible', () =>
    expect(enabledLangs(L.map((l) => ({ ...l, enabled: true })))).toEqual(['en', 'es', 'fr']));
});

// ─── titles without a profile ─────────────────────────────────────────────────
describe('unprofiled', () => {
  const M = {
    data: [
      { radarrId: 4, profileId: 1 },
      { radarrId: 9, profileId: null },
      { radarrId: 12, profileId: null },
    ],
  };
  test('movies with none, by radarrId', () => expect(unprofiled(M, 'radarrId')).toEqual(['9', '12']));
  test('all profiled → none', () =>
    expect(unprofiled({ data: [{ sonarrSeriesId: 1, profileId: 1 }] }, 'sonarrSeriesId')).toEqual([]));
});

// ─── main, against a fake Bazarr ──────────────────────────────────────────────

const KEY = 'bzkey';
const ENV = {
  RADARR_API_KEY: 'rk',
  SONARR_API_KEY: 'sk',
  ARR_USER: 'admin',
  ARR_PASS: 'p&ss=1',
  PLEX_TOKEN: 'pt',
  OPENSUBTITLES_USER: '',
  OPENSUBTITLES_PASS: '',
};

interface State {
  up: boolean;
  settings: Record<string, Record<string, Json>>;
  langs: { code2: string; enabled: boolean }[];
  profiles: unknown[];
  plexToken: string;
  movies: { radarrId: number; profileId: number | null }[];
  series: { sonarrSeriesId: number; profileId: number | null }[];
  /** Calls to /system/status before Radarr/Sonarr versions show. */
  connectAfter: number;
  health: unknown[];
}

const LANGS = () => [
  { code2: 'en', enabled: false },
  { code2: 'es', enabled: false },
  { code2: 'fr', enabled: false },
];

/** A fresh Bazarr: defaults, no profiles, no Plex token. */
function fresh(): State {
  return {
    up: true,
    settings: { general: { use_radarr: false, auto_update: true }, radarr: { base_url: '' }, auth: { type: null } },
    langs: LANGS(),
    profiles: [],
    plexToken: '',
    movies: [
      { radarrId: 1, profileId: null },
      { radarrId: 2, profileId: null },
    ],
    series: [{ sonarrSeriesId: 7, profileId: null }],
    connectAfter: 0,
    health: [],
  };
}

/** As the box has it. */
function configured(): State {
  const s = fresh();
  s.settings = nest(wantSettings(SECRETS));
  s.settings.general!.auto_update = true;
  s.langs = LANGS().map((l) => ({ ...l, enabled: l.code2 !== 'fr' }));
  s.profiles = wantProfiles().map((p) => ({ ...p, originalFormat: 0 }));
  s.plexToken = 'pt';
  s.movies = s.movies.map((m) => ({ ...m, profileId: 1 }));
  s.series = s.series.map((m) => ({ ...m, profileId: 1 }));
  return s;
}

function fakeBazarr(state: State) {
  const posts: { path: string; form: URLSearchParams }[] = [];
  let statusCalls = 0;
  const reply = (status: number, body?: unknown): HttpResponse => ({
    status,
    text: body === undefined ? '' : JSON.stringify(body),
    headers: new Headers(),
  });
  const http = async (url: string, req: HttpRequest): Promise<HttpResponse> => {
    if (!state.up) return reply(0);
    if (req.headers?.['X-API-KEY'] !== KEY) return reply(401);
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api/, '');
    if (req.method === 'POST') {
      const form = new URLSearchParams(String(req.body ?? ''));
      posts.push({ path, form });
      switch (path) {
        case '/system/settings': {
          // Form fields are text; Bazarr turns them back into its types.
          const asType = (v: string): Json =>
            v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) && v !== '0664' ? Number(v) : v;
          const lists = ['enabled_providers', 'movie_library', 'series_library'];
          for (const name of new Set(form.keys())) {
            const m = /^settings-([^-]+)-(.+)$/.exec(name);
            if (!m) continue;
            const [, section = '', key = ''] = m;
            const values = form.getAll(name);
            const v = lists.includes(key)
              ? values
              : key === 'password' && section === 'auth'
                ? md5(values[0] ?? '')
                : asType(values[0] ?? '');
            (state.settings[section] ??= {})[key] = v;
          }
          if (form.has('languages-enabled')) {
            const on = form.getAll('languages-enabled');
            state.langs = state.langs.map((l) => ({ ...l, enabled: on.includes(l.code2) }));
          }
          const profiles = form.get('languages-profiles');
          if (profiles)
            state.profiles = (JSON.parse(profiles) as Record<string, unknown>[]).map((p) => ({
              ...p,
              originalFormat: 0,
            }));
          return reply(204);
        }
        case '/plex/apikey':
          state.plexToken = form.get('apikey') ?? '';
          return reply(200);
        case '/movies':
        case '/series': {
          const ids = form.getAll(path === '/movies' ? 'radarrid' : 'seriesid').map(Number);
          for (const t of path === '/movies' ? state.movies : state.series) {
            const id = 'radarrId' in t ? t.radarrId : t.sonarrSeriesId;
            if (ids.includes(id)) t.profileId = Number(form.get('profileid'));
          }
          return reply(204);
        }
        default:
          return reply(404);
      }
    }
    switch (path) {
      case '/system/status': {
        const on = statusCalls++ >= state.connectAfter;
        return reply(200, {
          data: { bazarr_version: '1.6.2', ...(on ? { radarr_version: '6.0.4', sonarr_version: '4.0.20' } : {}) },
        });
      }
      case '/system/settings':
        return reply(200, state.settings);
      case '/system/languages':
        return reply(200, state.langs);
      case '/system/languages/profiles':
        return reply(200, state.profiles);
      case '/plex/webhook/list':
        return state.plexToken === 'pt' ? reply(200, { data: { webhooks: [] } }) : reply(500, { message: 'no token' });
      case '/movies':
        return reply(200, { data: state.movies, total: state.movies.length });
      case '/series':
        return reply(200, { data: state.series, total: state.series.length });
      case '/badges':
        return reply(200, { movies: 3, episodes: 12, providers: 0 });
      case '/system/health':
        return reply(200, { data: state.health });
      default:
        return reply(404);
    }
  };
  return { http, posts, statusCalls: () => statusCalls };
}

async function run(argv: string[], state: State, opts: { env?: Record<string, string>; config?: string } = {}) {
  const fake = fakeBazarr(state);
  const config = join(mkdtempSync(join(tmp, 'run-')), 'config.yaml');
  if (opts.config !== '') writeFileSync(config, opts.config ?? `auth:\n  apikey: ${KEY}\n`);
  const lines: string[] = [];
  const errs: string[] = [];
  let clock = 0;
  const code = await main(argv, {
    http: fake.http,
    log: (l) => void lines.push(l),
    err: (l) => void errs.push(l),
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    env: { ...ENV, BAZARR_CONFIG: config, ...opts.env },
    repo: tmp,
  });
  return { code, lines, errs, ...fake };
}

const CLEAN_READBACK = [
  'Read-back:',
  '  ok       settings: Radarr/Sonarr, default profile, providers subtis,yifysubtitles,subtitulamostv,gestdown, Plex refresh, form login',
  '  warn     OpenSubtitles.com off — set OPENSUBTITLES_USER/PASS in .env for its catalogue',
  '  ok       languages: es en',
  "  ok       one profile: 'Spanish + English' (es en)",
  '  ok       radarr connected (6.0.4)',
  '  ok       sonarr connected (4.0.20)',
  '  ok       Plex token accepted',
  '  info     wanted: 3 movie(s), 12 episode(s)',
];

describe('main', () => {
  test('--check on the configured box: no drift, nothing written', async () => {
    const r = await run(['--check'], configured());
    expect(r.code).toBe(0);
    expect(r.lines).toEqual(['Bazarr at http://127.0.0.1:6767 (check)', '  up: 1.6.2', ...CLEAN_READBACK, 'No drift.']);
    expect(r.posts).toEqual([]);
  });

  test('apply on the configured box writes nothing', async () => {
    const r = await run([], configured());
    expect(r.code).toBe(0);
    expect(r.lines.slice(2, 4)).toEqual(['  settings already set', '  Plex token already set']);
    expect(r.posts).toEqual([]);
  });

  test('the first run: every setting, languages, profile, token and titles, then no drift', async () => {
    const s = fresh();
    const r = await run([], s);
    expect(r.code).toBe(0);
    const set = r.lines[2] ?? '';
    expect(set).toStartWith('  settings set: general.use_radarr radarr.ip ');
    expect(set).toContain(' radarr.apikey (hidden) ');
    expect(set).toContain(' auth.password (hidden) ');
    expect(set).toEndWith(" languages:es en profile:'Spanish + English'");
    expect(set).not.toContain('rk');
    expect(r.lines.slice(3, 6)).toEqual([
      '  Plex token set (stored encrypted)',
      "  'Spanish + English' given to 2 movie(s) that had no profile",
      "  'Spanish + English' given to 1 series that had no profile",
    ]);
    expect(r.lines.slice(6)).toEqual([...CLEAN_READBACK, 'No drift.']);
    expect(s.settings.auth?.password).toBe(md5('p&ss=1'));
    expect(r.posts.find((p) => p.path === '/movies')?.form.toString()).toBe(
      'radarrid=1&profileid=1&radarrid=2&profileid=1',
    );
  });

  test('only the drifted keys are written', async () => {
    const s = configured();
    s.settings.radarr!.port = 7879;
    const r = await run([], s);
    expect(r.code).toBe(0);
    expect(r.lines[2]).toBe('  settings set: radarr.port');
    expect(r.posts.map((p) => p.form.toString())).toEqual(['settings-radarr-port=7878']);
  });

  test('a WebUI profile is replaced by the one profile', async () => {
    const s = configured();
    s.profiles = [...s.profiles, { profileId: 2, name: 'Extra', cutoff: null, items: [{ language: 'fr' }] }];
    const r = await run([], s);
    expect(r.lines[2]).toBe("  settings set: profile:'Spanish + English'");
    expect(JSON.parse(r.posts[0]?.form.get('languages-profiles') ?? '')).toEqual(wantProfiles());
  });

  test('--check names drift, never values, and says how to apply', async () => {
    const s = configured();
    s.settings.sonarr!.apikey = 'old';
    s.langs[2]!.enabled = true;
    s.series[0]!.profileId = null;
    const r = await run(['--check'], s);
    expect(r.code).toBe(1);
    expect(r.lines).toContain('  DRIFT    settings: sonarr.apikey');
    expect(r.lines).toContain('  DRIFT    languages enabled: en,es,fr, want es en');
    expect(r.lines).toContain('  DRIFT    1 series without a language profile');
    expect(r.lines.join('\n')).not.toContain('old');
    expect(r.lines.at(-1)).toBe('To apply: task bazarr:configure');
    expect(r.posts).toEqual([]);
  });

  test('a drifted profile list is shown by its shape', async () => {
    const s = configured();
    s.profiles = [];
    const r = await run(['--check'], s);
    expect(r.lines).toContain('  DRIFT    language profiles: []');
  });

  test('Radarr/Sonarr connect late: re-asked, then ok', async () => {
    const s = configured();
    s.connectAfter = 3;
    const r = await run(['--check'], s);
    expect(r.code).toBe(0);
    expect(r.lines).toContain('  ok       radarr connected (6.0.4)');
  });

  test('never connected, or a refused Plex token: FAILING, which only warns', async () => {
    const s = configured();
    s.connectAfter = 1000;
    s.plexToken = 'old';
    const r = await run(['--check'], s, { env: { CONNECT_SETTLE: '2' } });
    expect(r.code).toBe(0);
    expect(r.lines).toContain('  FAILING  radarr not connected — Bazarr reports no version');
    expect(r.lines).toContain('  FAILING  sonarr not connected — Bazarr reports no version');
    expect(r.lines).toContain('  FAILING  Plex token refused — Plex will not refresh after a download');
  });

  test('with an OpenSubtitles account: first provider, and no warning', async () => {
    const s = configured();
    s.settings = nest(wantSettings({ ...SECRETS, osUser: 'me', osPass: 'pw' }));
    const r = await run(['--check'], s, { env: { OPENSUBTITLES_USER: 'me', OPENSUBTITLES_PASS: 'pw' } });
    expect(r.code).toBe(0);
    expect(r.lines[3]).toContain('providers opensubtitlescom,subtis,');
    expect(r.lines.join('\n')).not.toContain('OpenSubtitles.com off');
  });

  test("Bazarr's health issues are shown", async () => {
    const s = configured();
    s.health = [{ object: 'Sonarr', issue: 'unreachable' }, { other: 1 }];
    const r = await run(['--check'], s);
    expect(r.lines).toContain('  warn     health: Sonarr unreachable');
    expect(r.lines).toContain('  warn     health:  {"other":1}');
  });

  test('a refused write fails the run with its body', async () => {
    const s = configured();
    s.settings.radarr!.port = 1;
    const fake = fakeBazarr(s);
    const config = join(mkdtempSync(join(tmp, 'run-')), 'config.yaml');
    writeFileSync(config, `auth:\n  apikey: ${KEY}\n`);
    const lines: string[] = [];
    const code = await main([], {
      http: async (url, req) =>
        req.method === 'POST' ? { status: 400, text: 'bad form', headers: new Headers() } : fake.http(url, req),
      log: (l) => void lines.push(l),
      err: () => {},
      sleep: async () => {},
      now: () => 0,
      env: { ...ENV, BAZARR_CONFIG: config },
      repo: tmp,
    });
    expect(code).toBe(1);
    expect(lines.at(-1)).toBe('  FAIL  write settings (HTTP 400): bad form');
  });

  test('a refused key: 3', async () => {
    const r = await run(['--check'], configured(), { config: 'auth:\n  apikey: wrong\n' });
    expect(r.code).toBe(3);
    expect(r.lines.at(-1)).toEndWith('config.yaml is refused');
  });

  test('no key yet: waits BAZARR_WAIT, then 3', async () => {
    const r = await run(['--check'], configured(), { config: '', env: { BAZARR_WAIT: '9' } });
    expect(r.code).toBe(3);
    expect(r.errs[0]).toEndWith('after 9s — is bazarr running? (docker compose ps bazarr)');
  });

  test('not answering: 3', async () => {
    const s = configured();
    s.up = false;
    const r = await run(['--check'], s, { env: { BAZARR_WAIT: '9' } });
    expect(r.code).toBe(3);
    expect(r.lines.at(-1)).toBe('  FAIL  not answering at http://127.0.0.1:6767 — is it running?');
  });

  test('missing .env keys: 3, naming them', async () => {
    const r = await run([], configured(), { env: { ARR_PASS: '', PLEX_TOKEN: '' } });
    expect(r.code).toBe(3);
    expect(r.errs).toEqual([`Set ARR_PASS PLEX_TOKEN in ${tmp}/.env.`]);
  });

  test('a word it does not know is a usage error', async () => {
    await expect(run(['--apply'], configured())).rejects.toThrow('usage: configure.sh [--check]');
  });
});
