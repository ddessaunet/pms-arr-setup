// stack/lib/arr-configure.test.ts — the pure helpers, and main against a fake
// Radarr and Sonarr.
//
// Offline, and changes nothing. The live behaviour — keys fixed by
// <APP>__AUTH__APIKEY, 400 on a root folder that does not exist, secrets
// masked on read, allowedHosts only enforced after a restart, history filtered
// by eventType=3 only — was checked on throwaway Radarr 6.4.4 / Sonarr 4.0.20,
// and the fake below answers as they did.

import { describe, expect, test } from 'bun:test';
import {
  appUrl,
  indexerMinSeeders,
  main,
  profileAllowsRemux,
  profileWithoutRemux,
  ROOT,
  PORT,
  sizesSummary,
  sizesToFix,
  upgradesToFix,
  wantClientFields,
  wantClientTop,
  wantMedia,
  wantNaming,
  wantPlexFields,
  wantPlexTop,
  type QualityDefinition,
  type QualityProfile,
} from './arr-configure.ts';
import { SIZE_CAPS, UPGRADE_PROFILES, type App } from './arr-policy.ts';
import type { HttpRequest, HttpResponse } from './http.ts';
import { fieldsDrift, fieldsSet, resourceDrift, resourceWant, servarr, type Resource } from './servarr.ts';

// ─── per-app differences ──────────────────────────────────────────────────────
describe('per app', () => {
  test('radarr root', () => expect(ROOT.radarr).toBe('/mnt/data/streaming/movies'));
  test('sonarr root', () => expect(ROOT.sonarr).toBe('/mnt/data/streaming/series'));
  test('radarr port', () => expect(PORT.radarr).toBe(7878));
  test('sonarr port', () => expect(PORT.sonarr).toBe(8989));
  test('default URL is local', () => expect(appUrl('radarr', {})).toBe('http://127.0.0.1:7878'));
  test('overridable for rehearsals', () =>
    expect(appUrl('radarr', { RADARR_URL: 'http://127.0.0.1:17878' })).toBe('http://127.0.0.1:17878'));
});

// ─── naming: new imports only, the names Plex expects ────────────────────────
describe('want_naming', () => {
  test('radarr renames new imports', () => expect(wantNaming('radarr').renameMovies).toBe(true));
  test('radarr folder', () => expect(wantNaming('radarr').movieFolderFormat).toBe('{Movie Title} ({Release Year})'));
  test('radarr file', () => expect(wantNaming('radarr').standardMovieFormat).toBe('{Movie Title} ({Release Year})'));
  test('sonarr renames new imports', () => expect(wantNaming('sonarr').renameEpisodes).toBe(true));
  test('sonarr season folder zero-padded', () =>
    expect(wantNaming('sonarr').seasonFolderFormat).toBe('Season {season:00}'));
  test('sonarr episode', () =>
    expect(wantNaming('sonarr').standardEpisodeFormat).toBe('{Series Title} - S{season:00}E{episode:00}'));
});

// ─── media management ─────────────────────────────────────────────────────────
describe('want_media', () => {
  for (const app of ['radarr', 'sonarr'] as const) {
    const M = wantMedia(app);
    test(`${app}: hardlinks`, () => expect(M.copyUsingHardlinks).toBe(true));
    test(`${app}: no recycle bin (a move)`, () => expect(M.recycleBin).toBe(''));
    test(`${app}: never deletes folders`, () => expect(M.deleteEmptyFolders).toBe(false));
    test(`${app}: 10 GB floor`, () => expect(M.minimumFreeSpaceWhenImporting).toBe(10000));
  }
  test('radarr unmonitors deleted movies', () =>
    expect(wantMedia('radarr').autoUnmonitorPreviouslyDownloadedMovies).toBe(true));
  test('sonarr unmonitors deleted episodes', () =>
    expect(wantMedia('sonarr').autoUnmonitorPreviouslyDownloadedEpisodes).toBe(true));
  test("and not the other app's key", () =>
    expect('autoUnmonitorPreviouslyDownloadedEpisodes' in wantMedia('radarr')).toBe(false));
});

// ─── download client ──────────────────────────────────────────────────────────
describe('want_client_fields / want_client_top', () => {
  test('radarr: the :8081 qBittorrent, category radarr', () =>
    expect(wantClientFields('radarr', 'qbtuser')).toEqual({
      host: 'qbittorrent',
      movieCategory: 'radarr',
      port: 8081,
      useSsl: false,
      username: 'qbtuser',
    }));
  test('sonarr: tvCategory sonarr', () => expect(wantClientFields('sonarr', 'qbtuser').tvCategory).toBe('sonarr'));
  test('never carries the password (masked on read, sent separately)', () =>
    expect('password' in wantClientFields('radarr', 'qbtuser')).toBe(false));
  test('Remove Completed and Remove Failed', () =>
    expect([wantClientTop().removeCompletedDownloads, wantClientTop().removeFailedDownloads]).toEqual([true, true]));
});

