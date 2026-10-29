// apps/maintainerr/configure.ts — apply Maintainerr's connections, Telegram
// alerts and rules through its API, then read them back. Idempotent.
//
//   apps/maintainerr/configure.sh            apply, then verify
//   apps/maintainerr/configure.sh --check    verify only; changes nothing
//
// Normally run as `task maintainerr:configure` / `task maintainerr:check`.
//
// Maintainerr has no login and no API key: anything that reaches it can change
// it, which is why it is on 127.0.0.1:6246 only and the browser gets it through
// docs' sign-in (CLAUDE.md trap 21). No browser step is needed: the Plex token
// is .env's PLEX_TOKEN, Radarr's and Sonarr's keys are .env's, and Seerr's is
// its own settings.json.
//
// The rule groups below are its collections, shown on the Plex home screen as
// "Leaving soon" shelves with a "Leaving {date}" overlay. Every action is "Do
// nothing" while ACTIONS_ON is false: Maintainerr then skips the collection
// when it handles them, so nothing is deleted, while the shelves, overlays and
// alerts show what would go and when. Switching ACTIONS_ON is the one change
// that makes it delete (through Radarr/Sonarr; arr-reclaim frees the torrent).
//
// Writes send only the fields this repo owns. Two of Maintainerr's quirks shape
// them: a rule group's rules are saved only when useRules is sent, and a PUT
// that omits notifications unlinks them all, so every write is the whole group.
// Most failures are HTTP 200 with {code: 0}, so the body is checked too.
//
// Exit: 0 applied and verified (or no drift; a FAILING test only warns) ·
// 1 drift, or a step failed · 2 usage · 3 not reachable, or a key missing.

import { join, resolve } from 'node:path';
import { headerHelp, parseCli } from '../../stack/lib/cli.ts';
import { envGet, envSeconds, type Env } from '../../stack/lib/env.ts';
import { runMain } from '../../stack/lib/exit.ts';
import { httpCode, is2xx, jsonOf, makeHttp, type Http } from '../../stack/lib/http.ts';
import { readSeerrKey } from '../../stack/lib/keys.ts';
import { err, out, type Log } from '../../stack/lib/log.ts';
import { hostDrift, jsonEqual, type ApiResult, type JsonObject } from '../../stack/lib/servarr.ts';

// ─── the settings ─────────────────────────────────────────────────────────────

/**
 * The one switch between showing and deleting. false: every group's action is
 * "Do nothing" (configure.test.ts pins it). Set it true only after a week of
 * watching the shelves and the alerts (docs/phases.md → Library cleanup).
 */
export const ACTIONS_ON = false;

/** Days a title stays on its shelf before its action runs. */
export const DELETE_AFTER_DAYS = 14;

/** Telegram's "Media About to be Handled" comes this many days before. */
export const NOTIFY_DAYS_BEFORE = 3;

/** Maintainerr's ServarrAction (packages/contracts collections/servarr-action.ts). */
export const ARR_ACTION = {
  DELETE: 0,
  UNMONITOR_DELETE_ALL: 1,
  UNMONITOR_DELETE_EXISTING: 2,
  UNMONITOR: 3,
  DO_NOTHING: 4,
} as const;

/** Its notification types; ours: about to be handled, handled, and both failures. */
export const NOTIFY = {
  MEDIA_ADDED_TO_COLLECTION: 2,
  MEDIA_REMOVED_FROM_COLLECTION: 4,
  MEDIA_ABOUT_TO_BE_HANDLED: 8,
  MEDIA_HANDLED: 16,
  RULE_HANDLING_FAILED: 32,
  COLLECTION_HANDLING_FAILED: 64,
} as const;
export const TELEGRAM_TYPES = [
  NOTIFY.MEDIA_ABOUT_TO_BE_HANDLED,
  NOTIFY.MEDIA_HANDLED,
  NOTIFY.RULE_HANDLING_FAILED,
  NOTIFY.COLLECTION_HANDLING_FAILED,
];
/** The agent this script owns, by name; others made in the WebUI are left alone. */
export const TELEGRAM_NAME = 'Telegram (pms)';

