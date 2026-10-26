// stack/lib/servarr.test.ts — servarr.ts against a fake Servarr API, and its
// pure helpers against the jq of stack/lib/servarr.sh.

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type { HttpRequest, HttpResponse } from './http.ts';
import {
  apiError,
  fieldsDrift,
  fieldsSet,
  hostDrift,
  jsonEqual,
  loginRedirectOk,
  resourceDrift,
  servarr,
  splitHosts,
  type JsonObject,
  type Resource,
  type ServarrConfig,
} from './servarr.ts';

const SERVARR = resolve(import.meta.dir, 'servarr.sh');

/** Runs a servarr.sh function in bash and returns its stdout. */
function bash(fn: string, ...args: string[]): string {
  const r = Bun.spawnSync(['bash', '-c', `. "$0"; ${fn} "$@"`, SERVARR, ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString();
}
const lines = (s: string) => s.split('\n').filter(Boolean);

const CFG: ServarrConfig = {
  name: 'radarr',
  url: 'http://127.0.0.1:7878',
  key: 'k',
  api: 'v3',
  user: 'admin',
  pass: 'p&ss',
  timeoutMs: 1000,
  waitMs: 10_000,
};

type Route = (req: HttpRequest & { url: string }) => Partial<HttpResponse> & { json?: unknown };

/** A fake app: routes by "METHOD /path", records every request. */
function fakeApp(routes: Record<string, Route>, cfg: Partial<ServarrConfig> = {}) {
  const calls: (HttpRequest & { url: string })[] = [];
  const logs: string[] = [];
  let clock = 0;
  const app = servarr(
    { ...CFG, ...cfg },
    {
      http: async (url, req) => {
        const call = { url, ...req };
        calls.push(call);
        const path = url.replace(/^http:\/\/[^/]+/, '').replace(/^\/api\/v3/, '');
        const route = routes[`${req.method ?? 'GET'} ${path}`];
        if (!route) return { status: 404, text: '', headers: new Headers() };
        const r = route(call);
        return {
          status: r.status ?? 200,
          text: r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? ''),
          headers: r.headers ?? new Headers(),
        };
      },
      log: (l) => void logs.push(l),
      sleep: async (ms) => void (clock += ms),
      now: () => clock,
      hostname: () => 'pms',
      lanIps: () => ['10.0.0.50'],
    },
  );
  return { app, calls, logs };
}

const loginAccepted: Route = () => ({ status: 302, headers: new Headers({ Location: '/' }) });
const loginRefused: Route = () => ({ status: 302, headers: new Headers({ Location: '/login?loginFailed=true' }) });
const HOSTS = 'radarr,localhost,127.0.0.1,pms,10.0.0.50';
const goodHost = {
  id: 1,
  bindAddress: '*',
  username: 'admin',
  authenticationMethod: 'forms',
  authenticationRequired: 'disabledForLocalAddresses',
  allowedHosts: HOSTS,
};

describe('pure helpers match servarr.sh', () => {
  const got = { a: 1, b: { x: [1, 2] }, c: 'same', d: null };
  const want = { b: { x: [1, 2] }, a: 2, c: 'same', e: null, f: 'new' };
  test('hostDrift', () => {
    expect(hostDrift(got, want)).toEqual(lines(bash('host_drift', JSON.stringify(got), JSON.stringify(want))));
    expect(hostDrift(got, want)).toEqual(['a', 'f']);
  });

  const res: Resource = {
    id: 3,
    implementation: 'QBittorrent',
    enable: true,
    fields: [
      { name: 'host', value: 'qbittorrent' },
      { name: 'port', value: 8081 },
      { name: 'password' },
      { name: 'tags', value: [] },
    ],
  };
  const map: JsonObject = { host: 'qbittorrent', port: 8080, tags: [], missing: 'x', password: null };
  test('fieldsDrift', () => {
    expect(fieldsDrift(res, map)).toEqual(lines(bash('fields_drift', JSON.stringify(res), JSON.stringify(map))));
    expect(fieldsDrift(res, map)).toEqual(['port', 'missing']);
  });
  test('fieldsSet', () => {
    expect(fieldsSet(res, map)).toEqual(JSON.parse(bash('fields_set', JSON.stringify(res), JSON.stringify(map))));
  });
  test('resourceDrift', () => {
    const top = { enable: false, implementation: 'QBittorrent' };
    expect(resourceDrift(res, top, map)).toEqual(
      lines(bash('resource_drift', JSON.stringify(res), JSON.stringify(top), JSON.stringify(map))),
    );
  });
  test('loginRedirectOk', () => {
    expect(loginRedirectOk('http://x/')).toBe(true);
    expect(loginRedirectOk('http://x/login?returnUrl=/&loginFailed=true')).toBe(false);
    expect(loginRedirectOk('')).toBe(false);
    expect(loginRedirectOk(null)).toBe(false);
  });
});

describe('apiError', () => {
  // The same jq as api_error, on the same bodies.
  const jq = (body: string) =>
    Bun.spawnSync(['jq', '-r', '.[0].errorMessage? // .message? // empty'], { stdin: Buffer.from(body) })
      .stdout.toString()
      .replace(/\n$/, '')
      .slice(0, 160);
  for (const body of [
    '[{"propertyName":"Path","errorMessage":"Folder does not exist"}]',
    '{"message":"Unauthorized"}',
    '[{"propertyName":"x"}]',
    '[]',
    '{}',
    `{"message":"${'x'.repeat(300)}"}`,
  ]) {
    test(body.slice(0, 40), () => expect(apiError(body)).toBe(jq(body)));
  }
  test('not JSON', () => expect(apiError('<html>')).toBe(''));
});

describe('helpers', () => {
  test('jsonEqual ignores key order, not types', () => {
    expect(jsonEqual({ a: [1, { b: 2, c: 3 }] }, { a: [1, { c: 3, b: 2 }] })).toBe(true);
    expect(jsonEqual(1, '1')).toBe(false);
    expect(jsonEqual([1], { 0: 1 })).toBe(false);
  });
  test('splitHosts', () => {
    expect(splitHosts(undefined)).toEqual([]);
    expect(splitHosts('')).toEqual([]);
    expect(splitHosts('probe-radarr,,x y')).toEqual(['probe-radarr', 'x', 'y']);
  });
});

describe('allowedHosts', () => {
  test('service, local names, LAN addresses, extras', () => {
    const { app } = fakeApp({}, { extraHosts: ['probe-radarr'] });
    expect(app.allowedHosts()).toBe(`${HOSTS},probe-radarr`);
    expect(app.allowedHosts('prowlarr')).toBe('prowlarr,localhost,127.0.0.1,pms,10.0.0.50,probe-radarr');
  });
});

describe('api', () => {
  test('key header; JSON body on writes; an empty one when there is none', async () => {
    const { app, calls } = fakeApp({ 'POST /system/restart': () => ({}), 'GET /x': () => ({ json: [1] }) });
    expect(await app.get('/x')).toMatchObject({ ok: true, status: 200, json: [1] });
    await app.api('POST', '/system/restart');
    expect(calls[0]).toMatchObject({ url: 'http://127.0.0.1:7878/api/v3/x', headers: { 'X-Api-Key': 'k' } });
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[1]).toMatchObject({ body: '', headers: { 'Content-Type': 'application/json' } });
  });
});

