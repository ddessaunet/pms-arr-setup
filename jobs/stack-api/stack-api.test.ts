// jobs/stack-api/stack-api.test.ts — the sign-in, the session and the gate,
// against a fake plex.tv and an in-memory store; the request doctor's routes
// against fake apps (and a real release search's answer, testdata/); and the
// service itself, on a scratch socket.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpRequest, HttpResponse } from '../../stack/lib/http.ts';
import type { RequestsDoc } from '../../stack/lib/request-doctor.ts';
import { makeApp, PIN_TTL, RateLimit, SESSION_COOKIE, type AppDeps } from './app.ts';
import {
  addRequestRoutes,
  failingIndexers,
  openRequests,
  parseHistory,
  parseQueue,
  parseReleases,
  parseSeerrRequests,
  parseSeries,
  seasonToSearch,
} from './requests.ts';
import { main } from './stack-api.ts';
import { sessionHash, Store } from './store.ts';

const SERVER = 'srv-1';
const ORIGIN = 'http://10.0.0.50:8088';

interface Plex {
  /** What /api/v2/pins/:id says: null pending, a token, or 404. */
  pin: string | null | 404;
  /** The servers the token's account has. */
  resources: { clientIdentifier: string; owned: boolean }[];
  down: boolean;
}

let plex: Plex;
let clock: number;
let logs: string[];
let store: Store;
let seen: { url: string; req: HttpRequest }[];

const answer = (status: number, body: unknown): HttpResponse => ({
  status,
  text: JSON.stringify(body),
  headers: new Headers(),
});

function deps(): AppDeps {
  return {
    store,
    now: () => clock,
    log: (l) => logs.push(l),
    serverId: SERVER,
    random: (n) => new Uint8Array(n).fill(7),
    plexBase: 'https://plex.test',
    http: async (url, req) => {
      seen.push({ url, req });
      if (plex.down) return { status: 0, text: '', headers: new Headers(), error: 'refused' };
      const path = url.replace('https://plex.test', '');
      if (path === '/api/v2/pins?strong=true') return answer(201, { id: 42, code: 'CODE' });
      if (path === '/api/v2/pins/42')
        return plex.pin === 404 ? answer(404, {}) : answer(200, { id: 42, authToken: plex.pin });
      if (path === '/api/v2/user') return answer(200, { id: 1, uuid: 'u1', username: 'owner', title: 'Owner' });
      if (path === '/api/v2/resources?includeHttps=1') return answer(200, plex.resources);
      return answer(404, {});
    },
  };
}

beforeEach(() => {
  plex = { pin: null, resources: [{ clientIdentifier: SERVER, owned: true }], down: false };
  clock = 1_800_000_000_000;
  logs = [];
  seen = [];
  store = new Store(':memory:');
});

const app = () => makeApp(deps());
const get = (a: ReturnType<typeof makeApp>, path: string, headers: Record<string, string> = {}) =>
  a.request(path, { headers: { host: '10.0.0.50:8088', ...headers } });
const post = (a: ReturnType<typeof makeApp>, path: string, headers: Record<string, string> = {}) =>
  a.request(path, {
    method: 'POST',
    headers: { host: '10.0.0.50:8088', origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...headers },
  });
const cookieOf = (r: Response) => /pms_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1] ?? '';

/** The whole sign-in, as the login page does it: the session cookie's value. */
async function signIn(a = app()): Promise<string> {
  await post(a, '/api/auth/pin');
  plex.pin = 'plex-token';
  return cookieOf(await get(a, '/api/auth/pin/42'));
}

describe('health and the gate', () => {
  test('health needs no session', async () => {
    const r = await get(app(), '/api/health');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(r.headers.get('cache-control')).toBe('no-store');
  });
  test('check: 401 without a session, 204 with one', async () => {
    const a = app();
    expect((await get(a, '/api/auth/check')).status).toBe(401);
    const s = await signIn(a);
    expect((await get(a, '/api/auth/check', { cookie: `${SESSION_COOKIE}=${s}` })).status).toBe(204);
    expect((await get(a, '/api/auth/check', { cookie: `${SESSION_COOKIE}=forged` })).status).toBe(401);
  });
  test('a route outside auth needs a session', async () => {
    const a = app();
    a.get('/api/x', (c) => c.json({ user: c.get('session').username }));
    expect((await get(a, '/api/x')).status).toBe(401);
    const s = await signIn(a);
    expect(await (await get(a, '/api/x', { cookie: `${SESSION_COOKIE}=${s}` })).json()).toEqual({ user: 'owner' });
  });
  test('an unknown /api path is a JSON 404 (behind the gate)', async () => {
    const a = app();
    const s = await signIn(a);
    const r = await get(a, '/api/nope', { cookie: `${SESSION_COOKIE}=${s}` });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not found' });
  });
});