// ─── Plex connection ──────────────────────────────────────────────────────────
describe('want_plex_*', () => {
  test('through the host gateway', () =>
    expect(`${wantPlexFields().host}:${wantPlexFields().port}`).toBe('host.docker.internal:32400'));
  test('never carries the token', () => expect('authToken' in wantPlexFields()).toBe(false));
  test('radarr refreshes on delete too', () => expect(wantPlexTop('radarr').onMovieFileDelete).toBe(true));
  test('sonarr refreshes on delete too', () => expect(wantPlexTop('sonarr').onEpisodeFileDelete).toBe(true));
});

// ─── size caps and no Remux ───────────────────────────────────────────────────
describe('sizes_to_fix / profile_*_remux', () => {
  const D: QualityDefinition[] = [
    { id: 20, title: 'WEBDL-1080p', minSize: 0, preferredSize: 95, maxSize: 100 },
    { id: 22, title: 'Bluray-1080p', minSize: 0, preferredSize: null, maxSize: null },
    { id: 23, title: 'Remux-1080p', minSize: 0, preferredSize: null, maxSize: null },
    { id: 3, title: 'HDTV-720p', minSize: 0, preferredSize: 95, maxSize: 100 },
  ];
  const F = sizesToFix(D, SIZE_CAPS.radarr);
  test('uncapped 1080p ones are fixed', () => expect(F.map((d) => d.id)).toEqual([20, 22]));
  test('WEB-DL to 80 max, Bluray to 40, both 25 preferred', () =>
    expect(F.map((d) => `${d.maxSize}/${d.preferredSize}`)).toEqual(['80/25', '40/25']));
  test('min and everything else kept', () => expect(`${F[0]?.minSize} ${F[0]?.title}`).toBe('0 WEBDL-1080p'));
  test('Remux and 720p are not in the list', () =>
    expect(F.filter((d) => /Remux|720p/.test(d.title ?? ''))).toEqual([]));
  test('already capped → nothing to fix', () =>
    expect(
      sizesToFix(
        D.map((d) => ({ ...d, maxSize: d.title === 'WEBDL-1080p' ? 80 : 40, preferredSize: 25 })),
        SIZE_CAPS.radarr,
      ),
    ).toEqual([]));
  test('a WEB-DL at 40 is fixed to 80', () =>
    expect(
      sizesToFix(
        D.map((d) => ({ ...d, maxSize: 40, preferredSize: 25 })),
        SIZE_CAPS.radarr,
      ).map((d) => `${d.title} ${d.maxSize}`),
    ).toEqual(['WEBDL-1080p 80']));
  const D4: QualityDefinition[] = [
    { id: 24, title: 'WEBDL-2160p', minSize: 0, preferredSize: null, maxSize: null },
    { id: 27, title: 'Bluray-2160p', minSize: 0, preferredSize: null, maxSize: null },
    { id: 28, title: 'Remux-2160p', minSize: 0, preferredSize: null, maxSize: null },
  ];
  const F4 = sizesToFix(D4, SIZE_CAPS.radarr);
  test('radarr 2160p capped at 200, preferred 100', () =>
    expect(F4.map((d) => `${d.maxSize}/${d.preferredSize}`)).toEqual(['200/100', '200/100']));
  test('Remux-2160p is never capped into eligibility', () =>
    expect(F4.filter((d) => d.title === 'Remux-2160p')).toEqual([]));
  test('summary line', () =>
    expect(sizesSummary(SIZE_CAPS.radarr)).toBe('1080p 40/25, WEBDL-1080p 80/25, 2160p 200/100 MB/min'));
  const DS: QualityDefinition[] = [
    { id: 15, title: 'WEBDL-1080p', minSize: 4, preferredSize: 25, maxSize: 40 },
    { id: 16, title: 'Bluray-1080p', minSize: 4, preferredSize: 95, maxSize: null },
    { id: 12, title: 'WEBDL-720p', minSize: 3, preferredSize: 95, maxSize: 130 },
  ];
  const FS = sizesToFix(DS, SIZE_CAPS.sonarr);
  test('sonarr 1080p gets no max, 25 preferred', () =>
    expect(FS.map((d) => `${d.id}:${d.maxSize}/${d.preferredSize}`)).toEqual(['15:null/25', '16:null/25']));
  test('sonarr already uncapped → nothing to fix', () =>
    expect(
      sizesToFix(
        DS.map((d) => ({ ...d, maxSize: null, preferredSize: 25 })),
        SIZE_CAPS.sonarr,
      ),
    ).toEqual([]));
  test('sonarr summary line', () => expect(sizesSummary(SIZE_CAPS.sonarr)).toBe('1080p no max/25 MB/min'));

  const P = {
    id: 4,
    name: 'HD-1080p',
    items: [
      { quality: { id: 7, name: 'Bluray-1080p' }, allowed: true },
      { quality: { id: 30, name: 'Remux-1080p' }, allowed: true },
      { name: 'WEB 1080p', allowed: true, items: [{ quality: { id: 3, name: 'WEBDL-1080p' }, allowed: true }] },
    ],
  };
  test('a profile allowing Remux is seen', () => expect(profileAllowsRemux(P)).toBe(true));
  const NR = profileWithoutRemux(P);
  test('Remux disallowed', () => expect(profileAllowsRemux(NR)).toBe(false));
  test('and nothing else changed', () =>
    expect([NR.items[0]?.allowed, NR.items[2]?.items?.[0]?.allowed]).toEqual([true, true]));

  // Recyclarr merges the 4K qualities into one group (recyclarr.yml), so the
  // profile's allowed items sit one level down: the Remux walk must still see them.
  const UHD = {
    id: 7,
    name: 'UHD Bluray + WEB',
    items: [
      { quality: { id: 31, name: 'Remux-2160p' }, allowed: true },
      {
        id: 1003,
        name: 'UHD 2160p',
        allowed: true,
        items: [
          { quality: { id: 19, name: 'Bluray-2160p' }, allowed: true },
          { quality: { id: 18, name: 'WEBDL-2160p' }, allowed: true },
        ],
      },
    ],
  };
  test('merged 4K group: Remux off, group and members kept', () => {
    const u = profileWithoutRemux(UHD);
    expect([
      u.items[0]?.allowed,
      u.items[1]?.allowed,
      u.items[1]?.items?.[0]?.allowed,
      u.items[1]?.items?.[1]?.allowed,
    ]).toEqual([false, true, true, true]);
  });

  // The fallback variant adds a 1080p group under the 4K one; Remux-1080p beside
  // it is the mistake that matters there.
  const FB = {
    id: 8,
    name: '4K HDR or 1080p',
    items: [
      { quality: { id: 30, name: 'Remux-1080p' }, allowed: true },
      {
        id: 1004,
        name: 'HD 1080p',
        allowed: true,
        items: [{ quality: { id: 7, name: 'Bluray-1080p' }, allowed: true }],
      },
      {
        id: 1003,
        name: 'UHD 2160p',
        allowed: true,
        items: [{ quality: { id: 19, name: 'Bluray-2160p' }, allowed: true }],
      },
    ],
  };
  test('fallback with Remux-1080p is caught', () => expect(profileAllowsRemux(FB)).toBe(true));
  test('fallback: Remux off, both groups kept', () => {
    const f = profileWithoutRemux(FB);
    expect([
      f.items[0]?.allowed,
      f.items[1]?.allowed,
      f.items[1]?.items?.[0]?.allowed,
      f.items[2]?.allowed,
      f.items[2]?.items?.[0]?.allowed,
    ]).toEqual([false, true, true, true, true]);
  });
});

