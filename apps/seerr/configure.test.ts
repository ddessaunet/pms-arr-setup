// apps/seerr/configure.test.ts — the pure helpers, and main against a fake Seerr.
//
// Offline, and changes nothing outside a temp dir. The live behaviour was
// checked on a throwaway Seerr 3.5.0 against the real Plex, Radarr and Sonarr:
// the API key refused (403) until an admin exists, read-only fields (apiKey,
// machineId, id) rejected in writes, libraries synced by POST
// /settings/plex/library/sync and toggled by PUT /settings/plex/library/{id},
// and the Plex server recorded as f3860770… — the Phase 1b server. The fake
// below answers the same way.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpRequest, HttpResponse } from '../../stack/lib/http.ts';
import { readSeerrKey } from '../../stack/lib/keys.ts';
import type { ApiResult } from '../../stack/lib/servarr.ts';
import {
  enabledLibraries,
  identityOf,
  main,
  PROFILE_NAME,
  profileId,
  profileMissingMsg,
  seerrError,
  serverDrift,
  settledProfileId,
  wantedLibraries,
  wantMain,
  wantPlex,
  wantServer,
  type App,
} from './configure.ts';

const tmp = mkdtempSync(join(tmpdir(), 'seerr-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// ─── the API key ──────────────────────────────────────────────────────────────
describe('seerr_key', () => {
  test('read from settings.json', () => {
    writeFileSync(join(tmp, 'settings.json'), '{"main":{"apiKey":"MTc5MDk=","newPlexLogin":true}}');
    expect(readSeerrKey(join(tmp, 'settings.json'))).toBe('MTc5MDk=');
  });
  test('missing file → empty', () => expect(readSeerrKey(join(tmp, 'none.json'))).toBe(''));
  test('garbage → empty, no error', () => {
    writeFileSync(join(tmp, 'bad.json'), 'not json');
    expect(readSeerrKey(join(tmp, 'bad.json'))).toBe('');
  });
});

// ─── the profile id comes from the app ────────────────────────────────────────
describe('profile_id', () => {
  const T = {
    profiles: [
      { id: 1, name: 'Any' },
      { id: 4, name: 'HD-1080p' },
      { id: 5, name: 'Ultra-HD' },
    ],
    rootFolders: [],
  };
  test('HD-1080p → 4', () => expect(profileId(T, 'HD-1080p')).toBe(4));
  test('missing profile → empty', () => expect(profileId(T, 'Remux-2160p')).toBeUndefined());
  test('no profiles at all → empty', () => expect(profileId({}, 'HD-1080p')).toBeUndefined());
});

// ─── the server payloads ──────────────────────────────────────────────────────
describe('want_server', () => {
  const R = wantServer('radarr', 4, 'rk', '192.168.0.86') as Record<string, unknown>;
  test('radarr: container name and port', () => expect(`${R.hostname}:${R.port}`).toBe('radarr:7878'));
  test('radarr: its .env key', () => expect(R.apiKey).toBe('rk'));
  test('radarr: 4K HDR profile by the given id', () =>
    expect(`${R.activeProfileId} ${R.activeProfileName}`).toBe('4 UHD Bluray + WEB'));
  test('sonarr requests default to WEB-1080p', () => expect(PROFILE_NAME.sonarr).toBe('WEB-1080p'));
  test('radarr: movies root', () => expect(R.activeDirectory).toBe('/mnt/data/streaming/movies'));
  test('radarr: default, not 4K', () => expect(`${R.isDefault} ${R.is4k}`).toBe('true false'));
  test('radarr: released only', () => expect(R.minimumAvailability).toBe('released'));
  test('radarr: LAN link', () => expect(R.externalUrl).toBe('http://192.168.0.86:7878'));
  test('radarr: never an id (read-only in writes)', () => expect('id' in R).toBe(false));
  const S = wantServer('sonarr', 4, 'sk', '192.168.0.86') as Record<string, unknown>;
  test('sonarr: container name and port', () => expect(`${S.hostname}:${S.port}`).toBe('sonarr:8989'));
  test('sonarr: series root', () => expect(S.activeDirectory).toBe('/mnt/data/streaming/series'));
  test('sonarr: anime uses the same profile and root', () =>
    expect(`${S.activeAnimeProfileId} ${S.activeAnimeDirectory}`).toBe('4 /mnt/data/streaming/series'));
  test('sonarr: season folders', () => expect(S.enableSeasonFolders).toBe(true));
  test('sonarr: no radarr-only key', () => expect('minimumAvailability' in S).toBe(false));
  test('names are capitalised', () => expect(`${R.name} ${S.name}`).toBe('Radarr Sonarr'));
});

// ─── drift ────────────────────────────────────────────────────────────────────
describe('server_drift', () => {
  const R = wantServer('radarr', 4, 'rk', '192.168.0.86');
  const GOT = { ...R, id: 1, apiKey: 'masked-or-other' };
  test('equal apart from id and apiKey → no drift', () => expect(serverDrift(GOT, R)).toEqual([]));
  test('profile id changed, name kept → named', () =>
    expect(serverDrift({ ...GOT, activeProfileId: 5 }, R)).toEqual(['activeProfileId']));
  test('moved to 4K → named', () => expect(serverDrift({ ...GOT, is4k: true }, R)).toEqual(['is4k']));
});

// ─── libraries and sign-in ────────────────────────────────────────────────────
describe('libraries / main / plex', () => {
  const L = [
    { id: '2', name: 'Movies', type: 'movie', enabled: true },
    { id: '3', name: 'TV Shows', type: 'show', enabled: true },
    { id: '4', name: 'Other Videos', type: 'movie', enabled: false },
  ];
  test('enabled = wanted', () => expect(enabledLibraries(L)).toEqual(wantedLibraries()));
  test('Other Videos is not wanted', () => expect(wantedLibraries()).not.toContain('Other Videos'));
  test('a disabled TV library is visible', () =>
    expect(enabledLibraries(L.map((l) => (l.name === 'TV Shows' ? { ...l, enabled: false } : l)))).toEqual(['Movies']));
  test('only the admin signs in', () => expect(JSON.stringify(wantMain())).toBe('{"newPlexLogin":false}'));
  test('Plex through the host gateway, no read-only fields', () =>
    expect(JSON.stringify(wantPlex())).toBe('{"ip":"host.docker.internal","port":32400,"useSsl":false}'));
  test("Plex's identity", () =>
    expect(
      identityOf(
        '<?xml version="1.0"?>\n<MediaContainer size="0" claimed="1" machineIdentifier="f3860770abc" version="1.43"/>',
      ),
    ).toBe('f3860770abc'));
  test('no identity → empty', () => expect(identityOf('')).toBe(''));
});

describe('the error shown for a failed call', () => {
  test("Seerr's own {message}", () =>
    expect(seerrError('{"message":"Unable to connect to Radarr."}')).toBe('Unable to connect to Radarr.'));
  test('a Servarr-style list', () => expect(seerrError('[{"errorMessage":"bad path"}]')).toBe('bad path'));
  test('not JSON → empty', () => expect(seerrError('<html>')).toBe(''));
});

// ─── the profile appears late (right after a Recyclarr sync) ──────────────────
describe('settled_profile_id', () => {
  const OLD = { profiles: [{ id: 4, name: 'HD-1080p' }] };
  const NEW = {
    profiles: [
      { id: 4, name: 'HD-1080p' },
      { id: 7, name: 'UHD Bluray + WEB' },
    ],
  };
  // api answers from a queue of test responses; each call takes the next one and
  // the last one repeats. sleep is a no-op so the retries cost nothing.
  function queue(answers: unknown[], fail = false) {
    let calls = 0;
    const api = async (): Promise<ApiResult> => {
      const json = answers[Math.min(calls++, answers.length - 1)];
      return fail
        ? { ok: false, status: 500, text: '', json: undefined }
        : { ok: true, status: 200, text: JSON.stringify(json), json };
    };
    return { deps: (settle: number) => ({ api, sleep: async () => {}, settle }), calls: () => calls };
  }
  test('missing twice, then there → found', async () => {
    const q = queue([OLD, OLD, NEW]);
    expect(await settledProfileId('radarr', {}, q.deps(6))).toEqual({ kind: 'found', pid: 7 });
    expect(q.calls()).toBe(3);
  });
  test('never there → 2 after PROFILE_SETTLE tries', async () => {
    const q = queue([OLD]);
    expect(await settledProfileId('radarr', {}, q.deps(4))).toEqual({ kind: 'missing' });
    expect(q.calls()).toBe(4);
  });
  test('there at once → one call', async () => {
    const q = queue([NEW]);
    expect(await settledProfileId('radarr', {}, q.deps(6))).toEqual({ kind: 'found', pid: 7 });
    expect(q.calls()).toBe(1);
  });
  test('the test itself fails → 1, no retries', async () => {
    const q = queue([NEW], true);
    expect((await settledProfileId('radarr', {}, q.deps(6))).kind).toBe('failed');
    expect(q.calls()).toBe(1);
  });
  test('the message no longer assumes the sync was skipped', () =>
    expect(profileMissingMsg('radarr', 6)).toContain('did task recyclarr:sync finish'));
  test('the message gives the time waited', () => expect(profileMissingMsg('radarr', 6)).toContain('after ~10s'));
});

// ─── main, against a fake Seerr ───────────────────────────────────────────────

const MID = 'f3860770deadbeef';
const LAN = '10.0.0.50';
const KEY = 'seerr-key';

interface Server extends Record<string, unknown> {
  id: number;
  is4k: boolean;
}
interface State {
  up: boolean;
  admin: boolean;
  plex: Record<string, unknown>;
  libs: { id: string; name: string; enabled: boolean }[];
  servers: Record<App, Server[]>;
  /** What each app's test lists, per call; the last repeats. */
  profiles: Record<App, { id: number; name: string }[][]>;
  testFails: Partial<Record<App, string>>;
  main: Record<string, unknown>;
  initialized: boolean;
  identity: string;
  available: number;
  /** A write to answer with this status and message. */
  refuse?: { path: string; status: number; message: string };
}

const PROFILES = {
  radarr: [
    [
      { id: 1, name: 'Any' },
      { id: 9, name: 'UHD Bluray + WEB' },
    ],
  ],
  sonarr: [
    [
      { id: 1, name: 'Any' },
      { id: 6, name: 'WEB-1080p' },
    ],
  ],
};
const LIBS = () => [
  { id: '1', name: 'Movies', enabled: false },
  { id: '2', name: 'TV Shows', enabled: false },
  { id: '3', name: 'Other Videos', enabled: true },
];

/** Signed in, nothing else: the state the first run meets. */
function fresh(): State {
  return {
    up: true,
    admin: true,
    plex: { name: '', machineId: '', ip: '', port: 32400, useSsl: false, libraries: [] },
    libs: LIBS(),
    servers: { radarr: [], sonarr: [] },
    profiles: structuredClone(PROFILES),
    testFails: {},
    main: { apiKey: KEY, newPlexLogin: true, applicationTitle: 'Seerr' },
    initialized: false,
    identity: MID,
    available: 0,
  };
}

/** As the box has it. */
function configured(): State {
  const s = fresh();
  s.plex = { ...s.plex, ...wantPlex(), name: 'pms', machineId: MID };
  s.libs = s.libs.map((l) => ({ ...l, enabled: l.name !== 'Other Videos' }));
  s.servers = {
    radarr: [{ ...wantServer('radarr', 9, 'rk', LAN), id: 0 } as Server],
    sonarr: [{ ...wantServer('sonarr', 6, 'sk', LAN), id: 0 } as Server],
  };
  s.main = { ...s.main, newPlexLogin: false };
  s.initialized = true;
  s.available = 1234;
  return s;
}

const READ_ONLY: Record<string, string[]> = {
  '/settings/plex': ['name', 'machineId', 'libraries'],
  '/settings/main': ['apiKey'],
};

function fakeSeerr(state: State) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  const testCalls: Record<App, number> = { radarr: 0, sonarr: 0 };
  const reply = (status: number, body?: unknown): HttpResponse => ({
    status,
    text: body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body),
    headers: new Headers(),
  });
  const http = async (url: string, req: HttpRequest): Promise<HttpResponse> => {
    const u = new URL(url);
    if (u.port === '32400')
      return u.pathname === '/identity'
        ? reply(200, `<MediaContainer machineIdentifier="${state.identity}"/>`)
        : reply(404);
    if (!state.up) return reply(0);
    const path = u.pathname.replace(/^\/api\/v1/, '');
    const method = req.method ?? 'GET';
    if (path === '/status') return reply(200, { version: '3.5.1', commitTag: 'x' });
    if (path === '/settings/public') return reply(200, { initialized: state.initialized, plexClientIdentifier: 'c' });
    if (req.headers?.['X-Api-Key'] !== KEY || !state.admin)
      return reply(403, { message: 'You do not have permission to access this endpoint' });
    const body = req.body === undefined || req.body === '' ? undefined : JSON.parse(String(req.body));
    if (method !== 'GET' && !path.endsWith('/test')) {
      writes.push({ method, path, body });
      const ro = (READ_ONLY[path] ?? ['id']).filter((k) => body && k in body);
      if (ro.length) return reply(400, { message: `read-only: ${ro.join(',')}` });
      if (/^\/settings\/(radarr|sonarr)/.test(path) && body && 'id' in body)
        return reply(400, { message: 'read-only: id' });
      if (state.refuse?.path === path) return reply(state.refuse.status, { message: state.refuse.message });
    }
    const app = /^\/settings\/(radarr|sonarr)/.exec(path)?.[1] as App | undefined;
    switch (true) {
      case path === '/settings/main' && method === 'GET':
        return reply(200, state.main);
      case path === '/settings/main':
        state.main = { ...state.main, ...body };
        return reply(200, state.main);
      case path === '/settings/plex' && method === 'GET':
        return reply(200, state.plex);
      case path === '/settings/plex':
        state.plex = { ...state.plex, ...body, name: 'pms', machineId: state.identity };
        return reply(200, state.plex);
      case path === '/settings/plex/library':
        return reply(200, state.libs);
      case path === '/settings/plex/library/sync':
        return reply(200, state.libs);
      case path.startsWith('/settings/plex/library/'): {
        const lib = state.libs.find((l) => l.id === path.split('/').pop());
        if (!lib) return reply(404);
        lib.enabled = body.enabled;
        return reply(200, lib);
      }
      case app !== undefined && path.endsWith('/test'): {
        if (state.testFails[app!]) return reply(500, { message: state.testFails[app!] });
        const list = state.profiles[app!];
        const profiles = list[Math.min(testCalls[app!]++, list.length - 1)];
        return reply(200, { profiles, rootFolders: [] });
      }
      case app !== undefined && method === 'GET':
        return reply(200, state.servers[app!]);
      case app !== undefined && method === 'POST': {
        const s = { ...body, id: state.servers[app!].length } as Server;
        state.servers[app!].push(s);
        return reply(201, s);
      }
      case app !== undefined && method === 'PUT': {
        const id = Number(path.split('/').pop());
        const i = state.servers[app!].findIndex((s) => s.id === id);
        state.servers[app!][i] = { ...body, id } as Server;
        return reply(200, state.servers[app!][i]);
      }
      case path === '/settings/initialize':
        state.initialized = true;
        return reply(200, { initialized: true });
      case path === '/settings/jobs/plex-full-scan/run':
        return reply(200, { id: 'plex-full-scan' });
      case path === '/media':
        return reply(200, { pageInfo: { page: 1, pages: state.available, results: state.available }, results: [] });
      default:
        return reply(404);
    }
  };
  return { http, writes, testCalls };
}