describe('waitReady', () => {
  test('up', async () => {
    const { app } = fakeApp({ 'GET /system/status': () => ({ json: {} }) });
    expect(await app.waitReady()).toBe(true);
  });
  test('401 gives up at once', async () => {
    const { app, calls } = fakeApp({ 'GET /system/status': () => ({ status: 401 }) });
    expect(await app.waitReady()).toBe(false);
    expect(calls.length).toBe(1);
  });
  test('down until the deadline, every 3 s', async () => {
    const { app, calls } = fakeApp({ 'GET /system/status': () => ({ status: 0 }) });
    expect(await app.waitReady()).toBe(false);
    expect(calls.length).toBe(5); // t = 0, 3, 6, 9, 12 s (wait 10 s)
  });
});

describe('loginOk', () => {
  test('a form with the password, redirects not followed', async () => {
    const { app, calls } = fakeApp({ 'POST /login?returnUrl=/': loginAccepted });
    expect(await app.loginOk()).toBe(true);
    expect(calls[0]?.redirect).toBe('manual');
    expect(String(calls[0]?.body)).toBe('username=admin&password=p%26ss');
  });
  test('refused', async () => {
    expect(await fakeApp({ 'POST /login?returnUrl=/': loginRefused }).app.loginOk()).toBe(false);
  });
  test('no redirect at all', async () => {
    expect(await fakeApp({ 'POST /login?returnUrl=/': () => ({ status: 200 }) }).app.loginOk()).toBe(false);
  });
});