// ─── minimum seeders, as pushed by Prowlarr ──────────────────────────────────
describe('indexer_min_seeders', () => {
  const IXS = [
    {
      name: 'YTS (Prowlarr)',
      fields: [
        { name: 'minimumSeeders', value: 5 },
        { name: 'seedCriteria.seedRatio', value: null },
      ],
    },
    { name: '1337x (Prowlarr)', fields: [{ name: 'minimumSeeders', value: 5 }] },
  ];
  test('all at the floor', () => expect(indexerMinSeeders(IXS)).toBe('5'));
  test('a sync still on its way', () =>
    expect(indexerMinSeeders([{ ...IXS[0]!, fields: [{ name: 'minimumSeeders', value: 1 }] }, IXS[1]!])).toBe('1,5'));
  test('field missing → unset', () => expect(indexerMinSeeders([{ name: 'x', fields: [] }])).toBe('unset'));
});

// ─── the upgrade allow-list ───────────────────────────────────────────────────
describe('upgrades_to_fix', () => {
  const PR: QualityProfile[] = [
    { id: 4, name: 'HD-1080p', upgradeAllowed: true },
    { id: 7, name: 'UHD Bluray + WEB', upgradeAllowed: false },
    { id: 1, name: 'Any', upgradeAllowed: false },
    { id: 8, name: '4K HDR or 1080p', upgradeAllowed: false },
  ];
  test('HD-1080p off, both 4K profiles on, Any untouched', () =>
    expect(upgradesToFix(PR, UPGRADE_PROFILES.radarr).map((p) => ({ name: p.name, u: p.upgradeAllowed }))).toEqual([
      { name: 'HD-1080p', u: false },
      { name: 'UHD Bluray + WEB', u: true },
      { name: '4K HDR or 1080p', u: true },
    ]));
  test('already right → nothing to fix', () =>
    expect(
      upgradesToFix(
        PR.map((p) => ({ ...p, upgradeAllowed: UPGRADE_PROFILES.radarr.includes(p.name ?? '') })),
        UPGRADE_PROFILES.radarr,
      ),
    ).toEqual([]));
  test('sonarr: every upgrading profile turned off', () =>
    expect(upgradesToFix(PR, UPGRADE_PROFILES.sonarr).map((p) => p.name)).toEqual(['HD-1080p']));
  // The hand-picked UHD Fallback (recyclarr.yml) never upgrades.
  test('fallback upgrading → turned off', () =>
    expect(
      upgradesToFix([...PR, { id: 8, name: 'UHD Fallback', upgradeAllowed: true }], UPGRADE_PROFILES.radarr).find(
        (p) => p.name === 'UHD Fallback',
      )?.upgradeAllowed,
    ).toBe(false));
});

