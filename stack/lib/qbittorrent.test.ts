// stack/lib/qbittorrent.test.ts — the login rule, and the session after it,
// against a local server that answers as qBittorrent 5.2 and 4.x do.

import { afterAll, describe, expect, test } from 'bun:test';
import { makeHttp } from './http.ts';
import { cookiesOf, qbtLogin, qbtLoginOk } from './qbittorrent.ts';

describe('qbtLoginOk (the cases of arr-reclaim.test.sh)', () => {
  test('5.2: 204, empty body', () => expect(qbtLoginOk(204, '')).toBe(true));
  test('≤5.1: 200 Ok.', () => expect(qbtLoginOk(200, 'Ok.')).toBe(true));
  test('≤5.1: 200 Fails. refused', () => expect(qbtLoginOk(200, 'Fails.')).toBe(false));
  test('5.2: 401 refused', () => expect(qbtLoginOk(401, '')).toBe(false));
  test('an empty 200 is not a login', () => expect(qbtLoginOk(200, '')).toBe(false));
});

describe('cookiesOf', () => {
  test('name=value of each Set-Cookie', () => {
    const h = new Headers();
    h.append('Set-Cookie', 'SID=abc123; HttpOnly; SameSite=Strict; path=/');
    h.append('Set-Cookie', 'other=1');
    expect(cookiesOf(h)).toBe('SID=abc123; other=1');
  });
  test('none', () => expect(cookiesOf(new Headers())).toBe(''));
});

const seen: { path: string; cookie: string | null; referer: string | null; body: string }[] = [];
let loginMode: '5.2' | '4.x' | 'refuse' | 'ban' = '5.2';
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const body = await req.text();
    seen.push({ path, cookie: req.headers.get('cookie'), referer: req.headers.get('referer'), body });
    if (path === '/api/v2/auth/login') {
      const form = new URLSearchParams(body);
      const right = form.get('username') === 'arr' && form.get('password') === 'p&ss=1';
      if (loginMode === 'ban') return new Response('Your IP address has been banned', { status: 403 });
      if (!right || loginMode === 'refuse')
        return loginMode === '4.x' ? new Response('Fails.') : new Response('', { status: 401 });
      const headers = { 'Set-Cookie': 'SID=s1d; HttpOnly; path=/' };
      return loginMode === '4.x' ? new Response('Ok.', { headers }) : new Response(null, { status: 204, headers });
    }
    if (req.headers.get('cookie') !== 'SID=s1d') return new Response('Forbidden', { status: 403 });
    return new Response(`${req.method} ${path} ${body}`);
  },
});
afterAll(() => server.stop(true));
const url = `http://127.0.0.1:${server.port}`;
const http = makeHttp();
const cfg = { url, user: 'arr', pass: 'p&ss=1', timeoutMs: 2000 };

describe('qbtLogin', () => {
  test('5.2: logged in; the session sends the cookie and Referer back', async () => {
    loginMode = '5.2';
    seen.length = 0;
    const r = await qbtLogin(http, cfg);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect((await r.session.get('/api/v2/app/version')).text).toBe('GET /api/v2/app/version ');
    expect((await r.session.post('/api/v2/torrents/delete', { hashes: 'h', deleteFiles: 'true' })).text).toBe(
      'POST /api/v2/torrents/delete hashes=h&deleteFiles=true',
    );
    expect(seen[0]).toMatchObject({ referer: url, cookie: null, body: 'username=arr&password=p%26ss%3D1' });
    expect(seen[1]).toMatchObject({ referer: url, cookie: 'SID=s1d' });
  });

  test('4.x: 200 Ok.', async () => {
    loginMode = '4.x';
    expect((await qbtLogin(http, cfg)).kind).toBe('ok');
  });

  test('refused (5.2: 401), and asked once', async () => {
    loginMode = 'refuse';
    seen.length = 0;
    expect(await qbtLogin(http, cfg)).toEqual({ kind: 'refused', status: 401, body: '' });
    expect(seen.length).toBe(1);
  });

  test('refused (4.x: 200 Fails.)', async () => {
    loginMode = '4.x';
    expect(await qbtLogin(http, { ...cfg, pass: 'wrong' })).toEqual({ kind: 'refused', status: 200, body: 'Fails.' });
  });

  test('banned (403)', async () => {
    loginMode = 'ban';
    expect(await qbtLogin(http, cfg)).toMatchObject({ kind: 'refused', status: 403 });
  });

  test('unreachable', async () => {
    const down = Bun.serve({ port: 0, fetch: () => new Response('') });
    const downUrl = `http://127.0.0.1:${down.port}`;
    await down.stop(true);
    expect((await qbtLogin(http, { ...cfg, url: downUrl })).kind).toBe('unreachable');
  });
});
