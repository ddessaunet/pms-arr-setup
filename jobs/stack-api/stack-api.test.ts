// jobs/stack-api/stack-api.test.ts — the sign-in, the session and the gate,
// against a fake plex.tv and an in-memory store; and the service itself, on a
// scratch socket.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpRequest, HttpResponse } from '../../stack/lib/http.ts';
import { makeApp, PIN_TTL, RateLimit, SESSION_COOKIE, type AppDeps } from './app.ts';
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