// ─── resources (stack/lib/servarr.ts) ─────────────────────────────────────────
describe('fields_set / fields_drift / resource_want / resource_drift', () => {
  const R: Resource = {
    id: 3,
    name: 'qBittorrent',
    enable: true,
    removeCompletedDownloads: true,
    fields: [
      { name: 'host', value: 'qbittorrent' },
      { name: 'port', value: 8081 },
      { name: 'password', value: '********' },
      { name: 'movieCategory', value: 'radarr' },
    ],
  };
  test('set replaces only named fields', () =>
    expect(fieldsSet(R, { host: 'qb2' }).fields.map((f) => f.value)).toEqual(['qb2', 8081, '********', 'radarr']));
  test('set ignores names the resource lacks', () => expect(fieldsSet(R, { nope: 1 }).fields).toHaveLength(4));
  test('no field drift when equal', () => expect(fieldsDrift(R, { host: 'qbittorrent', port: 8081 })).toEqual([]));
  test('field drift is named', () => expect(fieldsDrift(R, { movieCategory: 'other' })).toEqual(['movieCategory']));
  test('resource drift: top-level and fields together', () =>
    expect(resourceDrift(R, { removeCompletedDownloads: false }, { movieCategory: 'other' })).toEqual([
      'removeCompletedDownloads',
      'movieCategory',
    ]));
  test('resource_want: top-level merged, fields set, id kept', () => {
    const w = resourceWant(R, { enable: false }, { host: 'x' });
    expect({ id: w.id, enable: w.enable, host: w.fields[0]?.value }).toEqual({ id: 3, enable: false, host: 'x' });
  });
});

// ─── shared host config (stack/lib/servarr.ts) ────────────────────────────────
describe('allowed_hosts / want_host', () => {
  const px = (extraHosts?: string[]) =>
    servarr(
      { name: 'radarr', url: '', key: '', api: 'v3', user: 'dario', pass: '', timeoutMs: 1, waitMs: 1, extraHosts },
      {
        http: async () => ({ status: 0, text: '', headers: new Headers() }),
        log: () => {},
        sleep: async () => {},
        now: () => 0,
        hostname: () => 'pms',
        lanIps: () => ['192.168.0.86'],
      },
    );
  test('service name first, LAN IPv4 only', () =>
    expect(px().allowedHosts()).toBe('radarr,localhost,127.0.0.1,pms,192.168.0.86'));
  test('rehearsal names appended when asked', () =>
    expect(px(['probe-radarr']).allowedHosts()).toBe('radarr,localhost,127.0.0.1,pms,192.168.0.86,probe-radarr'));
  test('unset extra is fine under set -u', () =>
    expect(px(undefined).allowedHosts()).toBe('radarr,localhost,127.0.0.1,pms,192.168.0.86'));
  test('forms, not required locally, no password', () => {
    const h = px().wantHost();
    expect({ m: h.authenticationMethod, r: h.authenticationRequired, has_pw: 'password' in h }).toEqual({
      m: 'forms',
      r: 'disabledForLocalAddresses',
      has_pw: false,
    });
  });
});

// ─── main, against a fake Radarr and Sonarr ───────────────────────────────────

const LAN = '10.0.0.50';
const ENV = {
  RADARR_API_KEY: 'rk',
  SONARR_API_KEY: 'sk',
  ARR_USER: 'dario',
  ARR_PASS: 'p&ss',
  QBT_ARR_USER: 'arr',
  QBT_ARR_PASS: 'qp',
  PLEX_TOKEN: 'pt',
};
const HOSTS = (app: App) => `${app},localhost,127.0.0.1,pms,${LAN}`;

interface AppState {
  up: boolean;
  host: Record<string, unknown>;
  naming: Record<string, unknown>;
  media: Record<string, unknown>;
  roots: { id: number; path: string }[];
  profiles: QualityProfile[];
  defs: QualityDefinition[];
  /** Reads of the definitions that still show the old sizes after an update. */
  lateReads: number;
  clients: Resource[];
  notifications: Resource[];
  indexers: { name: string; fields: { name: string; value: unknown }[] }[];
  restarts: number;
}