/** Plex on the host network, through the host gateway. */
export const PLEX = { plex_hostname: 'host.docker.internal', plex_port: 32400, plex_ssl: 0 } as const;

/** The apps, by their names on the arr network. */
export const ARR = {
  radarr: { serverName: 'Radarr', url: 'http://radarr:7878' },
  sonarr: { serverName: 'Sonarr', url: 'http://sonarr:8989' },
} as const;
export type Arr = keyof typeof ARR;
export const SEERR_URL = 'http://seerr:5055';

/** Plex libraries by NAME (section ids differ between installs), as Seerr's. */
export const LIBRARY = { movie: 'Movies', show: 'TV Shows' } as const;
type Library = keyof typeof LIBRARY;

// The rule encoding (Maintainerr's rules.constants.ts): a value is
// [application, property]; Plex is application 0.
const PLEX_APP = 0;
const P = { addDate: 0, viewCount: 5, lastViewedAt: 7, sw_lastWatched: 13, sw_episodes: 14, sw_viewedEpisodes: 15 };
/** RulePossibility: BEFORE against a date compares with now minus a number of seconds. */
const OP = { EQUALS: 2, BEFORE: 5 };
const AND = 0;
const NUMBER = 0;
const DAY = 86_400;

export interface Rule {
  operator: number | null;
  action: number;
  firstVal: [number, number];
  lastVal?: [number, number];
  customVal?: { ruleTypeId: number; value: string };
  section: number;
}
const daysAgo = (days: number) => ({ ruleTypeId: NUMBER, value: String(days * DAY) });
const plex = (prop: number): [number, number] => [PLEX_APP, prop];

export interface GroupSpec {
  name: string;
  description: string;
  library: Library;
  dataType: 'movie' | 'season';
  /** What runs once ACTIONS_ON is true. */
  actionOn: number;
  rules: Rule[];
}

/**
 * The shelves. Only the owner watches, so Plex's own counts (the token's
 * account) are the watch history. The two movie groups never overlap: a film
 * never played has no lastViewedAt, which a date rule reads as false.
 */
export const GROUPS: readonly GroupSpec[] = [
  {
    name: 'Leaving Soon - Unwatched Movies',
    description: 'In the library over 120 days and never played.',
    library: 'movie',
    dataType: 'movie',
    actionOn: ARR_ACTION.DELETE,
    rules: [
      { operator: null, action: OP.BEFORE, firstVal: plex(P.addDate), customVal: daysAgo(120), section: 0 },
      {
        operator: AND,
        action: OP.EQUALS,
        firstVal: plex(P.viewCount),
        customVal: { ruleTypeId: NUMBER, value: '0' },
        section: 0,
      },
    ],
  },
  {
    name: 'Leaving Soon - Watched Movies',
    description: 'Last played over 180 days ago.',
    library: 'movie',
    dataType: 'movie',
    actionOn: ARR_ACTION.DELETE,
    rules: [{ operator: null, action: OP.BEFORE, firstVal: plex(P.lastViewedAt), customVal: daysAgo(180), section: 0 }],
  },
  {
    // Deletes the season and unmonitors it; the show stays monitored, so new
    // seasons still come.
    name: 'Leaving Soon - Watched Seasons',
    description: 'Every episode watched, the last one over 60 days ago.',
    library: 'show',
    dataType: 'season',
    actionOn: ARR_ACTION.DELETE,
    rules: [
      {
        operator: null,
        action: OP.EQUALS,
        firstVal: plex(P.sw_viewedEpisodes),
        lastVal: plex(P.sw_episodes),
        section: 0,
      },
      { operator: AND, action: OP.BEFORE, firstVal: plex(P.sw_lastWatched), customVal: daysAgo(60), section: 0 },
    ],
  },
];

/**
 * Titles never put on a shelf: global exclusions, found in Plex by title and
 * year. Taking one out of this list does not lift its exclusion (Maintainerr
 * cannot list them all); do that in its WebUI (README.md).
 */
export const KEEP: readonly { title: string; year: number; library: Library }[] = [];

// ─── what is written (pure; apps/maintainerr/configure.test.ts) ─────────────

export interface GroupIds {
  libraryId: string;
  arrId: number;
  notificationIds: number[];
}

