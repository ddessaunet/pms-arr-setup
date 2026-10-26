// apps/prowlarr/configure.test.ts — unit fixtures for apps/prowlarr/configure.ts,
// and main against a fake Prowlarr.
//
// Offline, and changes nothing. The live behaviour — the API key fixed by
// PROWLARR__AUTH__APIKEY, allowedHosts being required for "not required for
// local addresses", 400 on a duplicate indexer, the forms-login 302 targets,
// proxies tested before they are saved, 1337x/EZTV challenged by Cloudflare and
// passing through FlareSolverr — was checked against throwaway Prowlarr 2.6.5
// and FlareSolverr 3.5.2 containers.

import { describe, expect, test } from 'bun:test';
import type { HttpRequest, HttpResponse } from '../../stack/lib/http.ts';
import { lanAddresses } from '../../stack/lib/net.ts';
import { hostDrift, loginRedirectOk, servarr } from '../../stack/lib/servarr.ts';
import {
  APPLICATIONS,
  INDEXERS,
  MIN_SEEDERS,
  indexerDiffers,
  indexerFix,
  indexerNew,
  main,
  proxyDiffers,
  syncprofileDiffers,
  syncprofileFix,
  type AppProfile,
  type Indexer,
  type IndexerProxy,
} from './configure.ts';

// `hostname -I` as the bash test stubbed it.
const HOST_ADDRESSES = ['192.168.0.86', '192.168.0.66', '172.17.0.1', '172.18.0.1', 'fd73:5731::1'];

// ─── the indexer list ─────────────────────────────────────────────────────────
describe('INDEXERS', () => {
  test('six indexers', () => expect(INDEXERS).toHaveLength(6));
  test('every route is flare or direct', () =>
    expect(INDEXERS.filter((i) => i.route !== 'flare' && i.route !== 'direct')).toEqual([]));
  test('only Cloudflare-blocked ones go through FlareSolverr', () =>
    expect(INDEXERS.filter((i) => i.route === 'flare').map((i) => i.definition)).toEqual(['1337x', 'eztv']));
});

// ─── host config ──────────────────────────────────────────────────────────────
describe('allowed_hosts / want_host', () => {
  const px = servarr(
    {
      name: 'prowlarr',
      url: 'http://x',
      key: 'k',
      api: 'v1',
      user: 'dario',
      pass: 'p',
      timeoutMs: 1,
      waitMs: 1,
    },
    {
      http: async () => ({ status: 0, text: '', headers: new Headers() }),
      log: () => {},
      sleep: async () => {},
      now: () => 0,
      hostname: () => 'pms',
      lanIps: () => lanAddresses(HOST_ADDRESSES),
    },
  );
  const W = px.wantHost();
  test('service name, loopback, host, LAN; no docker bridges or IPv6', () =>
    expect(px.allowedHosts()).toBe('prowlarr,localhost,127.0.0.1,pms,192.168.0.86,192.168.0.66'));
  test('forms login', () => expect(W.authenticationMethod).toBe('forms'));
  test('not required from local', () => expect(W.authenticationRequired).toBe('disabledForLocalAddresses'));
  test('username from .env', () => expect(W.username).toBe('dario'));
  test('never carries the password', () => expect('password' in W).toBe(false));

  const GOT = { ...W, id: 1, apiKey: 'k', port: 9696 };
  test('extra keys Prowlarr has are ignored', () => expect(hostDrift(GOT, W)).toEqual([]));
  test('a changed key is named', () =>
    expect(hostDrift({ ...GOT, allowedHosts: 'localhost' }, W)).toEqual(['allowedHosts']));
  test('several changes, one per line', () =>
    expect(hostDrift({ ...GOT, username: 'x', allowedHosts: '' }, W)).toEqual(['username', 'allowedHosts']));
});