const ALL_DEFS = (app: App): QualityDefinition[] =>
  [...SIZE_CAPS[app].map((c) => c.quality), 'Remux-1080p', 'HDTV-720p'].map((title, i) => ({
    id: i + 1,
    title,
    minSize: 0,
    maxSize: null,
    preferredSize: null,
  }));

const profile = (id: number, name: string, upgradeAllowed: boolean, remux = false): QualityProfile => ({
  id,
  name,
  upgradeAllowed,
  items: [
    { quality: { id: 30, name: 'Remux-2160p' }, allowed: remux },
    { name: 'UHD 2160p', allowed: true, items: [{ quality: { id: 19, name: 'Bluray-2160p' }, allowed: true }] },
  ],
});

const SCHEMA = {
  QBittorrent: {
    implementation: 'QBittorrent',
    enable: false,
    fields: ['host', 'port', 'useSsl', 'username', 'password', 'movieCategory', 'tvCategory'].map((name) => ({ name })),
  },
  PlexServer: {
    implementation: 'PlexServer',
    fields: ['host', 'port', 'useSsl', 'authToken', 'updateLibrary'].map((name) => ({ name })),
  },
};

/** A fresh app with Recyclarr's profiles: defaults everywhere else. */
function fresh(app: App): AppState {
  return {
    up: true,
    host: { id: 1, bindAddress: '*', authenticationMethod: 'none', allowedHosts: '' },
    naming: { id: 1, renameMovies: false, renameEpisodes: false, replaceIllegalCharacters: true },
    media: { id: 1, copyUsingHardlinks: true, recycleBin: '/recycle', setPermissionsLinux: false },
    roots: [],
    profiles:
      app === 'radarr'
        ? [
            profile(1, 'Any', true),
            profile(7, 'UHD Bluray + WEB', false, true),
            profile(8, '4K HDR or 1080p', false),
            profile(9, 'UHD Fallback', true),
          ]
        : [profile(1, 'Any', false), profile(6, 'WEB-1080p', true)],
    defs: ALL_DEFS(app),
    lateReads: 0,
    clients: [],
    notifications: [],
    indexers: [],
    restarts: 0,
  };
}

/** As the box has it: what `apply` leaves. */
function configured(app: App): AppState {
  const s = fresh(app);
  s.host = {
    ...s.host,
    username: ENV.ARR_USER,
    authenticationMethod: 'forms',
    authenticationRequired: 'disabledForLocalAddresses',
    allowedHosts: HOSTS(app),
  };
  s.naming = { ...s.naming, ...wantNaming(app) };
  s.media = { ...s.media, ...wantMedia(app) };
  s.roots = [{ id: 1, path: `${ROOT[app]}/` }];
  s.profiles = s.profiles.map((p) => ({
    ...profileWithoutRemux(p),
    upgradeAllowed: UPGRADE_PROFILES[app].includes(p.name ?? ''),
  }));
  s.defs = [...sizesToFix(s.defs, SIZE_CAPS[app]), ...s.defs.filter((d) => /Remux|720p/.test(d.title ?? ''))];
  const clientWant = resourceWant({ ...SCHEMA.QBittorrent, id: 1 }, wantClientTop(), {
    ...wantClientFields(app, ENV.QBT_ARR_USER),
    password: '********',
  });
  s.clients = [clientWant];
  s.notifications = [
    resourceWant({ ...SCHEMA.PlexServer, id: 1 }, wantPlexTop(app), { ...wantPlexFields(), authToken: '********' }),
  ];
  s.indexers = [{ name: 'YTS (Prowlarr)', fields: [{ name: 'minimumSeeders', value: 5 }] }];
  return s;
}