describe('signing in', () => {
  test('a PIN, and the plex.tv page to approve it', async () => {
    const r = await post(app(), '/api/auth/pin');
    const body = (await r.json()) as { id: number; authUrl: string };
    expect(body.id).toBe(42);
    expect(body.authUrl).toContain('code=CODE');
    expect(body.authUrl).toContain(`clientID=${store.clientId()}`);
    expect(store.pinCreated(42)).toBe(clock);
  });
  test('pending until approved', async () => {
    const a = app();
    await post(a, '/api/auth/pin');
    const r = await get(a, '/api/auth/pin/42');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ state: 'pending' });
    expect(r.headers.get('set-cookie')).toBeNull();
  });
  test('the owner gets a session cookie; the store keeps its hash, not it, nor the Plex token', async () => {
    const a = app();
    await post(a, '/api/auth/pin');
    plex.pin = 'plex-token';
    const r = await get(a, '/api/auth/pin/42');
    expect(await r.json()).toEqual({ state: 'ok', username: 'owner' });
    const set = r.headers.get('set-cookie') ?? '';
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Lax');
    expect(set).toContain('Path=/');
    const token = cookieOf(r);
    expect(token).toBe(Buffer.from(new Uint8Array(32).fill(7)).toString('base64url'));
    const rows = store.db.query('SELECT * FROM sessions').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hash).toBe(sessionHash(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(store.db.query('SELECT * FROM kv, pins').all())).not.toContain('plex-token');
    expect(logs).toEqual(['signed in: owner']);
  });
  test('the PIN is good once', async () => {
    const a = app();
    await signIn(a);
    expect((await get(a, '/api/auth/pin/42')).status).toBe(410);
  });
  test('someone who does not own the server is refused, and gets no cookie', async () => {
    const a = app();
    plex.resources = [{ clientIdentifier: SERVER, owned: false }];
    await post(a, '/api/auth/pin');
    plex.pin = 'plex-token';
    const r = await get(a, '/api/auth/pin/42');
    expect(r.status).toBe(403);
    expect(((await r.json()) as { state: string }).state).toBe('denied');
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(logs).toEqual(['sign-in refused: owner does not own this Plex server']);
  });
  test('a PIN this process never made', async () => {
    expect((await get(app(), '/api/auth/pin/42')).status).toBe(410);
    expect(seen).toHaveLength(0);
  });
  test('a PIN older than PIN_TTL, or one plex.tv expired', async () => {
    const a = app();
    await post(a, '/api/auth/pin');
    plex.pin = 404;
    expect(await (await get(a, '/api/auth/pin/42')).json()).toEqual({ state: 'expired' });
    await post(a, '/api/auth/pin');
    clock += PIN_TTL + 1;
    expect((await get(a, '/api/auth/pin/42')).status).toBe(410);
  });
  test('plex.tv away: 502, and the token is never in the log', async () => {
    const a = app();
    plex.down = true;
    expect((await post(a, '/api/auth/pin')).status).toBe(502);
    expect(logs[0]).toContain('plex.tv did not answer');
  });
  test('the client identifier is made once', () => {
    expect(store.clientId()).toBe(store.clientId());
  });
});

describe('the session', () => {
  test('me, then sign out', async () => {
    const a = app();
    const s = await signIn(a);
    const me = await get(a, '/api/auth/me', { cookie: `${SESSION_COOKIE}=${s}` });
    expect(((await me.json()) as { username: string }).username).toBe('owner');
    const out = await post(a, '/api/auth/logout', { cookie: `${SESSION_COOKIE}=${s}` });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await get(a, '/api/auth/check', { cookie: `${SESSION_COOKIE}=${s}` })).status).toBe(401);
  });
  test('it expires', async () => {
    const a = app();
    const s = await signIn(a);
    clock += 31 * 24 * 3600_000;
    expect((await get(a, '/api/auth/check', { cookie: `${SESSION_COOKIE}=${s}` })).status).toBe(401);
    store.prune(clock, PIN_TTL);
    expect(store.db.query('SELECT * FROM sessions').all()).toHaveLength(0);
  });
  test('check records lastSeen, at most once a minute', async () => {
    const a = app();
    const s = await signIn(a);
    const lastSeen = () => store.session(s, clock)?.lastSeen;
    clock += 30_000;
    await get(a, '/api/auth/check', { cookie: `${SESSION_COOKIE}=${s}` });
    expect(lastSeen()).toBe(clock - 30_000);
    clock += 60_000;
    await get(a, '/api/auth/check', { cookie: `${SESSION_COOKIE}=${s}` });
    expect(lastSeen()).toBe(clock);
  });
});