export const groupAction = (spec: GroupSpec, on = ACTIONS_ON): number => (on ? spec.actionOn : ARR_ACTION.DO_NOTHING);

/** The whole rule group, as POST/PUT /api/rules take it. */
export function wantGroup(spec: GroupSpec, ids: GroupIds, on = ACTIONS_ON): JsonObject {
  const arrKey = spec.library === 'movie' ? 'radarrSettingsId' : 'sonarrSettingsId';
  return {
    name: spec.name,
    description: spec.description,
    libraryId: ids.libraryId,
    dataType: spec.dataType,
    isActive: true,
    useRules: true,
    arrAction: groupAction(spec, on),
    [arrKey]: ids.arrId,
    // Clears the Seerr request once the title is gone, so it can be asked for again.
    forceSeerr: true,
    // No import-list exclusion in Radarr: a deleted film stays requestable.
    listExclusions: false,
    notifications: ids.notificationIds.map((id) => ({ id })),
    collection: {
      visibleOnHome: true,
      visibleOnRecommended: false,
      deleteAfterDays: DELETE_AFTER_DAYS,
      manualCollection: false,
      keepLogsForMonths: 6,
      overlayEnabled: true,
      // The default poster template: "Classic Pill", "Leaving {date}".
      overlayTemplateId: null,
    },
    rules: spec.rules as unknown as JsonObject[],
  };
}

/** A rule as compared: only the keys a Rule has, in a fixed order. */
export function normRule(r: unknown): Rule {
  const o = (r ?? {}) as Record<string, unknown>;
  const n: Rule = {
    operator: o.operator === null || o.operator === undefined ? null : Number(o.operator),
    action: Number(o.action),
    firstVal: o.firstVal as [number, number],
    section: Number(o.section),
  };
  if (o.lastVal !== undefined && o.lastVal !== null) n.lastVal = o.lastVal as [number, number];
  const c = o.customVal as { ruleTypeId?: unknown; value?: unknown } | undefined | null;
  if (c) n.customVal = { ruleTypeId: Number(c.ruleTypeId), value: String(c.value) };
  return n;
}

/** The rules of a GET /api/rules group: rows whose ruleJson is the rule as sent. */
export function rulesOf(group: Record<string, unknown>): Rule[] {
  const rows = Array.isArray(group.rules) ? (group.rules as { ruleJson?: unknown; id?: unknown }[]) : [];
  return [...rows]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((row) => normRule(typeof row.ruleJson === 'string' ? jsonOf({ text: row.ruleJson }) : row));
}

/** The keys of the wanted group that differ in a GET /api/rules group. */
export function groupDrift(got: Record<string, unknown>, want: JsonObject): string[] {
  const c = (got.collection ?? {}) as Record<string, unknown>;
  const wc = want.collection as JsonObject;
  const drift: string[] = [];
  for (const k of ['description', 'libraryId', 'dataType', 'isActive', 'useRules'])
    if (!jsonEqual(got[k], want[k])) drift.push(k);
  // The collection holds the action and the app; the group holds the rest.
  for (const k of ['arrAction', 'forceSeerr', 'listExclusions', 'radarrSettingsId', 'sonarrSettingsId'])
    if (k in want && !jsonEqual(c[k], want[k])) drift.push(k);
  for (const k of Object.keys(wc)) if (!jsonEqual(c[k] ?? null, wc[k])) drift.push(`collection.${k}`);
  const ids = (v: unknown) =>
    (Array.isArray(v) ? (v as { id?: unknown }[]) : []).map((n) => Number(n.id)).sort((a, b) => a - b);
  if (!jsonEqual(ids(got.notifications), ids(want.notifications))) drift.push('notifications');
  if (!jsonEqual(rulesOf(got), (want.rules as unknown[]).map(normRule))) drift.push('rules');
  return drift;
}

export interface Telegram {
  botAuthToken: string;
  chatId: string;
}

/** The agent, as POST /api/notifications/configuration/add takes it (plus id to update). */
export const wantNotification = (t: Telegram): JsonObject => ({
  name: TELEGRAM_NAME,
  agent: 'telegram',
  enabled: true,
  types: [...TELEGRAM_TYPES].sort((a, b) => a - b),
  aboutScale: NOTIFY_DAYS_BEFORE,
  options: { botAuthToken: t.botAuthToken, chatId: t.chatId },
});