// ─── indexers ─────────────────────────────────────────────────────────────────
describe('indexer_new / indexer_fix / indexer_differs', () => {
  const SCHEMA: Indexer = {
    definitionName: '1337x',
    name: '1337x',
    enable: false,
    appProfileId: 0,
    tags: [],
    fields: [{ name: 'baseUrl', value: null }],
  };
  const N = indexerNew(SCHEMA, 1, [3]);
  test('new: enabled', () => expect(N.enable).toBe(true));
  test('new: app profile set', () => expect(N.appProfileId).toBe(1));
  test('new: tags set', () => expect(N.tags).toEqual([3]));
  test('new: schema fields kept', () => expect(N.fields?.[0]?.name).toBe('baseUrl'));

  const IX: Indexer = { id: 7, definitionName: 'eztv', enable: true, tags: [3], priority: 25 };
  test('as wanted → no change', () => expect(indexerDiffers(IX, [3])).toBe(false));
  test('tag order does not matter', () => expect(indexerDiffers({ ...IX, tags: [5, 3] }, [3, 5])).toBe(false));
  test('disabled → differs', () => expect(indexerDiffers({ ...IX, enable: false }, [3])).toBe(true));
  test('flare tag missing → differs', () => expect(indexerDiffers({ ...IX, tags: [] }, [3])).toBe(true));
  test('flare tag unwanted → differs', () => expect(indexerDiffers(IX, [])).toBe(true));
  test('fix: enabled and tagged, id and priority kept', () => {
    const F = indexerFix({ ...IX, enable: false, tags: [] }, [3]);
    expect({ id: F.id, enable: F.enable, tags: F.tags, priority: F.priority }).toEqual({
      id: 7,
      enable: true,
      tags: [3],
      priority: 25,
    });
  });
});

// ─── sync profile ─────────────────────────────────────────────────────────────
describe('syncprofile_fix / syncprofile_differs', () => {
  const SP: AppProfile = {
    name: 'Standard',
    enableRss: true,
    enableAutomaticSearch: true,
    enableInteractiveSearch: true,
    minimumSeeders: 1,
    id: 1,
  };
  test('floor is 5', () => expect(MIN_SEEDERS).toBe(5));
  test("Prowlarr's default 1 → differs", () => expect(syncprofileDiffers(SP, 5)).toBe(true));
  test('at the floor → no change', () => expect(syncprofileDiffers({ ...SP, minimumSeeders: 5 }, 5)).toBe(false));
  test('raised by hand → differs', () => expect(syncprofileDiffers({ ...SP, minimumSeeders: 20 }, 5)).toBe(true));
  test('fix: only minimumSeeders changes', () => expect(syncprofileFix(SP, 5)).toEqual({ ...SP, minimumSeeders: 5 }));
});

// ─── proxy ────────────────────────────────────────────────────────────────────
describe('proxy_differs', () => {
  const PX: IndexerProxy = {
    id: 1,
    implementation: 'FlareSolverr',
    tags: [3],
    fields: [
      { name: 'host', value: 'http://flaresolverr:8191/' },
      { name: 'requestTimeout', value: 60 },
    ],
  };
  test('as wanted → no change', () => expect(proxyDiffers(PX, 'http://flaresolverr:8191/', 3)).toBe(false));
  test('host changed → differs', () => expect(proxyDiffers(PX, 'http://elsewhere:8191/', 3)).toBe(true));
  test('tag changed → differs', () =>
    expect(proxyDiffers({ ...PX, tags: [] }, 'http://flaresolverr:8191/', 3)).toBe(true));
});

// ─── login ────────────────────────────────────────────────────────────────────
describe('login_redirect_ok', () => {
  test('302 to the return URL → accepted', () => expect(loginRedirectOk('http://127.0.0.1:9696/')).toBe(true));
  test('302 to loginFailed → refused', () =>
    expect(loginRedirectOk('http://127.0.0.1:9696/login?returnUrl=/&loginFailed=true')).toBe(false));
  test('no redirect at all → refused', () => expect(loginRedirectOk('')).toBe(false));
});