describe('cross-site requests and limits', () => {
  test('a POST from another origin is refused', async () => {
    const r = await post(app(), '/api/auth/pin', { origin: 'http://evil.test', 'sec-fetch-site': 'cross-site' });
    expect(r.status).toBe(403);
    expect(seen).toHaveLength(0);
  });
  test('sign-in starts are limited per address', async () => {
    const a = app();
    const codes = [];
    for (let i = 0; i < 11; i++) codes.push((await post(a, '/api/auth/pin', { 'x-real-ip': '10.0.0.9' })).status);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
    expect((await post(a, '/api/auth/pin', { 'x-real-ip': '10.0.0.10' })).status).toBe(200);
  });
  test('RateLimit: a sliding window', () => {
    const r = new RateLimit(2, 1000);
    expect([r.allow('a', 0), r.allow('a', 10), r.allow('a', 20), r.allow('a', 1011)]).toEqual([
      true,
      true,
      false,
      true,
    ]);
  });
});

describe('the service', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stack-api-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('listens on its socket (666, in a 755 folder), answers, and cleans up when stopped', async () => {
    let stop = () => {};
    const stopped = new Promise<void>((done) => (stop = done));
    const lines: string[] = [];
    const running = main([], {
      http: async () => ({ status: 0, text: '', headers: new Headers(), error: 'offline' }),
      log: (l) => lines.push(l),
      env: { APPDATA: dir },
      repo: dir,
      stopped: () => stopped,
    });
    const sock = join(dir, 'stack-api/run/api.sock');
    for (let i = 0; i < 100 && !lines.some((l) => l.startsWith('listening')); i++) await Bun.sleep(10);
    expect((statSync(sock).mode & 0o777).toString(8)).toBe('666');
    expect((statSync(join(dir, 'stack-api/run')).mode & 0o777).toString(8)).toBe('755');
    const r = await fetch('http://stack-api/api/health', { unix: sock });
    expect(await r.json()).toEqual({ ok: true });
    stop();
    expect(await running).toBe(0);
    expect(() => statSync(sock)).toThrow();
    expect(lines).toEqual([`listening on ${sock}`, 'stopped']);
  });

  test('-h prints the header', async () => {
    const lines: string[] = [];
    const code = await main(['-h'], {
      http: async () => ({ status: 0, text: '', headers: new Headers() }),
      log: (l) => lines.push(l),
      env: {},
      repo: dir,
      stopped: async () => {},
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain("the docs site's backend");
  });
});

// ─── the request doctor's routes (requests.ts) ────────────────────────────────

describe('requests', () => {
  const HOPE = JSON.parse(readFileSync(join(import.meta.dir, 'testdata/release-hope.json'), 'utf8')) as unknown[];
  const repo = mkdtempSync(join(tmpdir(), 'stack-api-repo-'));
  writeFileSync(
    join(repo, '.env'),
    'RADARR_API_KEY=radarr-key-123\nSONARR_API_KEY=sonarr-key-123\nPROWLARR_API_KEY=prowlarr-key\n',
  );
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  const seerrRequests = {
    results: [
      {
        id: 37,
        status: 2,
        type: 'movie',
        createdAt: '2026-10-27T23:19:20.000Z',
        requestedBy: { displayName: 'owner' },
        media: { mediaType: 'movie', tmdbId: 1058424, status: 3, externalServiceId: 148 },
        seasons: [],
      },
      {
        id: 36,
        status: 5,
        type: 'movie',
        createdAt: '2026-10-25T15:17:44.000Z',
        requestedBy: { displayName: 'owner' },
        media: { mediaType: 'movie', tmdbId: 1, status: 5, externalServiceId: 147 },
        seasons: [],
      },
      {
        id: 35,
        status: 2,
        type: 'tv',
        createdAt: '2026-10-22T22:46:55.000Z',
        requestedBy: { displayName: 'owner' },
        media: { mediaType: 'tv', tmdbId: 196322, status: 4, externalServiceId: 4 },
        seasons: [{ seasonNumber: 2 }],
      },
    ],
  };
  let searches = 0;
  let radarrDown = false;
  const routes: Record<string, unknown> = {
    'http://127.0.0.1:5055/api/v1/request?take=200&skip=0&filter=all&sort=added': seerrRequests,
    'http://127.0.0.1:7878/api/v3/qualityprofile': [{ id: 7, name: 'UHD Bluray + WEB' }],
    'http://127.0.0.1:8989/api/v3/qualityprofile': [{ id: 7, name: 'WEB-1080p' }],
    'http://127.0.0.1:9696/api/v1/health': [],
    'http://127.0.0.1:7878/api/v3/movie/148': {
      id: 148,
      title: 'Hope',
      year: 2026,
      monitored: true,
      hasFile: false,
      qualityProfileId: 7,
      runtime: 157,
      isAvailable: true,
      status: 'released',
    },
    'http://127.0.0.1:7878/api/v3/queue?movieIds=148&pageSize=50': { records: [] },
    'http://127.0.0.1:7878/api/v3/history/movie?movieId=148': [],
    'http://127.0.0.1:8989/api/v3/series/4': {
      id: 4,
      title: 'Dark Matter (2024)',
      year: 2024,
      monitored: true,
      qualityProfileId: 7,
      runtime: 50,
    },
    'http://127.0.0.1:8989/api/v3/episode?seriesId=4': [
      { seasonNumber: 2, episodeNumber: 9, airDateUtc: '2026-10-23T04:00:00Z', hasFile: true, monitored: true },
      { seasonNumber: 2, episodeNumber: 10, airDateUtc: '2026-10-30T04:00:00Z', hasFile: false, monitored: true },
    ],
    'http://127.0.0.1:8989/api/v3/queue?seriesIds=4&pageSize=50': { records: [] },
    'http://127.0.0.1:8989/api/v3/history/series?seriesId=4': [],
  };
  const keysSeen = new Set<string>();

  function reqApp() {
    const d = deps();
    d.now = () => Date.parse('2026-10-28T12:00:00Z');
    d.http = async (url, req) => {
      keysSeen.add(`${new URL(url).port} ${req.headers?.['X-Api-Key']}`);
      if (url.startsWith('http://127.0.0.1:7878') && radarrDown)
        return { status: 0, text: '', headers: new Headers(), error: 'refused' };
      if (url === 'http://127.0.0.1:7878/api/v3/release?movieId=148') {
        searches++;
        return answer(200, HOPE);
      }
      if (url in routes) return answer(200, routes[url]);
      return answer(404, {});
    };
    const a = makeApp(d);
    addRequestRoutes(a, { ...d, env: {}, repo, appdata: repo, analyses: new RateLimit(2, 3600_000) });
    d.store.addSession('s', { id: 1, username: 'owner' }, d.now(), 3600_000);
    return a;
  }
  const cookie = { cookie: `${SESSION_COOKIE}=s` };
  beforeEach(() => {
    searches = 0;
    radarrDown = false;
  });

  test('signed out: 401', async () => expect((await get(reqApp(), '/api/requests')).status).toBe(401));

  test('the open requests, newest first, with verdicts; the available ones counted', async () => {
    const doc = (await (await get(reqApp(), '/api/requests', cookie)).json()) as RequestsDoc;
    expect(doc.open.map((r) => `${r.id} ${r.title} ${r.verdict.code} ${r.canAnalyse}`)).toEqual([
      '37 Hope not-analysed true',
      '35 Dark Matter (2024) waiting-air false',
    ]);
    expect([doc.available, doc.errors]).toEqual([1, []]);
    expect(keysSeen.has('7878 radarr-key-123')).toBe(true);
  });

  test('analyse: one release search, summarised, kept, and the verdict it leads to', async () => {
    const a = reqApp();
    const r = await post(a, '/api/requests/37/analyse', cookie);
    const row = (await r.json()) as RequestsDoc['open'][number];
    expect(r.status).toBe(200);
    expect(searches).toBe(1);
    expect(row.verdict.code).toBe('no-4k');
    expect(row.verdict.next).toContain('4K HDR or 1080p');
    expect([row.releases?.total, row.releases?.matched, row.releases?.approved]).toEqual([25, 19, 0]);
    // Kept: the list shows it without searching again.
    const doc = (await (await get(a, '/api/requests', cookie)).json()) as RequestsDoc;
    expect(doc.open[0]?.verdict.code).toBe('no-4k');
    expect(searches).toBe(1);
    expect(logs.some((l) => l.includes('25 result(s), 19 for it, 0 acceptable'))).toBe(true);
  });

  test('analyse: nothing to search for a series with every aired episode in', async () => {
    expect((await post(reqApp(), '/api/requests/35/analyse', cookie)).status).toBe(409);
  });

  test('analyse: an unknown request, and the hourly limit', async () => {
    const a = reqApp();
    expect((await post(a, '/api/requests/999/analyse', cookie)).status).toBe(404);
    expect((await post(a, '/api/requests/37/analyse', cookie)).status).toBe(200);
    expect((await post(a, '/api/requests/37/analyse', cookie)).status).toBe(200);
    expect((await post(a, '/api/requests/37/analyse', cookie)).status).toBe(429);
  });

  test('analyse needs a same-origin POST', async () => {
    const r = await post(reqApp(), '/api/requests/37/analyse', {
      ...cookie,
      origin: 'http://evil.test',
      'sec-fetch-site': 'cross-site',
    });
    expect(r.status).toBe(403);
    expect(searches).toBe(0);
  });

  test('Radarr away: that request is unknown, and the page says why; no key in it', async () => {
    radarrDown = true;
    const r = await get(reqApp(), '/api/requests', cookie);
    const text = await r.text();
    const doc = JSON.parse(text) as RequestsDoc;
    expect(doc.open.find((x) => x.id === 37)?.verdict.code).toBe('app-unreachable');
    expect(doc.errors).toEqual(['Radarr not answering on :7878 (refused)']);
    expect(text).not.toContain('radarr-key-123');
  });
});

describe('parsing', () => {
  test('openRequests drops available, completed and declined', () => {
    const all = parseSeerrRequests({
      results: [
        { id: 1, status: 2, createdAt: '2026-01-01', media: { status: 3 } },
        { id: 2, status: 5, createdAt: '2026-01-02', media: { status: 3 } },
        { id: 3, status: 3, createdAt: '2026-01-03', media: { status: 2 } },
        { id: 4, status: 2, createdAt: '2026-01-04', media: { status: 5 } },
        { id: 5, status: 1, createdAt: '2026-01-05', media: { status: 2 } },
      ],
    });
    expect(openRequests(all).map((r) => r.id)).toEqual([5, 1]);
  });
  test('releases: matched by the mapped id, and not when the app says it is another title', () => {
    const rs = parseReleases(
      [
        { title: 'a', mappedMovieId: 148, rejections: [] },
        { title: 'b', mappedMovieId: 9, rejections: [] },
        { title: 'c', mappedMovieId: 148, rejections: ['Wrong movie'] },
      ],
      'radarr',
      148,
    );
    expect(rs.map((r) => `${r.title} ${r.matched}`)).toEqual(['a true', 'b false', 'c false']);
  });
  test('queue messages flattened; history message from data', () => {
    expect(
      parseQueue({ records: [{ statusMessages: [{ title: 'x.mkv', messages: ['No audio'] }] }] })[0]?.messages,
    ).toEqual(['x.mkv', 'No audio']);
    expect(parseHistory([{ eventType: 'downloadFailed', data: { message: 'boom' } }])[0]?.message).toBe('boom');
  });
  test("Prowlarr's indexer checks only", () =>
    expect(
      failingIndexers([
        { source: 'IndexerStatusCheck', type: 'warning', message: 'Indexers unavailable: 1337x' },
        { source: 'UpdateCheck', type: 'warning', message: 'update' },
      ]),
    ).toEqual(['Indexers unavailable: 1337x']));
  test('the season a series search covers', () => {
    const t = parseSeries(
      { id: 4, title: 'x' },
      [
        { seasonNumber: 1, episodeNumber: 1, airDateUtc: '2026-01-01T00:00:00Z', hasFile: false },
        { seasonNumber: 2, episodeNumber: 1, airDateUtc: '2026-02-01T00:00:00Z', hasFile: false },
      ],
      new Map(),
    );
    const q = parseSeerrRequests({ results: [{ id: 1, type: 'tv', seasons: [{ seasonNumber: 2 }], media: {} }] })[0];
    expect(t && q && seasonToSearch(t, q, Date.parse('2026-10-28T00:00:00Z'))).toBe(2);
  });
});
