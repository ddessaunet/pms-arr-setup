// stack/lib/http.test.ts — against a real local server: status, timeouts that
// cover the body, errors as status 0, redirects not followed.

import { afterAll, describe, expect, test } from 'bun:test';
import { httpCode, jsonOf, makeHttp } from './http.ts';

const server = Bun.serve({
  port: 0,
  idleTimeout: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/ok') return new Response('{"a":1}', { status: 200 });
    if (path === '/echo') return req.text().then((t) => new Response(`${req.method} ${t}`));
    if (path === '/redirect')
      return new Response(null, { status: 302, headers: { Location: '/login?loginFailed=true' } });
    if (path === '/slow-headers') return Bun.sleep(2000).then(() => new Response('late'));
    // Headers and a first chunk at once, then the rest of the body never comes.
    if (path === '/slow-body') {
      return new Response(
        new ReadableStream({
          async start(c) {
            c.enqueue(new TextEncoder().encode('part'));
            await Bun.sleep(5000);
            c.close();
          },
        }),
      );
    }
    return new Response('no', { status: 404 });
  },
});
afterAll(() => server.stop(true));
const base = `http://127.0.0.1:${server.port}`;
const http = makeHttp();

describe('http', () => {
  test('status and body', async () => {
    const r = await http(`${base}/ok`, { timeoutMs: 2000 });
    expect(r.status).toBe(200);
    expect(jsonOf(r)).toEqual({ a: 1 });
  });

  test('a 404 is an answer, not an error', async () => {
    expect(await http(`${base}/x`, { timeoutMs: 2000 })).toMatchObject({ status: 404, text: 'no' });
  });

  test('sends a form body', async () => {
    const r = await http(`${base}/echo`, {
      method: 'POST',
      body: new URLSearchParams({ username: 'a b', password: 'p&ss=1' }),
      timeoutMs: 2000,
    });
    expect(r.text).toBe('POST username=a+b&password=p%26ss%3D1');
  });

  test('redirects are not followed', async () => {
    const r = await http(`${base}/redirect`, { timeoutMs: 2000 });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/login?loginFailed=true');
  });

  test('a timeout before the headers is status 0', async () => {
    const r = await http(`${base}/slow-headers`, { timeoutMs: 200 });
    expect(r.status).toBe(0);
    expect(r.error).toBeTruthy();
  });

  test('the timeout covers the body too', async () => {
    const t0 = Date.now();
    const r = await http(`${base}/slow-body`, { timeoutMs: 300 });
    expect(r.status).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  test('nothing listening is status 0', async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response('') });
    const url = `http://127.0.0.1:${closed.port}/`;
    await closed.stop(true);
    expect((await http(url, { timeoutMs: 2000 })).status).toBe(0);
  });

  test('a fake fetch, as tests of the scripts pass', async () => {
    const fake = makeHttp(async (url, init) => new Response(`${init.method} ${url}`, { status: 201 }));
    expect(await fake('http://x/y', { method: 'PUT', timeoutMs: 1 })).toMatchObject({
      status: 201,
      text: 'PUT http://x/y',
    });
  });

  test('jsonOf on something that is not JSON', () => expect(jsonOf({ text: 'Ok.' })).toBeUndefined());

  test("httpCode prints no answer as curl's 000", () => {
    expect(httpCode(0)).toBe('000');
    expect(httpCode(401)).toBe('401');
  });
});