export function notificationDrift(got: Record<string, unknown>, want: JsonObject): string[] {
  const drift: string[] = [];
  for (const k of ['agent', 'enabled', 'aboutScale']) if (!jsonEqual(got[k], want[k])) drift.push(k);
  const types = (Array.isArray(got.types) ? (got.types as number[]) : []).map(Number).sort((a, b) => a - b);
  if (!jsonEqual(types, want.types)) drift.push('types');
  const o = (got.options ?? {}) as Record<string, unknown>;
  const wo = want.options as JsonObject;
  for (const k of Object.keys(wo)) if (String(o[k] ?? '') !== wo[k]) drift.push(`options.${k}`);
  return drift;
}

/** The main settings it owns, besides the token (sent on its own, first). */
export const wantSettings = (plexName: string): JsonObject => ({
  media_server_type: 'plex',
  plex_name: plexName,
  ...PLEX,
  plex_manual_mode: 1,
});

/** {code: 0} is Maintainerr's failure, whatever the HTTP status. */
export function refused(r: ApiResult): boolean {
  if (!r.ok) return true;
  const b = r.json as { code?: unknown } | null | undefined;
  return b !== null && typeof b === 'object' && !Array.isArray(b) && b.code === 0;
}

/** The message of a failed call, for the log. */
export function maintainerrError(r: ApiResult): string {
  const b = r.json as { message?: unknown } | null | undefined;
  const msg = b !== null && typeof b === 'object' && !Array.isArray(b) ? b.message : undefined;
  return (Array.isArray(msg) ? msg.join('; ') : typeof msg === 'string' ? msg : r.text).slice(0, 160);
}

/** Plex's friendlyName from its / XML; "" when none. */
export const friendlyNameOf = (xml: string): string => /friendlyName="([^"]*)"/.exec(xml)?.[1] ?? '';

/** The ratingKey of the first match in a Plex library search (JSON); "" when none. */
export function ratingKeyOf(json: unknown): string {
  const m = (json as { MediaContainer?: { Metadata?: { ratingKey?: unknown }[] } } | null)?.MediaContainer?.Metadata;
  const k = Array.isArray(m) ? m[0]?.ratingKey : undefined;
  return k === undefined ? '' : String(k);
}

// ─── main ─────────────────────────────────────────────────────────────────────

export interface Deps {
  http: Http;
  log: Log;
  /** Where the missing-key errors go. */
  err: Log;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  env: Env;
  /** The tree whose .env holds the keys and APPDATA: the install, or a source. */
  repo: string;
}

export type Api = (method: string, path: string, body?: unknown) => Promise<ApiResult>;
type Obj = Record<string, unknown>;

const listOf = (r: ApiResult): Obj[] => (Array.isArray(r.json) ? (r.json as Obj[]) : []);

