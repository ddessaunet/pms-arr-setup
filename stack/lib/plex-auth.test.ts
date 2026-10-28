// stack/lib/plex-auth.test.ts — the Plex PIN flow against a fake plex.tv.

import { describe, expect, test } from 'bun:test';
import type { HttpRequest, HttpResponse } from './http.ts';
import { authUrl, checkPin, createPin, ownsServer, plexAccount, plexHeaders, type PlexClient } from './plex-auth.ts';

interface Seen {
  url: string;
  req: HttpRequest;
}

function fake(answers: Record<string, [number, unknown]>): { client: PlexClient; seen: Seen[] } {
  const seen: Seen[] = [];
  const client: PlexClient = {
    clientId: 'client-1',
    base: 'https://plex.test',
    http: async (url, req): Promise<HttpResponse> => {
      seen.push({ url, req });
      const key = `${req.method ?? 'GET'} ${url.replace('https://plex.test', '')}`;
      const a = answers[key];
      if (!a) return { status: 0, text: '', headers: new Headers(), error: 'refused' };
      return { status: a[0], text: typeof a[1] === 'string' ? a[1] : JSON.stringify(a[1]), headers: new Headers() };
    },
  };
  return { client, seen };
}

test('plexHeaders: the token only when there is one', () => {
  expect(plexHeaders('c')).toEqual({
    Accept: 'application/json',
    'X-Plex-Client-Identifier': 'c',
    'X-Plex-Product': 'pms docs',
  });
  expect(plexHeaders('c', 't')['X-Plex-Token']).toBe('t');
});

test('authUrl: the code and client in the fragment', () => {
  const u = authUrl('client-1', 'abcd');
  expect(u.startsWith('https://app.plex.tv/auth#?')).toBe(true);
  const q = new URLSearchParams(u.split('#?')[1]);
  expect(q.get('clientID')).toBe('client-1');
  expect(q.get('code')).toBe('abcd');
  expect(q.get('context[device][product]')).toBe('pms docs');
});

describe('createPin', () => {
  test('a strong PIN, as this client', async () => {
    const { client, seen } = fake({ 'POST /api/v2/pins?strong=true': [201, { id: 7, code: 'abcd', authToken: null }] });
    expect(await createPin(client)).toEqual({ ok: true, value: { id: 7, code: 'abcd' } });
    expect(seen[0]?.req.headers?.['X-Plex-Client-Identifier']).toBe('client-1');
  });
  test('plex.tv away', async () => {
    const r = await createPin(fake({}).client);
    expect(r).toEqual({ ok: false, status: 0, error: 'create PIN: plex.tv did not answer (refused)' });
  });
  test('an answer without an id', async () => {
    const r = await createPin(fake({ 'POST /api/v2/pins?strong=true': [201, { code: 'x' }] }).client);
    expect(r.ok).toBe(false);
  });
});

describe('checkPin', () => {
  test('null until approved, then the token', async () => {
    expect(await checkPin(fake({ 'GET /api/v2/pins/7': [200, { id: 7, authToken: null }] }).client, 7)).toEqual({
      ok: true,
      value: null,
    });
    expect(await checkPin(fake({ 'GET /api/v2/pins/7': [200, { id: 7, authToken: 'tok' }] }).client, 7)).toEqual({
      ok: true,
      value: 'tok',
    });
  });
  test('404 is expired', async () => {
    expect(await checkPin(fake({ 'GET /api/v2/pins/7': [404, ''] }).client, 7)).toEqual({
      ok: false,
      status: 404,
      error: 'the PIN expired',
    });
  });
});

describe('plexAccount and ownsServer', () => {
  test('the account, with the token in the header and not the URL', async () => {
    const { client, seen } = fake({
      'GET /api/v2/user': [200, { id: 1, uuid: 'u', username: 'dario', title: 'Dario' }],
    });
    expect(await plexAccount(client, 'secret-token')).toEqual({
      ok: true,
      value: { id: 1, uuid: 'u', username: 'dario', title: 'Dario' },
    });
    expect(seen[0]?.req.headers?.['X-Plex-Token']).toBe('secret-token');
    expect(seen[0]?.url).not.toContain('secret-token');
  });
  test('owner: this server, owned', async () => {
    const answers = (owned: boolean, id = 'srv'): Record<string, [number, unknown]> => ({
      'GET /api/v2/resources?includeHttps=1': [
        200,
        [
          { clientIdentifier: 'other', owned: true },
          { clientIdentifier: id, owned },
        ],
      ],
    });
    expect(await ownsServer(fake(answers(true)).client, 't', 'srv')).toEqual({ ok: true, value: true });
    expect(await ownsServer(fake(answers(false)).client, 't', 'srv')).toEqual({ ok: true, value: false });
    expect(await ownsServer(fake(answers(true, 'x')).client, 't', 'srv')).toEqual({ ok: true, value: false });
  });
  test('an error never carries the token', async () => {
    const r = await plexAccount(fake({ 'GET /api/v2/user': [401, 'no'] }).client, 'secret-token');
    expect(r).toEqual({ ok: false, status: 401, error: 'read the account: plex.tv answered 401' });
  });
});