// ─── main, against a fake Prowlarr ────────────────────────────────────────────
const HOSTS = 'prowlarr,localhost,127.0.0.1,pms,10.0.0.50';
const ENV = {
  PROWLARR_API_KEY: 'pk',
  PROWLARR_USER: 'dario',
  PROWLARR_PASS: 'pw',
  RADARR_API_KEY: 'rk',
  SONARR_API_KEY: 'sk',
};

interface State {
  host: Record<string, unknown>;
  tags: { id: number; label: string }[];
  proxies: IndexerProxy[];
  profiles: AppProfile[];
  indexers: Indexer[];
  apps: {
    id: number;
    name: string;
    implementation: string;
    syncLevel: string;
    fields: { name: string; value?: unknown }[];
  }[];
  /** Indexer definitions whose test fails. */
  failing: string[];
  syncStatus: string[];
}

const SCHEMA_INDEXERS: Indexer[] = INDEXERS.map((i) => ({
  definitionName: i.definition,
  name: i.definition.toUpperCase(),
  enable: false,
  tags: [],
  fields: [],
}));

function fresh(): State {
  return {
    host: { id: 1, username: '', authenticationMethod: 'forms', authenticationRequired: 'enabled', allowedHosts: '' },
    tags: [],
    proxies: [],
    profiles: [{ id: 1, name: 'Standard', minimumSeeders: 1 }],
    indexers: [],
    apps: [],
    failing: [],
    syncStatus: ['started', 'completed'],
  };
}

/** What `configure` leaves behind: the state --check finds clean. */
function configured(): State {
  const s = fresh();
  s.host = {
    id: 1,
    username: 'dario',
    authenticationMethod: 'forms',
    authenticationRequired: 'disabledForLocalAddresses',
    allowedHosts: HOSTS,
  };
  s.tags = [{ id: 3, label: 'flare' }];
  s.proxies = [
    {
      id: 1,
      name: 'FlareSolverr',
      implementation: 'FlareSolverr',
      tags: [3],
      fields: [{ name: 'host', value: 'http://flaresolverr:8191/' }],
    },
  ];
  s.profiles = [{ id: 1, name: 'Standard', minimumSeeders: 5 }];
  s.indexers = INDEXERS.map((i, n) => ({
    id: n + 1,
    definitionName: i.definition,
    name: i.definition.toUpperCase(),
    enable: true,
    tags: i.route === 'flare' ? [3] : [],
  }));
  s.apps = APPLICATIONS.map((a, n) => ({
    id: n + 1,
    name: a.implementation,
    implementation: a.implementation,
    syncLevel: 'fullSync',
    fields: [
      { name: 'prowlarrUrl', value: 'http://prowlarr:9696' },
      { name: 'baseUrl', value: `http://${a.service}:${a.port}` },
      { name: 'apiKey', value: '********' },
    ],
  }));
  return s;
}

type Reply = { status: number; json?: unknown; location?: string };