function fakeArrs(states: Record<App, AppState>) {
  const writes: string[] = [];
  let stale: QualityDefinition[] | undefined;
  let staleLeft = 0;
  const reply = (status: number, body?: unknown, headers: Record<string, string> = {}): HttpResponse => ({
    status,
    text: body === undefined ? '' : JSON.stringify(body),
    headers: new Headers(headers),
  });
  const http = async (url: string, req: HttpRequest): Promise<HttpResponse> => {
    const u = new URL(url);
    const app: App = u.port === '7878' ? 'radarr' : 'sonarr';
    const s = states[app];
    if (!s.up) return reply(0);
    const method = req.method ?? 'GET';
    if (u.pathname === '/login') {
      const form = new URLSearchParams(req.body instanceof URLSearchParams ? req.body : String(req.body ?? ''));
      const ok =
        form.get('username') === ENV.ARR_USER &&
        form.get('password') === ENV.ARR_PASS &&
        s.host.authenticationMethod === 'forms';
      return reply(302, undefined, { Location: ok ? '/' : '/login?returnUrl=/&loginFailed=true' });
    }
    if (req.headers?.['X-Api-Key'] !== (app === 'radarr' ? ENV.RADARR_API_KEY : ENV.SONARR_API_KEY)) return reply(401);
    const path = u.pathname.replace(/^\/api\/v3/, '');
    const body = typeof req.body === 'string' && req.body !== '' ? JSON.parse(req.body) : undefined;
    if (method !== 'GET' && !path.endsWith('/test')) writes.push(`${app} ${method} ${path}`);
    const id = Number(path.split('/').pop());
    const defsNow = () => (stale && staleLeft-- > 0 ? stale : s.defs);
    const resources = (kind: string) => (kind === 'downloadclient' ? s.clients : s.notifications);
    const kind = path.split('/')[1] ?? '';
    switch (true) {
      case path === '/system/status':
        return reply(200, { version: app === 'radarr' ? '6.4.4.10685' : '4.0.20.3014' });
      case path === '/system/restart':
        s.restarts++;
        return reply(200);
      case path === '/config/host' && method === 'GET':
        return reply(200, s.host);
      case path.startsWith('/config/host/'): {
        const { password: _, passwordConfirmation: __, ...rest } = body;
        s.host = rest;
        return reply(202, s.host);
      }
      case path === '/config/naming':
        return reply(200, s.naming);
      case path.startsWith('/config/naming/'):
        s.naming = body;
        return reply(202, body);
      case path === '/config/mediamanagement':
        return reply(200, s.media);
      case path.startsWith('/config/mediamanagement/'):
        s.media = body;
        return reply(202, body);
      case path === '/rootfolder' && method === 'GET':
        return reply(200, s.roots);
      case path === '/rootfolder':
        s.roots.push({ id: s.roots.length + 1, path: body.path });
        return reply(201, body);
      case path === '/qualityprofile':
        return reply(200, s.profiles);
      case path.startsWith('/qualityprofile/'):
        s.profiles = s.profiles.map((p) => (p.id === id ? body : p));
        return reply(202, body);
      case path === '/qualitydefinition/update':
        // Reads show the old sizes for lateReads more reads, as Radarr 6.4 does.
        stale = s.lateReads > 0 ? s.defs : undefined;
        staleLeft = s.lateReads;
        s.defs = s.defs.map((d) => (body as QualityDefinition[]).find((b) => b.id === d.id) ?? d);
        return reply(202, body);
      case path === '/qualitydefinition':
        return reply(200, defsNow());
      case path.startsWith('/qualitydefinition/'):
        return reply(
          200,
          defsNow().find((d) => d.id === id),
        );
      case path === `/${kind}/schema`:
        return reply(200, [kind === 'downloadclient' ? SCHEMA.QBittorrent : SCHEMA.PlexServer]);
      case path === `/${kind}/test`:
        return reply(200);
      case (kind === 'downloadclient' || kind === 'notification') && method === 'GET':
        // Secrets come back masked.
        return reply(
          200,
          resources(kind).map((r) => ({
            ...r,
            fields: r.fields.map((f) => (['password', 'authToken'].includes(f.name) ? { ...f, value: '********' } : f)),
          })),
        );
      case (kind === 'downloadclient' || kind === 'notification') && method === 'POST':
        resources(kind).push({ ...body, id: 1 });
        return reply(201, body);
      case (kind === 'downloadclient' || kind === 'notification') && method === 'PUT': {
        const list = resources(kind);
        list[list.findIndex((r) => r.id === id)] = body;
        return reply(202, body);
      }
      case path === '/indexer':
        return reply(200, s.indexers);
      default:
        return reply(404);
    }
  };
  return { http, writes };
}

async function run(argv: string[], states: Record<App, AppState>, env: Record<string, string> = {}) {
  const fake = fakeArrs(states);
  const lines: string[] = [];
  const errs: string[] = [];
  let clock = 0;
  const code = await main(argv, {
    http: fake.http,
    log: (l) => void lines.push(l),
    err: (l) => void errs.push(l),
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    hostname: () => 'pms',
    lanIps: () => [LAN],
    env: { ...ENV, ...env },
    repo: '/nonexistent',
  });
  return { code, lines, errs, writes: fake.writes };
}

const both = (f: (app: App) => AppState) => ({ radarr: f('radarr'), sonarr: f('sonarr') });