export async function main(argv: readonly string[], deps: Deps): Promise<number> {
  const { env, log, repo } = deps;
  const cli = parseCli(argv, { flags: ['--check'], usage: 'usage: configure.sh [--check]' });
  if (cli.help) {
    log(headerHelp(await Bun.file(import.meta.path).text()));
    return 0;
  }
  const mode = cli.flags['--check'] ? 'check' : 'apply';

  const appdata = envGet('APPDATA', { repo, env }) || '/opt/appdata';
  // Under its BASE_PATH, on the loopback port (apps/maintainerr/compose.yaml).
  const url = env.MAINTAINERR_URL || 'http://127.0.0.1:6246/maintainerr';
  const plexUrl = env.PLEX_URL || 'http://127.0.0.1:32400'; // from this host: its name, and KEEP's lookups
  const timeoutMs = envSeconds(env, 'MAINTAINERR_TIMEOUT', 60);
  const waitMs = envSeconds(env, 'MAINTAINERR_WAIT', 90);
  const keys: Record<Arr, string> = {
    radarr: envGet('RADARR_API_KEY', { repo, env }),
    sonarr: envGet('SONARR_API_KEY', { repo, env }),
  };
  const plexToken = envGet('PLEX_TOKEN', { repo, env });
  const telegram: Telegram = {
    botAuthToken: envGet('MAINTAINERR_TELEGRAM_BOT_TOKEN', { repo, env }),
    chatId: envGet('MAINTAINERR_TELEGRAM_CHAT_ID', { repo, env }),
  };
  const withTelegram = telegram.botAuthToken !== '' && telegram.chatId !== '';

  const missing = [
    ...(keys.radarr ? [] : ['RADARR_API_KEY']),
    ...(keys.sonarr ? [] : ['SONARR_API_KEY']),
    ...(plexToken ? [] : ['PLEX_TOKEN']),
  ];
  if (missing.length > 0) {
    deps.err(`Set ${missing.join(' ')} in ${repo}/.env.`);
    return 3;
  }
  if (!withTelegram && (telegram.botAuthToken || telegram.chatId)) {
    deps.err(`Set both MAINTAINERR_TELEGRAM_BOT_TOKEN and MAINTAINERR_TELEGRAM_CHAT_ID in ${repo}/.env, or neither.`);
    return 3;
  }
  const seerrSettings = env.SEERR_SETTINGS || join(appdata, 'seerr/settings.json');
  const seerrKey = readSeerrKey(seerrSettings);
  if (!seerrKey) {
    deps.err(`No API key in ${seerrSettings} — has Seerr started once?`);
    return 3;
  }
  const wantSeerr = { url: SEERR_URL, api_key: seerrKey };
  const wantArr = (app: Arr) => ({ ...ARR[app], apiKey: keys[app] });

  const api: Api = async (method, path, body) => {
    const sends = body !== undefined;
    const r = await deps.http(`${url}/api${path}`, {
      method,
      headers: sends ? { 'Content-Type': 'application/json' } : {},
      body: sends ? JSON.stringify(body) : undefined,
      timeoutMs,
    });
    return { ok: is2xx(r.status), status: r.status, text: r.text, json: jsonOf(r) };
  };
  const get = (path: string) => api('GET', path);
  const fail = (what: string, r: ApiResult) =>
    log(`  FAIL  ${what} (HTTP ${httpCode(r.status)})${maintainerrError(r) ? `: ${maintainerrError(r)}` : ''}`);
  const plexGet = (path: string) =>
    deps.http(`${plexUrl}${path}`, {
      headers: { 'X-Plex-Token': plexToken, Accept: path === '/' ? 'application/xml' : 'application/json' },
      timeoutMs: 10_000,
    });

  /** Our server for an app (by name), or undefined. */
  const arrServer = async (app: Arr): Promise<Obj | undefined> => {
    const r = await get(`/settings/${app}`);
    return listOf(r).find((s) => s.serverName === ARR[app].serverName);
  };
  /** Library ids by our names, from Maintainerr's own list (Plex section keys). */
  const libraryIds = async (): Promise<Partial<Record<Library, string>> | undefined> => {
    const r = await get('/media-server/libraries');
    if (refused(r)) return (fail('list the Plex libraries', r), undefined);
    const ids: Partial<Record<Library, string>> = {};
    for (const lib of Object.keys(LIBRARY) as Library[]) {
      const hit = listOf(r).find((l) => l.title === LIBRARY[lib] && l.type === lib);
      if (hit) ids[lib] = String(hit.id);
    }
    return ids;
  };
  const ourNotification = async (): Promise<Obj | undefined> =>
    listOf(await get('/notifications/configurations')).find((n) => n.name === TELEGRAM_NAME);
  const groups = async (): Promise<Obj[]> => listOf(await get('/rules'));

  /** What every group needs besides its spec; undefined (logged) when something is missing. */
  const groupIds = async (): Promise<((spec: GroupSpec) => GroupIds) | undefined> => {
    const libs = await libraryIds();
    if (libs === undefined) return undefined;
    const arrIds: Partial<Record<Arr, number>> = {};
    for (const app of Object.keys(ARR) as Arr[]) {
      const s = await arrServer(app);
      if (s) arrIds[app] = Number(s.id);
    }
    const note = withTelegram ? await ourNotification() : undefined;
    for (const lib of Object.keys(LIBRARY) as Library[])
      if (libs[lib] === undefined) return (log(`  FAIL  no Plex library '${LIBRARY[lib]}'`), undefined);
    for (const app of Object.keys(ARR) as Arr[])
      if (arrIds[app] === undefined) return (log(`  FAIL  no ${ARR[app].serverName} server in Maintainerr`), undefined);
    return (spec) => ({
      libraryId: libs[spec.library] as string,
      arrId: arrIds[spec.library === 'movie' ? 'radarr' : 'sonarr'] as number,
      notificationIds: note ? [Number(note.id)] : [],
    });
  };

  // ─── apply ──────────────────────────────────────────────────────────────────
  // Plex: the token on its own and first (Maintainerr refuses Plex settings
  // with none stored). It is sent every run: GET only shows it masked, so a
  // changed PLEX_TOKEN could not be told apart from the stored one.
  const applyPlex = async (): Promise<boolean> => {
    const t = await api('POST', '/settings/plex/token', { plex_auth_token: plexToken });
    if (refused(t)) return (fail('Plex token', t), false);
    const name = friendlyNameOf((await plexGet('/')).text) || 'Plex';
    const want = wantSettings(name);
    const r = await get('/settings');
    if (refused(r)) return (fail('read settings', r), false);
    const drift = hostDrift((r.json ?? {}) as Obj, want);
    if (drift.length === 0) return (log(`  Plex already set: ${name}`), true);
    // PATCH, not the media-server switch, which clears every collection.
    const w = await api('PATCH', '/settings', want);
    if (refused(w)) return (fail('Plex settings', w), false);
    log(`  Plex set: ${name} at ${PLEX.plex_hostname}:${PLEX.plex_port} (${drift.join(' ')})`);
    return true;
  };

  const applyArr = async (app: Arr): Promise<boolean> => {
    const want = wantArr(app);
    const cur = await arrServer(app);
    if (cur && hostDrift(cur, want).length === 0) return (log(`  ${app} already set`), true);
    const w = cur
      ? await api('PUT', `/settings/${app}/${String(cur.id)}`, want)
      : await api('POST', `/settings/${app}`, want);
    if (refused(w)) return (fail(`${cur ? 'update' : 'add'} ${app}`, w), false);
    log(`  ${app} ${cur ? `updated (${hostDrift(cur, want).join(' ')})` : 'added'}`);
    return true;
  };

  const applySeerr = async (): Promise<boolean> => {
    const r = await get('/settings/seerr');
    if (!refused(r) && hostDrift((r.json ?? {}) as Obj, wantSeerr).length === 0)
      return (log('  Seerr already set'), true);
    const w = await api('POST', '/settings/seerr', wantSeerr);
    if (refused(w)) return (fail('Seerr', w), false);
    log('  Seerr set');
    return true;
  };

  // Overlays are off by default; each group then asks for its own.
  const applyOverlays = async (): Promise<boolean> => {
    const r = await get('/overlays/settings');
    if (!refused(r) && (r.json as Obj | null)?.enabled === true) return (log('  overlays already on'), true);
    const w = await api('PUT', '/overlays/settings', { enabled: true });
    if (refused(w)) return (fail('overlays', w), false);
    log('  overlays on');
    return true;
  };

  const applyTelegram = async (): Promise<boolean> => {
    const cur = await ourNotification();
    if (!withTelegram) {
      if (!cur) return (log('  Telegram: no keys in .env, no alerts'), true);
      const d = await api('DELETE', `/notifications/configuration/${String(cur.id)}`);
      if (refused(d)) return (fail('remove the Telegram agent', d), false);
      log('  Telegram agent removed (no keys in .env)');
      return true;
    }
    const want = wantNotification(telegram);
    if (cur && notificationDrift(cur, want).length === 0) return (log('  Telegram already set'), true);
    // With an id it updates that row; without, it adds one.
    const w = await api('POST', '/notifications/configuration/add', cur ? { id: cur.id, ...want } : want);
    if (refused(w)) return (fail('Telegram agent', w), false);
    log(`  Telegram ${cur ? `updated (${notificationDrift(cur, want).join(' ')})` : 'added'}`);
    return true;
  };

  const applyGroups = async (): Promise<boolean> => {
    const idsOf = await groupIds();
    if (idsOf === undefined) return false;
    const have = await groups();
    for (const spec of GROUPS) {
      const want = wantGroup(spec, idsOf(spec));
      const cur = have.find((g) => g.name === spec.name);
      if (cur && groupDrift(cur, want).length === 0) {
        log(`  '${spec.name}' already set`);
        continue;
      }
      const w = cur ? await api('PUT', '/rules', { id: cur.id, ...want }) : await api('POST', '/rules', want);
      if (refused(w)) return (fail(`rule group '${spec.name}'`, w), false);
      log(`  '${spec.name}' ${cur ? `updated (${groupDrift(cur, want).join(' ')})` : 'added'}`);
    }
    return true;
  };

  /** KEEP's titles: the Plex ratingKey of each, and whether it is excluded everywhere. */
  const keepState = async (): Promise<{ label: string; key: string; excluded: boolean }[] | undefined> => {
    if (KEEP.length === 0) return [];
    const libs = await libraryIds();
    if (libs === undefined) return undefined;
    const state = [];
    for (const k of KEEP) {
      const label = `${k.title} (${k.year})`;
      const q = new URLSearchParams({ title: k.title, year: String(k.year) });
      const res = await plexGet(`/library/sections/${libs[k.library] ?? ''}/all?${q.toString()}`);
      const key = ratingKeyOf(jsonOf(res));
      if (!key) {
        log(`  WARN  keep: '${label}' not found in Plex ${LIBRARY[k.library]}`);
        continue;
      }
      const ex = listOf(await get(`/rules/exclusion?mediaServerId=${encodeURIComponent(key)}`));
      state.push({ label, key, excluded: ex.some((e) => e.ruleGroupId === null || e.ruleGroupId === undefined) });
    }
    return state;
  };
  const applyKeep = async (): Promise<boolean> => {
    const state = await keepState();
    if (state === undefined) return false;
    for (const s of state.filter((x) => !x.excluded)) {
      const w = await api('POST', '/rules/exclusion', { mediaId: s.key, action: 0 });
      if (refused(w)) return (fail(`keep '${s.label}'`, w), false);
      log(`  keep: '${s.label}' excluded`);
    }
    if (state.length > 0 && state.every((s) => s.excluded)) log(`  keep: ${state.length} title(s) already excluded`);
    return true;
  };

  // ─── verify ─────────────────────────────────────────────────────────────────
  const verify = async (): Promise<boolean> => {
    let ok = true;
    const drift = (what: string) => {
      log(`  DRIFT    ${what}`);
      ok = false;
    };

    const auth = await get('/settings/test/plex/auth');
    if (refused(auth)) drift(`Plex token refused: ${maintainerrError(auth)}`);
    const name = friendlyNameOf((await plexGet('/')).text) || 'Plex';
    const s = await get('/settings');
    if (refused(s)) return (log('  FAIL  read settings'), false);
    const sd = hostDrift((s.json ?? {}) as Obj, wantSettings(name));
    if (sd.length > 0) drift(`Plex settings: ${sd.join(' ')}`);
    else {
      const t = await get('/settings/test/plex');
      if (refused(t)) log(`  FAILING  Plex — test fails: ${maintainerrError(t)}`);
      else log(`  ok       Plex ${name} (${String((t.json as Obj | null)?.message ?? '')})`);
    }

    for (const app of Object.keys(ARR) as Arr[]) {
      const want = wantArr(app);
      const cur = await arrServer(app);
      if (!cur) {
        drift(`${app} server missing`);
        continue;
      }
      const d = hostDrift(cur, want);
      if (d.length > 0) {
        drift(`${app}: ${d.join(' ')}`);
        continue;
      }
      const t = await api('POST', `/settings/test/${app}`, want);
      if (refused(t)) log(`  FAILING  ${app} — test fails: ${maintainerrError(t)}`);
      else log(`  ok       ${app} at ${want.url} (${String((t.json as Obj | null)?.message ?? '')})`);
    }

    const sr = await get('/settings/seerr');
    const sdrift = refused(sr) ? ['unreadable'] : hostDrift((sr.json ?? {}) as Obj, wantSeerr);
    if (sdrift.length > 0) drift(`Seerr: ${sdrift.join(' ')}`);
    else {
      const t = await api('POST', '/settings/test/seerr', wantSeerr);
      if (refused(t)) log(`  FAILING  Seerr — test fails: ${maintainerrError(t)}`);
      else log(`  ok       Seerr at ${SEERR_URL}`);
    }

    const ov = await get('/overlays/settings');
    if ((ov.json as Obj | null)?.enabled === true) log('  ok       overlays on');
    else drift('overlays off');

    const note = await ourNotification();
    if (!withTelegram) {
      if (note) drift(`'${TELEGRAM_NAME}' agent exists, but .env has no Telegram keys`);
      else log('  ok       no Telegram alerts (no keys in .env)');
    } else if (!note) drift(`'${TELEGRAM_NAME}' agent missing`);
    else {
      const d = notificationDrift(note, wantNotification(telegram));
      if (d.length > 0) drift(`Telegram: ${d.join(' ')}`);
      else log(`  ok       Telegram, ${NOTIFY_DAYS_BEFORE} days before removal`);
    }

    const idsOf = await groupIds();
    if (idsOf === undefined) return false;
    const have = await groups();
    for (const spec of GROUPS) {
      const cur = have.find((g) => g.name === spec.name);
      if (!cur) {
        drift(`'${spec.name}' missing`);
        continue;
      }
      const d = groupDrift(cur, wantGroup(spec, idsOf(spec)));
      if (d.length > 0) drift(`'${spec.name}': ${d.join(' ')}`);
      else
        log(
          `  ok       '${spec.name}' — ${groupAction(spec) === ARR_ACTION.DO_NOTHING ? 'do nothing' : `action ${groupAction(spec)}`}, after ${DELETE_AFTER_DAYS} days`,
        );
    }
    const others = have.filter((g) => !GROUPS.some((s) => s.name === g.name)).map((g) => `'${String(g.name)}'`);
    if (others.length > 0) log(`  info     not ours, left alone: ${others.join(' ')}`);

    const keep = await keepState();
    if (keep === undefined) return false;
    for (const k of keep.filter((x) => !x.excluded)) drift(`keep: '${k.label}' is not excluded`);
    if (keep.length > 0 && keep.every((k) => k.excluded)) log(`  ok       keep: ${keep.length} title(s) excluded`);
    return ok;
  };

  // ─── run ────────────────────────────────────────────────────────────────────
  log(`Maintainerr at ${url} (${mode})`);
  const deadline = deps.now() + waitMs;
  let health = await deps.http(`${url}/api/health/ready`, { timeoutMs: 5000 });
  while (!is2xx(health.status)) {
    if (deps.now() >= deadline) {
      log(`  FAIL  not answering at ${url} — is it running? (task maintainerr:ps)`);
      return 3;
    }
    await deps.sleep(3000);
    health = await deps.http(`${url}/api/health/ready`, { timeoutMs: 5000 });
  }
  const ver = await get('/app/status');
  log(`  up: ${String((ver.json as Obj | null)?.version ?? 'version unknown')}`);

  if (mode === 'apply') {
    const applied =
      (await applyPlex()) &&
      (await applyArr('radarr')) &&
      (await applyArr('sonarr')) &&
      (await applySeerr()) &&
      (await applyOverlays()) &&
      (await applyTelegram()) &&
      (await applyGroups()) &&
      (await applyKeep());
    if (!applied) return 1;
  }
  log('Read-back:');
  if (await verify()) {
    log(ACTIONS_ON ? 'No drift. Actions are ON: due titles are deleted.' : 'No drift. Every action is "Do nothing".');
    return 0;
  }
  if (mode === 'check') log('To apply: task maintainerr:configure');
  return 1;
}

if (import.meta.main) {
  await runMain(() =>
    main(Bun.argv.slice(2), {
      http: makeHttp(),
      log: out,
      err,
      sleep: (ms) => Bun.sleep(ms),
      now: () => Date.now(),
      env: process.env,
      repo: resolve(import.meta.dir, '../..'),
    }),
  );
}