function fakeProwlarr(state: State, opts: { down?: boolean; key?: string } = {}) {
  const calls: (HttpRequest & { url: string })[] = [];
  let nextId = 100;
  const route = (method: string, path: string, body: unknown, req: HttpRequest): Reply => {
    if (opts.down) return { status: 0 };
    if (path === '/login') {
      const f = new URLSearchParams(String(req.body));
      const ok = f.get('username') === state.host.username && f.get('password') === 'pw';
      return { status: 302, location: ok ? '/' : '/login?returnUrl=/&loginFailed=true' };
    }
    if (req.headers?.['X-Api-Key'] !== (opts.key ?? 'pk')) return { status: 401 };
    const key = `${method} ${path.replace(/\/\d+$/, '/{id}')}`;
    switch (key) {
      case 'GET /api/v1/system/status':
        return { status: 200, json: { version: '2.6.5.5623' } };
      case 'GET /api/v1/config/host':
        return { status: 200, json: state.host };
      case 'PUT /api/v1/config/host/{id}':
        state.host = { ...(body as object) };
        return { status: 202, json: state.host };
      case 'POST /api/v1/system/restart':
        return { status: 200 };
      case 'POST /api/v1/tag': {
        const label = (body as { label: string }).label;
        let t = state.tags.find((x) => x.label === label);
        if (!t) state.tags.push((t = { id: 3, label }));
        return { status: 201, json: t };
      }
      case 'GET /api/v1/tag':
        return { status: 200, json: state.tags };
      case 'GET /api/v1/indexerProxy':
        return { status: 200, json: state.proxies };
      case 'GET /api/v1/indexerProxy/schema':
        return {
          status: 200,
          json: [
            { implementation: 'FlareSolverr', tags: [], fields: [{ name: 'host', value: 'http://localhost:8191/' }] },
          ],
        };
      case 'POST /api/v1/indexerProxy':
        state.proxies.push({ ...(body as IndexerProxy), id: nextId++ });
        return { status: 201 };
      case 'PUT /api/v1/indexerProxy/{id}':
        state.proxies = [body as IndexerProxy];
        return { status: 202 };
      case 'POST /api/v1/indexerProxy/test':
        return { status: 200 };
      case 'GET /api/v1/appprofile':
        return { status: 200, json: state.profiles };
      case 'PUT /api/v1/appprofile/{id}':
        state.profiles = [body as AppProfile];
        return { status: 202 };
      case 'GET /api/v1/indexer/schema':
        return { status: 200, json: SCHEMA_INDEXERS };
      case 'GET /api/v1/indexer':
        return { status: 200, json: state.indexers };
      case 'POST /api/v1/indexer':
        state.indexers.push({ ...(body as Indexer), id: nextId++ });
        return { status: 201 };
      case 'PUT /api/v1/indexer/{id}': {
        const ix = body as Indexer;
        state.indexers = state.indexers.map((x) => (x.id === ix.id ? ix : x));
        return { status: 202 };
      }
      case 'POST /api/v1/indexer/test': {
        const ix = body as Indexer;
        return state.failing.includes(ix.definitionName ?? '')
          ? { status: 400, json: [{ errorMessage: 'Unable to connect to indexer' }] }
          : { status: 200 };
      }
      case 'GET /api/v1/applications':
        return { status: 200, json: state.apps };
      case 'GET /api/v1/applications/schema':
        return {
          status: 200,
          json: APPLICATIONS.map((a) => ({
            implementation: a.implementation,
            syncLevel: 'addOnly',
            fields: [
              { name: 'prowlarrUrl', value: 'http://localhost:9696' },
              { name: 'baseUrl', value: '' },
              { name: 'apiKey' },
            ],
          })),
        };
      case 'POST /api/v1/applications': {
        const a = body as State['apps'][number];
        state.apps.push({ ...a, id: nextId++ });
        return { status: 201 };
      }
      case 'POST /api/v1/applications/test':
        return { status: 200 };
      case 'POST /api/v1/command':
        return { status: 201, json: { id: 9, status: 'queued' } };
      case 'GET /api/v1/command/{id}':
        return {
          status: 200,
          json: { id: 9, status: state.syncStatus.shift() ?? 'completed', message: 'Sync failed: Radarr unreachable' },
        };
      default:
        return { status: 404 };
    }
  };
  const http = async (url: string, req: HttpRequest): Promise<HttpResponse> => {
    calls.push({ url, ...req });
    const u = new URL(url);
    const body = typeof req.body === 'string' && req.body !== '' ? JSON.parse(req.body) : undefined;
    const r = route(req.method ?? 'GET', u.pathname, body, req);
    const headers = new Headers(r.location ? { Location: r.location } : {});
    return { status: r.status, text: r.json === undefined ? '' : JSON.stringify(r.json), headers };
  };
  return { http, calls };
}