describe('applyHost', () => {
  test('already set: nothing written', async () => {
    const { app, calls, logs } = fakeApp({
      'GET /config/host': () => ({ json: goodHost }),
      'POST /login?returnUrl=/': loginAccepted,
    });
    expect(await app.applyHost()).toBe(true);
    expect(logs).toEqual(['  login and allowed hosts already set']);
    expect(calls.map((c) => c.method ?? 'GET')).toEqual(['GET', 'POST']);
  });

  test('new allowed hosts: written with the password, then a restart', async () => {
    let put: unknown;
    const { app, logs } = fakeApp({
      'GET /config/host': () => ({ json: { ...goodHost, allowedHosts: 'radarr' } }),
      'POST /login?returnUrl=/': loginAccepted,
      'PUT /config/host/1': (r) => ((put = JSON.parse(String(r.body))), {}),
      'POST /system/restart': () => ({}),
      'GET /system/status': () => ({ json: {} }),
    });
    expect(await app.applyHost()).toBe(true);
    expect(put).toEqual({ ...goodHost, password: 'p&ss', passwordConfirmation: 'p&ss' });
    expect(logs).toEqual(['  login and allowed hosts set', '  restarting radarr so the new allowed hosts take effect']);
  });

  test('only the login refused: written, no restart', async () => {
    const { app, calls } = fakeApp({
      'GET /config/host': () => ({ json: goodHost }),
      'POST /login?returnUrl=/': loginRefused,
      'PUT /config/host/1': () => ({}),
    });
    expect(await app.applyHost()).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/system/restart'))).toBe(false);
  });

  test('a refused write', async () => {
    const { app, logs } = fakeApp({
      'GET /config/host': () => ({ json: { ...goodHost, username: 'x' } }),
      'PUT /config/host/1': () => ({ status: 400, json: [{ errorMessage: 'bad' }] }),
    });
    expect(await app.applyHost()).toBe(false);
    expect(logs).toEqual(['  FAIL  host config (HTTP 400): bad']);
  });
});

describe('verifyHost', () => {
  test('clean', async () => {
    const { app, logs } = fakeApp({
      'GET /config/host': () => ({ json: goodHost }),
      'POST /login?returnUrl=/': loginAccepted,
    });
    expect(await app.verifyHost()).toBe(true);
    expect(logs).toEqual([
      `  ok       host: forms login, not required locally; allowed hosts ${HOSTS}`,
      '  ok       login as admin',
    ]);
  });
  test('drift, word for word', async () => {
    const { app, logs } = fakeApp({
      'GET /config/host': () => ({ json: { ...goodHost, username: 'x', allowedHosts: '' } }),
      'POST /login?returnUrl=/': loginRefused,
    });
    expect(await app.verifyHost()).toBe(false);
    expect(logs).toEqual(['  DRIFT    host: username allowedHosts ', '  DRIFT    login as admin is refused']);
  });
  test('unreachable', async () => {
    const { app, logs } = fakeApp({ 'GET /config/host': () => ({ status: 0 }) });
    expect(await app.verifyHost()).toBe(false);
    expect(logs).toEqual(['  FAIL  read host config (HTTP 000)']); // curl's code for no answer
  });
});

