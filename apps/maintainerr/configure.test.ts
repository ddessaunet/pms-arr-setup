// apps/maintainerr/configure.test.ts — what is written, and main against a fake Maintainerr.
//
// Offline, and changes nothing outside a temp dir. The fake answers as
// Maintainerr 3.30.2's source does (read from its controllers and services):
// failures as {code: 0}, secrets masked in GET /settings, Plex settings refused
// until a token is stored, rule rows holding ruleJson as sent, and rules dropped
// unless useRules is sent.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpRequest, HttpResponse } from '../../stack/lib/http.ts';
import type { ApiResult, JsonObject } from '../../stack/lib/servarr.ts';
import {
  ACTIONS_ON,
  ARR_ACTION,
  DELETE_AFTER_DAYS,
  friendlyNameOf,
  GROUPS,
  groupAction,
  groupDrift,
  KEEP,
  main,
  normRule,
  notificationDrift,
  NOTIFY,
  NOTIFY_DAYS_BEFORE,
  ratingKeyOf,
  refused,
  TELEGRAM_NAME,
  TELEGRAM_TYPES,
  wantGroup,
  wantNotification,
  wantSettings,
} from './configure.ts';

const tmp = mkdtempSync(join(tmpdir(), 'maintainerr-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const IDS = { libraryId: '1', arrId: 1, notificationIds: [7] };
const byName = (n: string) => GROUPS.find((g) => g.name === n)!;

// ─── the one switch ──────────────────────────────────────────────────────────
describe('actions', () => {
  test('ACTIONS_ON is off: nothing is deleted until it is switched here', () => expect(ACTIONS_ON).toBe(false));
  test('every group does nothing while it is off', () =>
    expect(GROUPS.map((g) => wantGroup(g, IDS).arrAction)).toEqual(GROUPS.map(() => ARR_ACTION.DO_NOTHING)));
  test('do nothing is 4 (ServarrAction.DO_NOTHING)', () => expect(ARR_ACTION.DO_NOTHING).toBe(4));
  test('switched on, each group runs its own action', () =>
    expect(GROUPS.map((g) => groupAction(g, true))).toEqual(GROUPS.map((g) => g.actionOn)));
  test('a season is deleted, never its show (0 on a season group)', () =>
    expect(byName('Leaving Soon - Watched Seasons').actionOn).toBe(ARR_ACTION.DELETE));
});

// ─── the groups ──────────────────────────────────────────────────────────────
describe('groups', () => {
  test('the shelves', () =>
    expect(GROUPS.map((g) => `${g.name} | ${g.library} ${g.dataType}`)).toEqual([
      'Leaving Soon - Unwatched Movies | movie movie',
      'Leaving Soon - Watched Movies | movie movie',
      'Leaving Soon - Watched Seasons | show season',
    ]));
  test('unwatched: added over 120 days ago AND never played', () =>
    expect(byName('Leaving Soon - Unwatched Movies').rules).toEqual([
      {
        operator: null,
        action: 5,
        firstVal: [0, 0],
        customVal: { ruleTypeId: 0, value: String(120 * 86400) },
        section: 0,
      },
      { operator: 0, action: 2, firstVal: [0, 5], customVal: { ruleTypeId: 0, value: '0' }, section: 0 },
    ]));
  test('watched: last played over 180 days ago', () =>
    expect(byName('Leaving Soon - Watched Movies').rules).toEqual([
      {
        operator: null,
        action: 5,
        firstVal: [0, 7],
        customVal: { ruleTypeId: 0, value: String(180 * 86400) },
        section: 0,
      },
    ]));
  test('seasons: every episode viewed AND the last one over 60 days ago', () =>
    expect(byName('Leaving Soon - Watched Seasons').rules).toEqual([
      { operator: null, action: 2, firstVal: [0, 15], lastVal: [0, 14], section: 0 },
      {
        operator: 0,
        action: 5,
        firstVal: [0, 13],
        customVal: { ruleTypeId: 0, value: String(60 * 86400) },
        section: 0,
      },
    ]));
  test('only the first rule has no operator (Maintainerr refuses another)', () =>
    expect(GROUPS.every((g) => g.rules.every((r, i) => (i === 0) === (r.operator === null)))).toBe(true));
  test('KEEP starts empty', () => expect(KEEP).toEqual([]));
});

describe('wantGroup', () => {
  const M = wantGroup(byName('Leaving Soon - Unwatched Movies'), IDS);
  const S = wantGroup(byName('Leaving Soon - Watched Seasons'), { ...IDS, libraryId: '2', arrId: 3 });
  const C = M.collection as JsonObject;
  test('useRules is sent, or the rules are dropped', () => expect(M.useRules).toBe(true));
  test('rules are always an array', () => expect(Array.isArray(M.rules)).toBe(true));
  test('notifications are sent every time (a PUT without them unlinks them)', () =>
    expect(M.notifications).toEqual([{ id: 7 }]));
  test('a movie group names Radarr, a season group Sonarr', () =>
    expect(`${M.radarrSettingsId} ${'sonarrSettingsId' in M} | ${S.sonarrSettingsId} ${'radarrSettingsId' in S}`).toBe(
      '1 false | 3 false',
    ));
  test('on the Plex home screen, with the overlay, not on recommended', () =>
    expect(`${C.visibleOnHome} ${C.overlayEnabled} ${C.visibleOnRecommended}`).toBe('true true false'));
  test('the default overlay template', () => expect(C.overlayTemplateId).toBeNull());
  test(`${DELETE_AFTER_DAYS} days on the shelf`, () => expect(C.deleteAfterDays).toBe(14));
  test('the Seerr request is cleared; no Radarr import-list exclusion', () =>
    expect(`${M.forceSeerr} ${M.listExclusions}`).toBe('true false'));
  test('never an automatic collection by hand', () => expect(C.manualCollection).toBe(false));
});

// What GET /api/rules returns for a group written with `want`: the collection
// holds the action and the app, the rules are rows of ruleJson.
function stored(want: JsonObject, id = 1): Record<string, unknown> {
  const {
    collection,
    rules,
    notifications,
    arrAction,
    forceSeerr,
    listExclusions,
    radarrSettingsId,
    sonarrSettingsId,
    ...rest
  } = want;
  return {
    id,
    ...rest,
    collectionId: id,
    collection: {
      id,
      ...(collection as JsonObject),
      arrAction,
      forceSeerr,
      listExclusions,
      radarrSettingsId: radarrSettingsId ?? null,
      sonarrSettingsId: sonarrSettingsId ?? null,
      title: want.name,
    },
    notifications: (notifications as JsonObject[]).map((n) => ({ ...n, name: 'x', agent: 'telegram' })),
    rules: (rules as JsonObject[]).map((r, i) => ({
      id: 10 + i,
      ruleJson: JSON.stringify(r),
      section: r.section,
      isActive: true,
    })),
  };
}

describe('groupDrift', () => {
  const W = wantGroup(byName('Leaving Soon - Unwatched Movies'), IDS);
  test('as written → no drift', () => expect(groupDrift(stored(W), W)).toEqual([]));
  test('an action changed in the WebUI is named', () => {
    const g = stored(W);
    (g.collection as Record<string, unknown>).arrAction = 0;
    expect(groupDrift(g, W)).toEqual(['arrAction']);
  });
  test('a rule changed is named', () => {
    const g = stored({ ...W, rules: [W.rules as JsonObject[]][0]!.slice(0, 1) });
    expect(groupDrift(g, W)).toEqual(['rules']);
  });
  test('an agent unlinked is named', () =>
    expect(groupDrift(stored({ ...W, notifications: [] }), W)).toEqual(['notifications']));
  test('the shelf hidden is named', () => {
    const g = stored(W);
    (g.collection as Record<string, unknown>).visibleOnHome = false;
    expect(groupDrift(g, W)).toEqual(['collection.visibleOnHome']);
  });
  test('rule rows compare in id order', () => {
    const g = stored(W);
    (g.rules as unknown[]).reverse();
    expect(groupDrift(g, W)).toEqual([]);
  });
  test('normRule: numbers as numbers, only a rule’s keys', () =>
    expect(
      normRule({
        operator: '0',
        action: '5',
        firstVal: [0, 0],
        customVal: { ruleTypeId: '0', value: 60 },
        section: 0,
        x: 1,
      }),
    ).toEqual({
      operator: 0,
      action: 5,
      firstVal: [0, 0],
      customVal: { ruleTypeId: 0, value: '60' },
      section: 0,
    }));
});

describe('notification', () => {
  const W = wantNotification({ botAuthToken: 'bt', chatId: '42' });
  test('about to be handled, handled, and both failures', () =>
    expect(TELEGRAM_TYPES).toEqual([
      NOTIFY.MEDIA_ABOUT_TO_BE_HANDLED,
      NOTIFY.MEDIA_HANDLED,
      NOTIFY.RULE_HANDLING_FAILED,
      NOTIFY.COLLECTION_HANDLING_FAILED,
    ]));
  test('their numbers (a bitmask in Maintainerr)', () => expect(W.types).toEqual([8, 16, 32, 64]));
  test(`${NOTIFY_DAYS_BEFORE} days before removal (aboutScale)`, () => expect(W.aboutScale).toBe(3));
  test('the telegram agent, by our name', () => expect(`${W.agent} ${W.name}`).toBe(`telegram ${TELEGRAM_NAME}`));
  test('as stored → no drift', () => expect(notificationDrift({ id: 1, ...W, types: [64, 8, 32, 16] }, W)).toEqual([]));
  test('a new chat id is named', () =>
    expect(notificationDrift({ ...W, options: { botAuthToken: 'bt', chatId: '1' } }, W)).toEqual(['options.chatId']));
});

describe('helpers', () => {
  test('Plex through the host gateway, as Plex, by hand', () =>
    expect(wantSettings('Box')).toEqual({
      media_server_type: 'plex',
      plex_name: 'Box',
      plex_hostname: 'host.docker.internal',
      plex_port: 32400,
      plex_ssl: 0,
      plex_manual_mode: 1,
    }));
  const r = (status: number, json: unknown): ApiResult => ({ ok: status < 300, status, text: '', json });
  test('{code: 0} on a 200 is a failure', () => expect(refused(r(200, { status: 'NOK', code: 0 }))).toBe(true));
  test('{code: 1} and plain bodies are not', () =>
    expect([refused(r(201, { code: 1 })), refused(r(200, [])), refused(r(500, {}))]).toEqual([false, false, true]));
  test("Plex's name", () => expect(friendlyNameOf('<MediaContainer friendlyName="sapphire" x="1">')).toBe('sapphire'));
  test('a Plex search’s first ratingKey', () =>
    expect([ratingKeyOf({ MediaContainer: { Metadata: [{ ratingKey: '123' }] } }), ratingKeyOf({})]).toEqual([
      '123',
      '',
    ]));
});

// ─── main, against a fake Maintainerr ────────────────────────────────────────

type Obj = Record<string, unknown>;

function fakeMaintainerr() {
  const st = {
    up: true,
    token: '',
    settings: {
      media_server_type: null,
      plex_name: null,
      plex_hostname: null,
      plex_port: null,
      plex_ssl: null,
      plex_manual_mode: 0,
    } as Obj,
    arr: { radarr: [] as Obj[], sonarr: [] as Obj[] },
    seerr: { url: null, api_key: null } as Obj,
    overlays: { enabled: false } as Obj,
    notes: [] as Obj[],
    groups: [] as Obj[],
    writes: [] as string[],
    nextId: 1,
  };
  const OK = { status: 'OK', code: 1, message: 'Success' };
  const NOK = (message: string) => ({ status: 'NOK', code: 0, message });
  const groupRow = (body: Obj, id: number): Obj => {
    const {
      collection,
      rules,
      notifications,
      arrAction,
      forceSeerr,
      listExclusions,
      radarrSettingsId,
      sonarrSettingsId,
      id: _,
      ...rest
    } = body;
    return {
      id,
      ...rest,
      collection: {
        id,
        ...(collection as Obj),
        arrAction,
        forceSeerr,
        listExclusions,
        radarrSettingsId: radarrSettingsId ?? null,
        sonarrSettingsId: sonarrSettingsId ?? null,
      },
      notifications: ((notifications as Obj[] | undefined) ?? []).map((n) => st.notes.find((x) => x.id === n.id)),
      // Rules only with useRules sent (rules.service.ts).
      rules: body.useRules
        ? (rules as Obj[]).map((r, i) => ({ id: id * 100 + i, ruleJson: JSON.stringify(r), section: r.section }))
        : [],
    };
  };

  const handle = (method: string, path: string, body: Obj | undefined): [number, unknown] => {
    if (method !== 'GET') st.writes.push(`${method} ${path}`);
    if (path === '/health/ready') return st.up ? [200, { status: 'ok' }] : [503, {}];
    if (path === '/app/status') return [200, { version: '3.30.2' }];
    if (path === '/settings/plex/token' && method === 'POST') {
      st.token = String(body?.plex_auth_token ?? '');
      return [201, OK];
    }
    if (path === '/settings' && method === 'GET')
      return [200, { ...st.settings, plex_auth_token: st.token ? 'abc...xyz' : null }];
    if (path === '/settings' && method === 'PATCH') {
      if (!st.token) return [200, NOK('Plex settings need a token first')];
      st.settings = { ...st.settings, ...body };
      return [200, OK];
    }
    if (path === '/settings/test/plex/auth') return [200, st.token === 'ptok' ? OK : NOK('token refused')];
    if (path === '/settings/test/plex') return [200, { ...OK, message: '1.42.0' }];
    for (const app of ['radarr', 'sonarr'] as const) {
      if (path === `/settings/${app}` && method === 'GET') return [200, st.arr[app]];
      if (path === `/settings/${app}` && method === 'POST') {
        const row = { id: st.nextId++, tagExclusions: false, exclusionTag: 'dnd', ...body };
        st.arr[app].push(row);
        return [201, { ...OK, data: row }];
      }
      const m = new RegExp(`^/settings/${app}/(\\d+)$`).exec(path);
      if (m && method === 'PUT') {
        const i = st.arr[app].findIndex((s) => s.id === Number(m[1]));
        st.arr[app][i] = { ...st.arr[app][i], ...body };
        return [200, OK];
      }
      if (path === `/settings/test/${app}`) return [201, { ...OK, message: app === 'radarr' ? '6.4.4' : '4.0.20' }];
    }
    if (path === '/settings/seerr' && method === 'GET') return [200, st.seerr];
    if (path === '/settings/seerr' && method === 'POST') {
      st.seerr = { ...body };
      return [201, OK];
    }
    if (path === '/settings/test/seerr') return [201, OK];
    if (path === '/overlays/settings' && method === 'GET') return [200, st.overlays];
    if (path === '/overlays/settings' && method === 'PUT') {
      st.overlays = { ...st.overlays, ...body };
      return [200, st.overlays];
    }
    if (path === '/media-server/libraries') {
      if (!st.token || !st.settings.plex_hostname) return [403, { message: 'Media server setup is not complete' }];
      return [
        200,
        [
          { id: '1', title: 'Movies', type: 'movie' },
          { id: '2', title: 'TV Shows', type: 'show' },
          { id: '5', title: 'Other Videos', type: 'movie' },
        ],
      ];
    }
    if (path === '/notifications/configurations') return [200, st.notes];
    if (path === '/notifications/configuration/add') {
      if (body?.id !== undefined) st.notes = st.notes.map((n) => (n.id === body.id ? { ...body } : n));
      else st.notes.push({ ...body, id: st.nextId++ });
      return [201, OK];
    }
    const del = /^\/notifications\/configuration\/(\d+)$/.exec(path);
    if (del && method === 'DELETE') {
      st.notes = st.notes.filter((n) => n.id !== Number(del[1]));
      return [200, { code: 1, result: 'Success' }];
    }
    if (path === '/rules' && method === 'GET') return [200, st.groups];
    if (path === '/rules' && method === 'POST') {
      if (!Array.isArray(body?.rules)) return [500, {}];
      st.groups.push(groupRow(body as Obj, st.nextId++));
      return [201, { code: 1, result: 'Success' }];
    }
    if (path === '/rules' && method === 'PUT') {
      st.groups = st.groups.map((g) => (g.id === body?.id ? groupRow(body as Obj, Number(body?.id)) : g));
      return [200, { code: 1, result: 'Success' }];
    }
    return [404, { message: `no route ${method} ${path}` }];
  };

  const http = async (url: string, req: HttpRequest): Promise<HttpResponse> => {
    const u = new URL(url);
    const reply = (status: number, text: string): HttpResponse => ({ status, text, headers: new Headers() });
    if (u.port === '32400') return reply(200, '<MediaContainer friendlyName="sapphire" machineIdentifier="f3860770">');
    if (!st.up && !u.pathname.endsWith('/health/ready')) return { ...reply(0, ''), error: 'refused' };
    const path = u.pathname.replace(/^\/maintainerr\/api/, '') + u.search;
    const [status, json] = handle(
      req.method ?? 'GET',
      path,
      req.body ? (JSON.parse(String(req.body)) as Obj) : undefined,
    );
    return reply(status, JSON.stringify(json));
  };
  return { st, http };
}

function harness(envOver: Record<string, string> = {}) {
  const fake = fakeMaintainerr();
  const repo = mkdtempSync(join(tmp, 'repo-'));
  writeFileSync(join(repo, '.env'), '');
  const seerr = join(repo, 'seerr-settings.json');
  writeFileSync(seerr, JSON.stringify({ main: { apiKey: 'skey' } }));
  const lines: string[] = [];
  const errs: string[] = [];
  let t = 0;
  const env = {
    RADARR_API_KEY: 'rk',
    SONARR_API_KEY: 'sk',
    PLEX_TOKEN: 'ptok',
    MAINTAINERR_TELEGRAM_BOT_TOKEN: 'bt',
    MAINTAINERR_TELEGRAM_CHAT_ID: '42',
    SEERR_SETTINGS: seerr,
    APPDATA: repo,
    ...envOver,
  };
  const deps = {
    http: fake.http,
    log: (l: string) => void lines.push(l),
    err: (l: string) => void errs.push(l),
    sleep: async (ms: number) => void (t += ms),
    now: () => t,
    env,
    repo,
  };
  return { ...fake, lines, errs, deps, run: (argv: string[] = []) => main(argv, deps) };
}

describe('main', () => {
  test('a fresh Maintainerr: applied, then no drift', async () => {
    const h = harness();
    expect(await h.run()).toBe(0);
    expect(h.lines.at(-1)).toBe('No drift. Every action is "Do nothing".');
    expect(h.st.groups.map((g) => g.name)).toEqual(GROUPS.map((g) => g.name));
    expect(h.st.groups.every((g) => (g.collection as Obj).arrAction === 4)).toBe(true);
  });
  test('the token is stored before the Plex settings', async () => {
    const h = harness();
    await h.run();
    expect(h.st.writes.indexOf('POST /settings/plex/token')).toBeLessThan(h.st.writes.indexOf('PATCH /settings'));
    expect(h.st.settings.plex_name).toBe('sapphire');
  });
  test('groups get their library, app and the Telegram agent', async () => {
    const h = harness();
    await h.run();
    const note = h.st.notes[0]!;
    const seasons = h.st.groups.find((g) => g.name === 'Leaving Soon - Watched Seasons')!;
    const radarr = h.st.arr.radarr[0]!;
    const sonarr = h.st.arr.sonarr[0]!;
    expect(`${note.name} ${(note.options as Obj).chatId}`).toBe(`${TELEGRAM_NAME} 42`);
    expect(seasons.libraryId).toBe('2');
    expect((seasons.collection as Obj).sonarrSettingsId).toBe(sonarr.id);
    expect((h.st.groups[0]!.collection as Obj).radarrSettingsId).toBe(radarr.id);
    expect((seasons.notifications as Obj[]).map((n) => n.id)).toEqual([note.id]);
  });
  test('Radarr, Sonarr and Seerr by their names on the arr network', async () => {
    const h = harness();
    await h.run();
    expect([h.st.arr.radarr[0]!.url, h.st.arr.sonarr[0]!.url, h.st.seerr.url, h.st.seerr.api_key]).toEqual([
      'http://radarr:7878',
      'http://sonarr:8989',
      'http://seerr:5055',
      'skey',
    ]);
  });
  test('a second run writes only the token', async () => {
    const h = harness();
    await h.run();
    h.st.writes.length = 0;
    expect(await h.run()).toBe(0);
    expect(h.st.writes.filter((w) => !w.startsWith('POST /settings/test/'))).toEqual(['POST /settings/plex/token']);
  });
  test('--check writes nothing and reports drift', async () => {
    const h = harness();
    expect(await h.run(['--check'])).toBe(1);
    expect(h.st.writes.filter((w) => !w.startsWith('POST /settings/test/'))).toEqual([]);
    expect(h.lines).toContain('To apply: task maintainerr:configure');
  });
  test('an action switched on in the WebUI is drift, and apply puts it back', async () => {
    const h = harness();
    await h.run();
    (h.st.groups[0]!.collection as Obj).arrAction = 0;
    expect(await h.run(['--check'])).toBe(1);
    expect(h.lines.some((l) => l.includes("DRIFT    'Leaving Soon - Unwatched Movies': arrAction"))).toBe(true);
    expect(await h.run()).toBe(0);
    expect((h.st.groups[0]!.collection as Obj).arrAction).toBe(4);
  });
  test('no Telegram keys: no agent, and one left over is removed', async () => {
    const h = harness();
    await h.run();
    const h2 = {
      ...h,
      deps: { ...h.deps, env: { ...h.deps.env, MAINTAINERR_TELEGRAM_BOT_TOKEN: '', MAINTAINERR_TELEGRAM_CHAT_ID: '' } },
    };
    expect(await main([], h2.deps)).toBe(0);
    expect(h.st.notes).toEqual([]);
    expect(h.st.groups.every((g) => (g.notifications as unknown[]).length === 0)).toBe(true);
  });
  test('half the Telegram keys → 3, nothing written', async () => {
    const h = harness({ MAINTAINERR_TELEGRAM_CHAT_ID: '' });
    expect(await h.run()).toBe(3);
    expect(h.errs[0]).toContain('or neither');
    expect(h.st.writes).toEqual([]);
  });
  test('no Plex token → 3', async () => {
    const h = harness({ PLEX_TOKEN: '' });
    expect(await h.run()).toBe(3);
    expect(h.errs[0]).toContain('PLEX_TOKEN');
  });
  test('not answering → 3 after the wait', async () => {
    const h = harness();
    h.st.up = false;
    expect(await h.run()).toBe(3);
    expect(h.lines.at(-1)).toContain('not answering');
  });
});