async function run(argv: string[], state: State, opts: { env?: Record<string, string>; settings?: string } = {}) {
  const fake = fakeSeerr(state);
  const settings = join(mkdtempSync(join(tmp, 'run-')), 'settings.json');
  writeFileSync(settings, opts.settings ?? JSON.stringify({ main: { apiKey: KEY } }));
  const lines: string[] = [];
  const errs: string[] = [];
  let clock = 0;
  const code = await main(argv, {
    http: fake.http,
    log: (l) => void lines.push(l),
    err: (l) => void errs.push(l),
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    lanIps: () => [LAN],
    env: { RADARR_API_KEY: 'rk', SONARR_API_KEY: 'sk', SEERR_SETTINGS: settings, ...opts.env },
    repo: tmp,
  });
  return { code, lines, errs, ...fake };
}

const CLEAN_READBACK = [
  'Read-back:',
  `  ok       Plex server pms (${MID})`,
  '  ok       libraries: Movies TV Shows',
  '  ok       radarr server — test passes, UHD Bluray + WEB (id 9)',
  '  ok       sonarr server — test passes, WEB-1080p (id 6)',
  '  ok       sign-in admin-only',
  '  ok       setup finished',
];

describe('main', () => {
  test('--check on the configured box: no drift, nothing written', async () => {
    const r = await run(['--check'], configured());
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([
      'Seerr at http://127.0.0.1:5055 (check)',
      '  up: 3.5.1',
      ...CLEAN_READBACK,
      '  info     1234 title(s) Available (from Plex)',
      'No drift.',
    ]);
    expect(r.writes).toEqual([]);
  });

  test('apply on the configured box changes nothing but the library sync', async () => {
    const r = await run([], configured());
    expect(r.code).toBe(0);
    expect(r.lines.slice(2, 8)).toEqual([
      '  Plex server already set',
      '  libraries already set',
      '  radarr server already set',
      '  sonarr server already set',
      '  sign-in already admin-only',
      '  setup already finished',
    ]);
    expect(r.writes.map((w) => `${w.method} ${w.path}`)).toEqual(['POST /settings/plex/library/sync']);
  });

  test('the first run: the whole wizard, then no drift', async () => {
    const s = fresh();
    const r = await run([], s);
    expect(r.code).toBe(0);
    expect(r.lines.slice(2, 12)).toEqual([
      `  Plex server set: pms (${MID})`,
      '  libraries set: Movies TV Shows',
      '  radarr server added (UHD Bluray + WEB)',
      '  sonarr server added (WEB-1080p)',
      '  sign-in set to admin-only (newPlexLogin off)',
      '  setup wizard marked finished',
      '  Plex full scan started (marks the existing library Available)',
      ...CLEAN_READBACK.slice(0, 3),
    ]);
    expect(r.lines.at(-1)).toBe('No drift.');
    expect(s.libs.map((l) => `${l.name}=${l.enabled}`)).toEqual(['Movies=true', 'TV Shows=true', 'Other Videos=false']);
    expect(s.servers.radarr[0]).toMatchObject({ activeProfileId: 9, apiKey: 'rk', externalUrl: `http://${LAN}:7878` });
    expect(s.servers.sonarr[0]).toMatchObject({ activeAnimeProfileId: 6, apiKey: 'sk' });
  });

  // The fake answers 400 to a read-only field, as Seerr does; this names them.
  test('writes never carry a read-only field', async () => {
    const r = await run([], fresh());
    const sent = r.writes.map(
      (w) =>
        `${w.path} ${Object.keys((w.body ?? {}) as object).filter((k) => ['id', 'apiKey', 'machineId', 'name', 'libraries'].includes(k))}`,
    );
    expect(sent).toContain('/settings/plex ');
    expect(sent).toContain('/settings/main ');
    expect(sent).toContain('/settings/radarr name,apiKey'); // a server's own key and name are writable
    expect(r.writes.every((w) => !('id' in ((w.body ?? {}) as object)))).toBe(true);
  });

  test('a drifted server is updated in place, named by what changed', async () => {
    const s = configured();
    s.servers.radarr[0] = { ...s.servers.radarr[0]!, activeProfileId: 1, externalUrl: 'http://192.168.0.86:7878' };
    const r = await run([], s);
    expect(r.code).toBe(0);
    expect(r.lines).toContain('  radarr server updated (activeProfileId externalUrl)');
    expect(r.writes.filter((w) => w.method === 'PUT').map((w) => w.path)).toEqual(['/settings/radarr/0']);
  });

  test('--check names drift and says how to apply', async () => {
    const s = configured();
    s.servers.sonarr[0] = { ...s.servers.sonarr[0]!, is4k: false, activeDirectory: '/tv' };
    s.main.newPlexLogin = true;
    const r = await run(['--check'], s);
    expect(r.code).toBe(1);
    expect(r.lines).toContain('  DRIFT    sonarr: activeDirectory');
    expect(r.lines).toContain('  DRIFT    new Plex users can sign in');
    expect(r.lines.at(-1)).toBe('To apply: task seerr:configure');
    expect(r.writes).toEqual([]);
  });

  test('a missing server and a 4K-only one are both "missing"', async () => {
    const s = configured();
    s.servers.radarr = [{ ...s.servers.radarr[0]!, is4k: true }];
    s.servers.sonarr = [];
    const r = await run(['--check'], s);
    expect(r.code).toBe(1);
    expect(r.lines).toContain('  DRIFT    radarr server missing');
    expect(r.lines).toContain('  DRIFT    sonarr server missing');
  });

  test('Plex answering as another server is drift', async () => {
    const s = configured();
    s.identity = 'other';
    const r = await run(['--check'], s);
    expect(r.code).toBe(1);
    expect(r.lines).toContain(`  DRIFT    Plex server is '${MID}', but Plex answers as 'other'`);
  });

  test('a library switched off is drift', async () => {
    const s = configured();
    s.libs[1]!.enabled = false;
    s.libs[2]!.enabled = true;
    const r = await run(['--check'], s);
    expect(r.lines).toContain('  DRIFT    libraries enabled: Movies,Other Videos, want Movies TV Shows');
  });

  test("a failing connection test only warns, with Seerr's message", async () => {
    const s = configured();
    s.testFails.sonarr = 'Failed to connect to Sonarr';
    const r = await run(['--check'], s);
    expect(r.code).toBe(0);
    expect(r.lines).toContain('  FAILING  sonarr server — test fails: Failed to connect to Sonarr');
  });

  test('a profile that never shows up is drift, after PROFILE_SETTLE tries', async () => {
    const s = configured();
    s.profiles.radarr = [[{ id: 1, name: 'Any' }]];
    const r = await run(['--check'], s, { env: { PROFILE_SETTLE: '3' } });
    expect(r.code).toBe(1);
    expect(r.testCalls.radarr).toBe(3);
    expect(r.lines).toContain(`  DRIFT    ${profileMissingMsg('radarr', 3)}`);
  });

  test('a refused write fails the run with the reason', async () => {
    const s = fresh();
    s.refuse = { path: '/settings/radarr', status: 400, message: 'Root folder not found' };
    const r = await run([], s);
    expect(r.code).toBe(1);
    expect(r.lines.at(-1)).toBe('  FAIL  add radarr (HTTP 400): Root folder not found');
    expect(r.lines).not.toContain('Read-back:');
  });

  test('no admin yet: says to sign in, at the LAN address, and stops', async () => {
    const s = fresh();
    s.admin = false;
    const r = await run([], s);
    expect(r.code).toBe(3);
    expect(r.lines.at(-1)).toBe(
      `  Sign in first: open http://${LAN}:5055 and sign in with Plex (just that — this script does the rest of the wizard).`,
    );
    expect(r.writes).toEqual([]);
  });

  test('not answering: 3 after SEERR_WAIT', async () => {
    const s = fresh();
    s.up = false;
    const r = await run(['--check'], s, { env: { SEERR_WAIT: '9' } });
    expect(r.code).toBe(3);
    expect(r.lines.at(-1)).toBe('  FAIL  not answering at http://127.0.0.1:5055 — is it running?');
  });

  test('no Radarr/Sonarr keys: 3, naming them', async () => {
    const r = await run([], fresh(), { env: { RADARR_API_KEY: '', SONARR_API_KEY: '' } });
    expect(r.code).toBe(3);
    expect(r.errs).toEqual([`Set RADARR_API_KEY SONARR_API_KEY in ${tmp}/.env.`]);
  });

  test('no Seerr key yet: 3', async () => {
    const r = await run([], fresh(), { settings: '{}' });
    expect(r.code).toBe(3);
    expect(r.errs[0]).toEndWith('— has Seerr started once?');
  });

  test('a word it does not know is a usage error', async () => {
    await expect(run(['--apply'], fresh())).rejects.toThrow('usage: configure.sh [--check]');
  });
});