describe('resources', () => {
  const spec = {
    label: 'qBittorrent client',
    endpoint: 'downloadclient',
    implementation: 'QBittorrent',
    top: { enable: true, name: 'qBittorrent' },
    fields: { host: 'qbittorrent', port: 8081 },
  };
  const schema = {
    implementation: 'QBittorrent',
    enable: false,
    fields: [{ name: 'host', value: 'localhost' }, { name: 'port', value: 8080 }, { name: 'password' }],
  };
  const stored = { ...schema, ...spec.top, id: 7, fields: fieldsSet(schema, spec.fields).fields };

  test('missing: added from the schema, secret included', async () => {
    let body: Resource | undefined;
    const { app, logs } = fakeApp({
      'GET /downloadclient': () => ({ json: [] }),
      'GET /downloadclient/schema': () => ({ json: [{ implementation: 'Other', fields: [] }, schema] }),
      'POST /downloadclient': (r) => ((body = JSON.parse(String(r.body))), { status: 201 }),
    });
    expect(await app.applyResource({ ...spec, secretName: 'password', secret: 's3' })).toBe(true);
    expect(logs).toEqual(['  qBittorrent client added']);
    expect(body?.enable).toBe(true);
    expect(body?.fields).toEqual([
      { name: 'host', value: 'qbittorrent' },
      { name: 'port', value: 8081 },
      { name: 'password', value: 's3' },
    ]);
  });

  test('set: nothing written', async () => {
    const { app, logs, calls } = fakeApp({ 'GET /downloadclient': () => ({ json: [stored] }) });
    expect(await app.applyResource({ ...spec, secretName: 'password', secret: 's3' })).toBe(true);
    expect(logs).toEqual(['  qBittorrent client already set']);
    expect(calls.length).toBe(1);
  });

  test('drift: updated, and says what', async () => {
    const { app, logs } = fakeApp({
      'GET /downloadclient': () => ({ json: [{ ...stored, enable: false, fields: schema.fields }] }),
      'PUT /downloadclient/7': () => ({}),
    });
    expect(await app.applyResource({ ...spec, secretName: 'password', secret: 's3' })).toBe(true);
    expect(logs).toEqual(['  qBittorrent client updated (enable host port)']);
  });

  test('verify: clean, and the test passes', async () => {
    const { app, logs } = fakeApp({
      'GET /downloadclient': () => ({ json: [stored] }),
      'POST /downloadclient/test': () => ({}),
    });
    expect(await app.verifyResource(spec)).toBe(true);
    expect(logs).toEqual(['  ok       qBittorrent client — test passes']);
  });

  test('verify: a failing test is reported, but is not drift', async () => {
    const { app, logs } = fakeApp({
      'GET /downloadclient': () => ({ json: [stored] }),
      'POST /downloadclient/test': () => ({ status: 400, json: [{ errorMessage: 'Unable to connect' }] }),
    });
    expect(await app.verifyResource(spec)).toBe(true);
    expect(logs).toEqual(['  FAILING  qBittorrent client — test fails: Unable to connect']);
  });

  test('verify: drift and missing', async () => {
    const drifted = fakeApp({ 'GET /downloadclient': () => ({ json: [{ ...stored, enable: false }] }) });
    expect(await drifted.app.verifyResource(spec)).toBe(false);
    expect(drifted.logs).toEqual(['  DRIFT    qBittorrent client: enable ']);
    const missing = fakeApp({ 'GET /downloadclient': () => ({ json: [] }) });
    expect(await missing.app.verifyResource(spec)).toBe(false);
    expect(missing.logs).toEqual(['  DRIFT    qBittorrent client missing']);
  });
});