const RADARR_READBACK = [
  'Read-back:',
  `  ok       host: forms login, not required locally; allowed hosts ${HOSTS('radarr')}`,
  '  ok       login as dario',
  '  ok       naming',
  '  ok       mediamanagement',
  '  ok       root folder /mnt/data/streaming/movies',
  '  ok       upgrades only on: UHD Bluray + WEB, 4K HDR or 1080p',
  "  ok       default profile 'UHD Bluray + WEB' exists, no Remux",
  "  ok       profile '4K HDR or 1080p' exists, no Remux",
  "  ok       profile 'UHD Fallback' exists, no Remux",
  '  ok       sizes capped: 1080p 40/25, WEBDL-1080p 80/25, 2160p 200/100 MB/min',
  '  ok       download client — test passes',
  '  ok       Plex connection — test passes',
  '  ok       1 indexer(s), synced from Prowlarr, minimum seeders 5',
  'No drift.',
];

describe('main', () => {
  test('--check on the configured box: no drift for either, nothing written', async () => {
    const r = await run(['--check'], both(configured));
    expect(r.code).toBe(0);
    expect(r.lines.slice(0, 17)).toEqual([
      'Radarr at http://127.0.0.1:7878 (check)',
      '  API up: 6.4.4.10685',
      ...RADARR_READBACK,
    ]);
    expect(r.lines.slice(18, 20)).toEqual(['Sonarr at http://127.0.0.1:8989 (check)', '  API up: 4.0.20.3014']);
    expect(r.lines).toContain('  ok       upgrades only on: (none)');
    expect(r.lines).toContain('  ok       sizes capped: 1080p no max/25 MB/min');
    expect(r.lines.at(-1)).toBe('');
    expect(r.writes).toEqual([]);
  });

  test('one app only', async () => {
    const r = await run(['sonarr', '--check'], both(configured));
    expect(r.code).toBe(0);
    expect(r.lines[0]).toBe('Sonarr at http://127.0.0.1:8989 (check)');
    expect(r.lines.filter((l) => l.endsWith('(check)'))).toHaveLength(1);
  });

  test('apply on the configured box writes nothing', async () => {
    const r = await run(['radarr'], both(configured));
    expect(r.code).toBe(0);
    expect(r.lines.slice(2, 14)).toEqual([
      '  login and allowed hosts already set',
      '  naming already set',
      '  mediamanagement already set',
      '  root folder /mnt/data/streaming/movies already set',
      '  upgrades already only on: UHD Bluray + WEB, 4K HDR or 1080p',
      '  UHD Bluray + WEB already without Remux',
      '  4K HDR or 1080p already without Remux',
      '  UHD Fallback already without Remux',
      '  sizes already capped (1080p 40/25, WEBDL-1080p 80/25, 2160p 200/100 MB/min)',
      '  download client already set',
      '  Plex connection already set',
      'Read-back:',
    ]);
    expect(r.writes).toEqual([]);
  });

  test('a fresh Radarr: everything applied, then no drift', async () => {
    const states = both(fresh);
    const r = await run(['radarr'], states);
    expect(r.code).toBe(0);
    expect(r.lines.slice(2, 19)).toEqual([
      '  login and allowed hosts set',
      '  restarting radarr so the new allowed hosts take effect',
      '  naming set (renameMovies movieFolderFormat standardMovieFormat)',
      '  mediamanagement set (recycleBin deleteEmptyFolders importExtraFiles extraFileExtensions minimumFreeSpaceWhenImporting autoUnmonitorPreviouslyDownloadedMovies)',
      '  root folder /mnt/data/streaming/movies added',
      '  upgrades off for Any',
      '  upgrades on for UHD Bluray + WEB',
      '  upgrades on for 4K HDR or 1080p',
      '  upgrades off for UHD Fallback',
      '  Remux removed from UHD Bluray + WEB',
      '  4K HDR or 1080p already without Remux',
      '  UHD Fallback already without Remux',
      '  sizes capped: 1080p 40/25, WEBDL-1080p 80/25, 2160p 200/100 MB/min (8 quality/ies changed)',
      '  download client added',
      '  Plex connection added',
      'Read-back:',
      `  ok       host: forms login, not required locally; allowed hosts ${HOSTS('radarr')}`,
    ]);
    expect(r.lines.at(-2)).toBe('No drift.');
    expect(states.radarr.restarts).toBe(1);
    // Secrets go in on the write; Remux-1080p and 720p keep their sizes.
    expect(states.radarr.clients[0]?.fields.find((f) => f.name === 'password')?.value).toBe('qp');
    expect(states.radarr.notifications[0]?.fields.find((f) => f.name === 'authToken')?.value).toBe('pt');
    expect(states.radarr.defs.filter((d) => d.maxSize !== null).map((d) => d.title)).not.toContain('Remux-1080p');
  });

  test('sizes that read back late are not drift', async () => {
    const s = both(configured);
    s.radarr.defs = ALL_DEFS('radarr');
    s.radarr.lateReads = 9; // a list read and 8 by-id reads: one full pass still old
    const r = await run(['radarr'], s);
    expect(r.code).toBe(0);
    expect(r.lines).toContain('  ok       sizes capped: 1080p 40/25, WEBDL-1080p 80/25, 2160p 200/100 MB/min');
  });

  test('…which is drift without the re-reads', async () => {
    const s = both(configured);
    s.radarr.defs = ALL_DEFS('radarr');
    s.radarr.lateReads = 9;
    const r = await run(['radarr'], s, { SIZE_SETTLE: '1' });
    expect(r.code).toBe(1);
    expect(r.lines).toContain(
      '  DRIFT    8 quality size(s) not capped (1080p 40/25, WEBDL-1080p 80/25, 2160p 200/100 MB/min)',
    );
  });

  test('--check names drift and says how to apply', async () => {
    const s = both(configured);
    s.radarr.media = { ...s.radarr.media, recycleBin: '/recycle' };
    s.radarr.roots = [];
    s.radarr.profiles = s.radarr.profiles.map((p) => (p.name === 'Any' ? { ...p, upgradeAllowed: true } : p));
    s.radarr.defs = s.radarr.defs.map((d) => (d.title === 'WEBDL-1080p' ? { ...d, maxSize: 40 } : d));
    s.sonarr.profiles = s.sonarr.profiles.filter((p) => p.name !== 'WEB-1080p');
    s.sonarr.clients[0] = { ...s.sonarr.clients[0]!, removeCompletedDownloads: false };
    const r = await run(['--check'], s, { SIZE_SETTLE: '2' });
    expect(r.code).toBe(1);
    expect(r.lines).toContain('  DRIFT    mediamanagement: recycleBin ');
    expect(r.lines).toContain('  DRIFT    root folder /mnt/data/streaming/movies missing');
    expect(r.lines).toContain('  DRIFT    1 profile(s) with upgrades set the wrong way: Any');
    expect(r.lines).toContain(
      '  DRIFT    1 quality size(s) not capped (1080p 40/25, WEBDL-1080p 80/25, 2160p 200/100 MB/min)',
    );
    expect(r.lines).toContain("  DRIFT    default profile 'WEB-1080p' missing — task recyclarr:sync");
    expect(r.lines).toContain('  DRIFT    download client: removeCompletedDownloads ');
    expect(r.lines.at(-1)).toBe('To apply: task arr:configure');
    expect(r.writes).toEqual([]);
  });

  test('a profile allowing Remux is drift', async () => {
    const s = both(configured);
    s.radarr.profiles = s.radarr.profiles.map((p) =>
      p.name === 'UHD Fallback' ? profile(9, 'UHD Fallback', false, true) : p,
    );
    const r = await run(['radarr', '--check'], s);
    expect(r.lines).toContain("  DRIFT    'UHD Fallback' allows Remux");
  });

  test("a profile Recyclarr hasn't made yet is a warning on apply", async () => {
    const s = both(configured);
    s.radarr.profiles = s.radarr.profiles.filter((p) => p.name !== 'UHD Fallback');
    const r = await run(['radarr'], s);
    expect(r.lines).toContain("  WARN  no 'UHD Fallback' profile yet — run task recyclarr:sync first");
    expect(r.code).toBe(1); // still drift on the read-back
  });

  test('no indexers yet: a warning, not drift', async () => {
    const s = both(configured);
    s.sonarr.indexers = [];
    const r = await run(['sonarr', '--check'], s);
    expect(r.code).toBe(0);
    expect(r.lines).toContain('  WARN     no indexers yet — task prowlarr:configure pushes them');
  });

  test('one app down: 3 for the run, the other still checked', async () => {
    const s = both(configured);
    s.radarr.up = false;
    const r = await run(['--check'], s, { ARR_WAIT: '6' });
    expect(r.code).toBe(3);
    expect(r.lines[1]).toBe(
      '  FAIL  not answering with RADARR_API_KEY (HTTP 000) — is it running, and started with this key?',
    );
    expect(r.lines).toContain('No drift.');
    expect(r.lines.at(-1)).toBe('');
  });

  test('a key missing for one app', async () => {
    const r = await run(['--check'], both(configured), { SONARR_API_KEY: '' });
    expect(r.code).toBe(3);
    expect(r.lines).toContain('sonarr: SONARR_API_KEY is not set in .env');
  });

  test('missing shared .env keys: 3, naming them', async () => {
    const r = await run([], both(configured), { QBT_ARR_PASS: '', PLEX_TOKEN: '' });
    expect(r.code).toBe(3);
    expect(r.errs).toEqual(['Set QBT_ARR_PASS PLEX_TOKEN in /nonexistent/.env.']);
  });

  test('a word it does not know is a usage error', async () => {
    await expect(run(['lidarr'], both(configured))).rejects.toThrow(
      'usage: arr-configure.sh [radarr|sonarr|all] [--check]',
    );
    await expect(run(['--now'], both(configured))).rejects.toThrow('usage:');
  });
});