function run(argv: string[], state: State, opts: { env?: Record<string, string>; down?: boolean; key?: string } = {}) {
  const fake = fakeProwlarr(state, opts);
  const lines: string[] = [];
  const errs: string[] = [];
  let clock = 0;
  const code = main(argv, {
    http: fake.http,
    log: (l) => void lines.push(l),
    err: (l) => void errs.push(l),
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    hostname: () => 'pms',
    lanIps: () => ['10.0.0.50'],
    env: opts.env ?? ENV,
    repo: '/nonexistent',
  });
  return { code, lines, errs, calls: fake.calls };
}

const writes = (calls: (HttpRequest & { url: string })[]) =>
  calls.filter((c) => (c.method === 'PUT' || c.method === 'POST') && !/\/test$|\/login/.test(c.url));

describe('main', () => {
  test('--check on a configured Prowlarr: no drift, word for word', async () => {
    const { code, lines, calls } = run(['--check'], configured());
    expect(await code).toBe(0);
    expect(lines).toEqual([
      'Prowlarr at http://127.0.0.1:9696 (check)',
      '  API up: 2.6.5.5623',
      'Read-back:',
      `  ok       host: forms login, not required locally; allowed hosts ${HOSTS}`,
      '  ok       login as dario',
      '  ok       application Radarr — test passes',
      '  ok       application Sonarr — test passes',
      '  ok       sync profile Standard: minimum seeders 5',
      '  ok       FlareSolverr proxy http://flaresolverr:8191/ answers',
      '  ok       1337X (flare) — test passes',
      '  ok       THEPIRATEBAY (direct) — test passes',
      '  ok       LIMETORRENTS (direct) — test passes',
      '  ok       KNABEN (direct) — test passes',
      '  ok       YTS (direct) — test passes',
      '  ok       EZTV (flare) — test passes',
      'No drift.',
    ]);
    expect(writes(calls)).toEqual([]);
  });

  test('--check: a failing indexer only warns', async () => {
    const s = configured();
    s.failing = ['yts'];
    const { code, lines } = run(['--check'], s);
    expect(await code).toBe(0);
    expect(lines).toContain('  FAILING  YTS (direct) — test fails: Unable to connect to indexer');
  });

  test('--check: drift is 1, and names what drifted', async () => {
    const s = configured();
    s.profiles = [{ id: 1, name: 'Standard', minimumSeeders: 1 }];
    s.indexers = s.indexers
      .filter((x) => x.definitionName !== 'Knaben')
      .map((x) => (x.definitionName === 'eztv' ? { ...x, tags: [] } : x));
    const { code, lines, calls } = run(['--check'], s);
    expect(await code).toBe(1);
    expect(lines).toContain('  DRIFT    sync profile Standard: minimum seeders 1, want 5');
    expect(lines).toContain('  DRIFT    Knaben missing');
    expect(lines).toContain('  DRIFT    EZTV disabled or tags changed (want flare)');
    expect(lines.at(-1)).toBe('To apply: task prowlarr:configure');
    expect(writes(calls)).toEqual([]);
  });

  test('apply on a fresh Prowlarr: everything set, synced, then clean', async () => {
    const s = fresh();
    const { code, lines } = run([], s);
    expect(await code).toBe(0);
    expect(lines.slice(2, lines.indexOf('Read-back:'))).toEqual([
      '  login and allowed hosts set',
      '  restarting prowlarr so the new allowed hosts take effect',
      '  FlareSolverr proxy added (http://flaresolverr:8191/, tag flare)',
      '  sync profile Standard: minimum seeders 1 → 5',
      '  1337x added (flare)',
      '  thepiratebay added (direct)',
      '  limetorrents added (direct)',
      '  Knaben added (direct)',
      '  yts added (direct)',
      '  eztv added (flare)',
      '  application Radarr added',
      '  application Sonarr added',
      '  indexers synced to the applications',
    ]);
    expect(lines.at(-1)).toBe('No drift.');
    expect(s.host.password).toBe('pw');
    expect(s.indexers.every((x) => x.enable && x.appProfileId === 1)).toBe(true);
    expect(s.indexers.filter((x) => x.tags?.includes(3)).map((x) => x.definitionName)).toEqual(['1337x', 'eztv']);
    expect(s.apps.map((a) => a.fields.find((f) => f.name === 'apiKey')?.value)).toEqual(['rk', 'sk']);
  });

  test('apply on a configured Prowlarr writes nothing but the tag and the sync', async () => {
    const { code, lines, calls } = run([], configured());
    expect(await code).toBe(0);
    expect(writes(calls).map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /api/v1/tag',
      'POST /api/v1/command',
    ]);
    expect(lines).toContain('  login and allowed hosts already set');
    expect(lines).toContain('  eztv already set (flare)');
  });

  test('without a Sonarr key, Sonarr is skipped', async () => {
    const { RADARR_API_KEY, ...env } = { ...ENV, SONARR_API_KEY: '' };
    const { code, lines } = run([], fresh(), { env: { ...env, RADARR_API_KEY } });
    expect(await code).toBe(0);
    expect(lines).toContain('  Sonarr: no API key in .env — skipped');
    expect(lines.some((l) => l.includes('application Sonarr'))).toBe(false);
  });

  test('a failed sync is 1', async () => {
    const s = configured();
    s.syncStatus = ['started', 'failed'];
    const { code, lines } = run([], s);
    expect(await code).toBe(1);
    expect(lines.at(-1)).toBe('  FAIL  indexer sync failed: Sync failed: Radarr unreachable');
  });

  test('a sync that never ends gives up after PROWLARR_WAIT', async () => {
    const s = configured();
    s.syncStatus = Array(100).fill('started');
    const { code, lines } = run([], s, { env: { ...ENV, PROWLARR_WAIT: '6' } });
    expect(await code).toBe(1);
    expect(lines.at(-1)).toBe('  FAIL  indexer sync still started after 6s');
  });

  test('missing login or key is 3, on stderr, before any request', async () => {
    const { code, errs, calls } = run(['--check'], configured(), { env: { PROWLARR_API_KEY: 'pk' } });
    expect(await code).toBe(3);
    expect(errs).toEqual(['Set PROWLARR_USER PROWLARR_PASS in /nonexistent/.env.']);
    expect(calls).toEqual([]);
  });

  test('a wrong key is 3 at once', async () => {
    const { code, lines, calls } = run(['--check'], configured(), { key: 'other' });
    expect(await code).toBe(3);
    expect(calls).toHaveLength(1);
    expect(lines.at(-1)).toBe(
      '  FAIL  not answering with PROWLARR_API_KEY (HTTP 401) — is it running, and started with this key?',
    );
  });

  test('down is 3 after PROWLARR_WAIT, as HTTP 000', async () => {
    const { code, lines } = run(['--check'], configured(), { down: true, env: { ...ENV, PROWLARR_WAIT: '6' } });
    expect(await code).toBe(3);
    expect(lines.at(-1)).toBe(
      '  FAIL  not answering with PROWLARR_API_KEY (HTTP 000) — is it running, and started with this key?',
    );
  });

  test('a word it does not know is a usage error', async () => {
    await expect(run(['--now'], configured()).code).rejects.toThrow('usage: configure.sh [--check]');
  });

  test('-h prints the header, exit codes included', async () => {
    const { code, lines } = run(['-h'], configured());
    expect(await code).toBe(0);
    expect(lines[0]).toStartWith("apps/prowlarr/configure.ts — apply Prowlarr's settings");
    expect(lines[0]).toContain('Exit: 0 applied and verified');
  });
});
