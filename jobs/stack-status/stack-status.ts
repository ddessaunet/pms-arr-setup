// jobs/stack-status/stack-status.ts — gather the stack's status and recent logs
// for the docs site's front and logs pages, as JSON files nginx serves at /live/.
//
//   jobs/stack-status/stack-status.sh            fast run: status.json and logs.json
//   jobs/stack-status/stack-status.sh --drift    settings drift: drift.json (slow)
//   jobs/stack-status/stack-status.sh --stdout   print the documents; writes nothing
//   jobs/stack-status/stack-status.sh --audit    redaction counts only; writes nothing
//
// Normally run by stack-status.timer (every 2 min) and stack-status-drift.timer
// (hourly) beside it, or as `task stack-status:run` / `:dry` / `:drift` / `:audit`.
//
// The files are readable by anyone on the LAN (no login, like the apps
// themselves), so every string goes through redact() and then a leak guard
// before anything is written. Secrets from .env (by key name; a key nobody
// classified counts as secret), Seerr's and Bazarr's API keys and Plex's token
// are masked literally, and token/key/password shapes by pattern. If a secret is
// still in a document, nothing is published.
//
// Exit: 0 written (a degraded stack is still 0: a failure means the checker
// broke), or skipped because another run holds the lock · 1 cannot write, or the
// leak guard refused · 2 usage · 3 preflight (no docker or .env).

import { accessSync, chmodSync, constants, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { headerHelp } from '../../stack/lib/cli.ts';
import { envFileValue, type Env } from '../../stack/lib/env.ts';
import { runMain, UsageError } from '../../stack/lib/exit.ts';
import { makeHttp, type Http } from '../../stack/lib/http.ts';
import { readBazarrKey, readSeerrKey } from '../../stack/lib/keys.ts';
import { tryLock } from '../../stack/lib/lock.ts';
import { out, strftime, type Log } from '../../stack/lib/log.ts';
import { PLEX_IDENTITY, plexPrefsPath, readPlexToken } from '../../stack/lib/plex.ts';
import { qbtLogin } from '../../stack/lib/qbittorrent.ts';
import { leaks, redact, REDACTED } from '../../stack/lib/redact.ts';
import { run, type Run } from '../../stack/lib/run.ts';

// ─── what is checked (stack-status.test.ts pins these against the repo) ──────
/** Every apps/<app>, in that order. recyclarr runs on demand: no container to check. */
export const STATUS_APPS = [
  'bazarr',
  'decluttarr',
  'docs',
  'flaresolverr',
  'plex',
  'prowlarr',
  'qbittorrent',
  'radarr',
  'recyclarr',
  'seerr',
  'sonarr',
] as const;
export const ON_DEMAND_APPS: readonly string[] = ['recyclarr'];
/** Host ports the probes use: the published ones in apps/<app>/compose.yaml (plex runs on the host network). */
export const APP_PORT: Readonly<Record<string, number>> = {
  bazarr: 6767,
  docs: 8088,
  plex: 32400,
  prowlarr: 9696,
  qbittorrent: 8081,
  radarr: 7878,
  seerr: 5055,
  sonarr: 8989,
};
/** On the arr network only, reached at the container's IP. */
export const FLARESOLVERR_PORT = 8191;
/** The jobs whose journal is shown, and the timers whose state is. */
export const LOG_UNITS = [
  'lan-address',
  'arr-reclaim',
  'pms-update',
  'arr-fallback-search',
  'stack-status',
  'stack-status-drift',
];
export const TIMERS = ['pms-update', 'arr-fallback-search', 'lan-address', 'stack-status', 'stack-status-drift'];
/** The apps with a configure.sh, as Taskfile.yml's CONFIGURED. */
export const DRIFT_APPS = ['qbittorrent', 'prowlarr', 'radarr', 'sonarr', 'seerr', 'bazarr', 'plex'];
/** The apps whose settings name the box's LAN addresses (jobs/lan-address). */
const LAN_APPS = ['qbittorrent', 'prowlarr', 'radarr', 'sonarr', 'seerr'];
/**
 * .env keys that are never secret. User names are listed here on purpose: the
 * box's user is one of them, and masking it would blank every /home path. Any
 * other key is masked: by name when it matches SECRET_KEY_RE, and, fail-safe,
 * when nobody classified it (8+ characters). The test fails on an
 * .env.example key in neither group.
 */
export const PUBLIC_ENV_KEYS = [
  'PUID',
  'PGID',
  'TZ',
  'APPDATA',
  'UPDATE_SERVICES',
  'UPDATE_HEALTH_WAIT',
  'DECLUTTARR_TEST_RUN',
  'QBT_ARR_USER',
  'PROWLARR_USER',
  'ARR_USER',
  'OPENSUBTITLES_USER',
  'AI_MODELS',
  'AI_MODEL',
  'OLLAMA_URL',
  'AI_MAX_PER_HOUR',
];
export const SECRET_KEY_RE = /_(KEY|PASS|PASSWORD|TOKEN|SECRET|CLAIM)$/;

export const DISK_WARN = 95; // % used; /mnt/data runs at ~90%
export const STALE_AFTER = 360; // s: the page marks everything stale past this (3 missed runs)
export const DRIFT_STALE = 10800; // s: an hourly drift result older than this is itself a problem
export const RESTART_WINDOW = 900; // s: a Docker restart this recent marks the app degraded
export const QBT_BACKOFF = 3600; // s: after a refused login, so qBittorrent's IP ban never trips
const LOG_SCAN = 300; // lines read per source
export const LOG_KEEP = 50; // lines kept per view
export const LINE_MAX = 500; // characters per line
const T_CMD = 10_000; // ms per docker/systemctl/journalctl call
const T_CONFIGURE = 600_000; // ms per configure.sh --check in the drift run
const T_DEPLOY = 120_000;

// ─── jq's habits ──────────────────────────────────────────────────────────────
// The documents keep the shapes and strings the bash/jq version wrote:
// testdata/status.golden.json is the contract with the page.

type Obj = Record<string, unknown>;

/** jq's `a // b`: b when a is null, missing or false. */
const alt = <T>(a: unknown, b: T): unknown | T => (a === undefined || a === null || a === false ? b : a);
/** jq's string interpolation of a value. */
const str = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v ?? null));
/** jq's truthiness. */
const truthy = (v: unknown): boolean => v !== undefined && v !== null && v !== false;
/** jq's `.key` on anything: null unless it is an object that has it. */
const at = (v: unknown, k: string): unknown =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? ((v as Obj)[k] ?? null) : null;
/** jq's tonumber on a string; undefined where jq would fail. */
const toNum = (v: unknown): number | undefined => {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string' || !/^\s*-?\d+(\.\d+)?([eE][+-]?\d+)?\s*$/.test(v)) return undefined;
  return Number(v);
};
/** `fromjson` that gives null instead of an error. */
const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
/** jq's .[0:n] on a string: code points, not UTF-16 units. */
const cut = (s: string, n: number): string => {
  const cps = [...s];
  return cps.length <= n ? s : cps.slice(0, n).join('');
};
const cpLength = (s: string): number => [...s].length;

/** jq's @uri: everything but A-Z a-z 0-9 - _ . ~ is %-encoded. */
export const uri = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** strflocaltime: the page's times are the box's local ones. */
const local = (fmt: string, epoch: number) => strftime(fmt, new Date(epoch * 1000));
const at_ = (epoch: number) => local('%a %H:%M', epoch);

export function ago(then: number, now: number): string {
  const s = now - then;
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.floor(s / 60)} min`;
  if (s < 172800) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

/** An ISO-8601 UTC time (Docker's StartedAt) as epoch seconds; null when it is not one. */
export function epochOf(iso: unknown): number | null {
  if (typeof iso !== 'string' || iso === '') return null;
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)Z$/.exec(iso.replace(/\.[0-9]+/, ''));
  if (!m) return null;
  const d = new Date(0);
  d.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setUTCHours(Number(m[4]), Number(m[5]), Number(m[6]));
  return Math.floor(d.getTime() / 1000);
}

const RANK: Readonly<Record<string, number>> = { ok: 0, 'n/a': 0, unknown: 1, degraded: 2, down: 3 };
const rank = (level: string) => RANK[level] ?? 1;
/** The worst level, n/a left out; ok when nothing is left. */
export function worst(levels: readonly string[]): string {
  let w: string | undefined;
  for (const l of levels.filter((x) => x !== 'n/a')) if (w === undefined || rank(l) >= rank(w)) w = l;
  return w ?? 'ok';
}
const levelOf = (reasons: readonly Reason[]) =>
  reasons.some((r) => r.level === 'down') ? 'down' : reasons.some((r) => r.level === 'degraded') ? 'degraded' : 'ok';

// ─── secrets ─────────────────────────────────────────────────────────────────

/** The keys of .env text, in order (a repeated key repeats). */
export const envKeys = (text: string): string[] =>
  text.split('\n').flatMap((l) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(l)?.[1] ?? []);

/** A key's value: the last line, one pair of surrounding quotes dropped. */
export function envValue(text: string, key: string): string {
  const v = envFileValue(text, key);
  const m = /^"(.*)"$/.exec(v) ?? /^'(.*)'$/.exec(v);
  return m ? (m[1] ?? '') : v;
}

export const isPublicKey = (k: string) => PUBLIC_ENV_KEYS.includes(k);
export const isNamedSecret = (k: string) => SECRET_KEY_RE.test(k);

/** Keys neither named secret nor listed public: masked anyway, and reported. */
export const unclassifiedKeys = (text: string): string[] =>
  envKeys(text).filter((k) => !isNamedSecret(k) && !isPublicKey(k));

/** The literal values to mask: named secrets of 4+ characters, unclassified values of 8+ (fail-safe, but "true" or "1000" stay readable). */
export function envSecretValues(text: string): string[] {
  return envKeys(text).flatMap((k) => {
    const v = envValue(text, k);
    if (isNamedSecret(k)) return cpLength(v) >= 4 ? [v] : [];
    if (!isPublicKey(k)) return cpLength(v) >= 8 ? [v] : [];
    return [];
  });
}

/** The values to mask: each with its URL-encoded form, unique, longest first. */
export function secretsList(values: readonly string[]): string[] {
  const kept = values.filter((v) => cpLength(v) >= 4);
  const unique = [...new Set([...kept, ...kept.map(uri)])].sort();
  return unique.sort((a, b) => cpLength(b) - cpLength(a));
}

// Redaction lives in stack/lib/redact.ts (stack-api shares it); and the Plex
// identity in stack/lib/plex.ts. Both re-exported for this job's tests.
export { leaks, mask, redact, REDACTED } from '../../stack/lib/redact.ts';
export { PLEX_IDENTITY } from '../../stack/lib/plex.ts';

// ─── containers ──────────────────────────────────────────────────────────────

export interface Container {
  state: unknown;
  running: unknown;
  restarting: unknown;
  restartCount: unknown;
  startedAt: unknown;
  health: unknown;
  exitCode: unknown;
  ips: unknown[];
}

/** `docker inspect` JSON → {name: …}; {} when it is not a list. */
export function containersJson(text: string): Record<string, Container> {
  const list = parse(text || '[]');
  if (!Array.isArray(list)) return {};
  const outp: Record<string, Container> = {};
  for (const c of list as Obj[]) {
    const state = (c?.State ?? {}) as Obj;
    const networks = ((c?.NetworkSettings as Obj | undefined)?.Networks ?? {}) as Record<string, Obj | null>;
    outp[String(c?.Name ?? '').replace(/^\//, '')] = {
      state: state.Status ?? null,
      running: state.Running ?? null,
      restarting: state.Restarting ?? null,
      restartCount: c?.RestartCount ?? null,
      startedAt: state.StartedAt ?? null,
      health: alt((state.Health as Obj | undefined)?.Status, null),
      exitCode: state.ExitCode ?? null,
      ips: Object.values(networks)
        .map((n) => n?.IPAddress ?? null)
        .filter((ip) => ip !== ''),
    };
  }
  return outp;
}

// ─── app probes: each gives {http, ms, version, down, reasons, facts} ────────

/** A reason is {level: down|degraded|notice, text}. */
export interface Reason {
  level: string;
  text: string;
}
export interface Probe {
  http: number | null;
  ms: number | null;
  version: unknown;
  down: string | null;
  reasons: Reason[];
  facts: Obj;
}

const msOf = (seconds: number) => Math.floor(seconds * 1000);
const downOf = (code: number, port: number | string) =>
  code === 0 ? `not answering on :${port}` : code >= 500 ? `HTTP ${code}` : null;

/** Radarr, Sonarr, Prowlarr: /health and /system/status. */
export function servarrProbe(code: number, seconds: number, health: string, status: string, port: number): Probe {
  const hj = parse(health);
  return {
    http: code,
    ms: msOf(seconds),
    version: alt(at(parse(status), 'version'), null),
    down: downOf(code, port),
    reasons:
      code === 401
        ? [{ level: 'degraded', text: 'API key refused (HTTP 401): health unknown' }]
        : Array.isArray(hj)
          ? (hj as Obj[])
              .filter((h) => h?.type !== 'ok')
              .map((h) => ({
                level: h?.type === 'notice' ? 'notice' : 'degraded',
                text: `${str(alt(h?.source, 'health'))}: ${str(alt(h?.message, ''))}`,
              }))
          : [],
    facts: {},
  };
}

export function bazarrProbe(code: number, seconds: number, health: string, status: string): Probe {
  const issues = alt(at(parse(health), 'data'), []);
  return {
    http: code,
    ms: msOf(seconds),
    version: alt(at(at(parse(status), 'data'), 'bazarr_version'), null),
    down: downOf(code, 6767),
    reasons:
      code === 401 || code === 403
        ? [{ level: 'degraded', text: `API key refused (HTTP ${code}): health unknown` }]
        : (Array.isArray(issues) ? (issues as Obj[]) : []).map((i) => ({
            level: 'degraded',
            text: `${str(alt(i?.object, 'health'))}: ${str(alt(i?.issue, i))}`,
          })),
    facts: {},
  };
}

export function seerrProbe(code: number, seconds: number, status: string): Probe {
  const sj = parse(status);
  return {
    http: code,
    ms: msOf(seconds),
    version: alt(at(sj, 'version'), null),
    down: downOf(code, 5055),
    reasons:
      at(sj, 'restartRequired') === true ? [{ level: 'degraded', text: 'restart required to apply settings' }] : [],
    facts: {},
  };
}

/** The last match of an attribute on the line, as the bash sed's greedy `.*` took it. */
const lastAttr = (text: string, re: RegExp): string => [...text.matchAll(re)].at(-1)?.[1] ?? '';

/** /identity: up, and the same server (trap 4). */
export function plexProbe(code: number, seconds: number, identity: string): Probe {
  const id = lastAttr(identity, /machineIdentifier="([^"]*)"/g);
  const ver = lastAttr(identity, / version="([^"]*)"/g);
  const want = PLEX_IDENTITY;
  return {
    http: code,
    ms: msOf(seconds),
    version: ver === '' ? null : ver,
    down:
      code === 0
        ? 'not answering on :32400'
        : code >= 500
          ? `HTTP ${code}`
          : id !== want
            ? `identity ${id === '' ? 'missing' : `${cut(id, 8)}…`}, expected ${cut(want, 8)}…: a fresh database?`
            : null,
    reasons: [],
    facts: { identity: id === '' ? null : id },
  };
}

/** Reachable or down, nothing more. */
export const httpProbe = (code: number, seconds: number, port: number): Probe => ({
  http: code,
  ms: msOf(seconds),
  version: null,
  down: downOf(code, port),
  reasons: [],
  facts: {},
});

const NO_PROBE: Probe = { http: null, ms: null, version: null, down: null, reasons: [], facts: {} };

/**
 * qBittorrent: log in, read the connection state, log out. After one refused
 * login, wait QBT_BACKOFF before trying again: five refusals ban the address,
 * and from here that is the docker bridge arr-reclaim and the configure scripts use.
 */
export function qbtProbe(
  loginCode: number,
  loginBody: string,
  infoCode: number,
  infoBody: string,
  version: string,
  backoffUntil: number,
  now: number,
): Probe {
  if (backoffUntil > now)
    return {
      ...NO_PROBE,
      reasons: [{ level: 'degraded', text: `login refused earlier; next try ${local('%H:%M', backoffUntil)}` }],
      facts: { backoffUntil },
    };
  if (loginCode === 0) return { ...NO_PROBE, http: 0, down: 'not answering on :8081' };
  if (loginCode === 401 || loginCode === 403 || loginBody.includes('Fails'))
    return {
      ...NO_PROBE,
      http: loginCode,
      reasons: [
        {
          level: 'degraded',
          text: `login refused (${loginCode === 403 ? 'banned' : 'wrong user or password'}); next try in 1 h`,
        },
      ],
      facts: { loginRefused: true },
    };
  const info = parse(infoBody);
  const cs = alt(at(info, 'connection_status'), null);
  return {
    http: infoCode,
    ms: null,
    version: version === '' ? null : version,
    down: infoCode >= 500 ? `HTTP ${infoCode}` : null,
    reasons: cs === 'connected' || cs === null ? [] : [{ level: 'degraded', text: `connection ${str(cs)}` }],
    facts: { connection: cs, dhtNodes: alt(at(info, 'dht_nodes'), null) },
  };
}

// ─── classification ──────────────────────────────────────────────────────────

export interface Item {
  id: string;
  kind?: string;
  label?: string;
  level: string;
  summary: string;
  reasons: Reason[];
  facts: Obj;
}

export interface DriftEntry {
  id: string;
  result: string;
  lines?: string[];
  checkedAtEpoch: number;
}

export interface AppInput {
  id: string;
  onDemand: boolean;
  container: Container | null;
  probe: Probe | null;
  drift: DriftEntry | null;
  now: number;
}

export function classifyApp({ id, onDemand, container: c, probe: p, drift: d, now }: AppInput): Item {
  if (onDemand) return { id, level: 'n/a', summary: 'runs on demand (task recyclarr:sync)', reasons: [], facts: {} };
  const running = c !== null && truthy(c.running);
  const st = epochOf(c?.startedAt ?? null);
  const reasons: Reason[] = [];
  if (c === null) reasons.push({ level: 'down', text: 'no container' });
  else if (truthy(c.restarting)) reasons.push({ level: 'down', text: 'restarting (Docker restart loop)' });
  else if (!truthy(c.running))
    reasons.push({ level: 'down', text: `not running (${str(c.state)}, exit ${str(c.exitCode)})` });
  else if (c.health === 'unhealthy') reasons.push({ level: 'down', text: 'health check: unhealthy' });
  else if (c.health === 'starting') reasons.push({ level: 'degraded', text: 'health check: starting' });
  const restarts = Number(alt(c?.restartCount, 0));
  if (running && restarts > 0 && st !== null && now - st < RESTART_WINDOW)
    reasons.push({
      level: 'degraded',
      text: `restarted by Docker ${str(c?.restartCount)} time(s); up ${ago(st, now)}`,
    });
  if (running && p !== null && p.down !== null) reasons.push({ level: 'down', text: p.down });
  if (running) reasons.push(...(p?.reasons ?? []));
  if (d !== null) {
    const first = (fallback: string) => str(alt(d.lines?.[0], fallback));
    if (d.result === 'drift')
      reasons.push({
        level: 'degraded',
        text: `settings drift (checked ${ago(d.checkedAtEpoch, now)} ago): ${first('see task check')}`,
      });
    else if (d.result === 'failed')
      reasons.push({
        level: 'degraded',
        text: `settings check failed (${ago(d.checkedAtEpoch, now)} ago): ${first('see task check')}`,
      });
    else if (d.result === 'warn') reasons.push({ level: 'notice', text: `settings check warning: ${first('')}` });
  }
  const level = levelOf(reasons);
  const notices = reasons.filter((r) => r.level === 'notice').length;
  const summary =
    level === 'ok'
      ? [
          `up ${st !== null ? ago(st, now) : '?'}`,
          ...(truthy(p?.version) ? [str(p?.version)] : []),
          ...(notices > 0 ? [`${notices} notice(s)`] : []),
        ].join(' · ')
      : (reasons.find((r) => r.level === level)?.text ?? '');
  const { ips: _, ...containerFacts } = c ?? ({} as Container);
  return {
    id,
    level,
    summary,
    reasons,
    facts: {
      container: c === null ? null : containerFacts,
      http: p === null ? null : { code: p.http, ms: p.ms },
      version: alt(p?.version, null),
      drift: d === null ? null : { result: d.result, checkedAt: d.checkedAtEpoch, lines: d.lines ?? null },
      ...p?.facts,
    },
  };
}

/** `systemctl show` text (blank-line separated blocks) → {Id: {key: value}}. */
export function parseShow(text: string): Record<string, Record<string, string>> {
  const outp: Record<string, Record<string, string>> = {};
  for (const block of text.split('\n\n')) {
    const o: Record<string, string> = {};
    for (const line of block.split('\n')) {
      const m = /^([^=]+)=(.*)$/s.exec(line);
      if (m) o[m[1] ?? ''] = m[2] ?? '';
    }
    if (o.Id !== undefined) outp[o.Id] = o;
  }
  return outp;
}

/** Meanings of pms-update's exit codes (jobs/pms-update/update-stack.ts). */
const PMS_UPDATE_EXIT: Readonly<Record<string, string>> = {
  '3': 'preflight failed',
  '4': 'Plex token rejected',
  '5': 'Plex not answering',
  '6': 'pull failed',
  '9': 'an update was rolled back; the old image is serving',
  '10': 'a rollback failed: a service is DOWN',
};
const exitText = (unit: string, code: number) =>
  (unit === 'pms-update.service' ? PMS_UPDATE_EXIT[String(code)] : undefined) ?? `exit ${code}`;

export type Show = Record<string, Record<string, string>>;
export type ListTimers = Record<string, { next?: unknown; last?: unknown }>;

export function classifyTimer(name: string, show: Show, lt: ListTimers): Item {
  const t: Obj = show[`${name}.timer`] ?? {};
  const s: Obj = show[`${name}.service`] ?? {};
  const l: Obj = lt[`${name}.timer`] ?? {};
  const next = Math.floor(Number(alt(l.next, 0)) / 1_000_000);
  const last = Math.floor(Number(alt(l.last, 0)) / 1_000_000);
  const activating = alt(s.ActiveState, '') === 'activating';
  const reasons: Reason[] = [];
  if (t.UnitFileState !== 'enabled' || t.ActiveState !== 'active')
    reasons.push({
      level: 'degraded',
      text: `timer not armed (${alt(t.UnitFileState, '') === '' ? 'not installed' : `${str(t.UnitFileState)}, ${str(t.ActiveState)}`}): task deploy`,
    });
  if (alt(s.Result, 'success') !== 'success' || (alt(s.ExecMainStatus, '0') !== '0' && !activating))
    reasons.push({
      level: 'degraded',
      text: `last run failed: ${str(alt(s.Result, '?'))} (${exitText(`${name}.service`, toNum(alt(s.ExecMainStatus, '0')) ?? 0)})`,
    });
  return {
    id: `timer:${name}`,
    kind: 'timer',
    label: name,
    level: levelOf(reasons),
    summary:
      reasons.length > 0
        ? (reasons[0]?.text ?? '')
        : activating
          ? 'running now'
          : [last > 0 ? `last ${at_(last)}` : 'not run yet', ...(next > 0 ? [`next ${at_(next)}`] : [])].join(' · '),
    reasons,
    facts: {
      armed: t.UnitFileState === 'enabled' && t.ActiveState === 'active',
      running: activating,
      lastRun: last > 0 ? last : null,
      nextRun: next > 0 ? next : null,
      lastResult: alt(s.Result, null),
      lastExit: toNum(alt(s.ExecMainStatus, null)) ?? null,
    },
  };
}

/** A long-running service: ok while it runs, down otherwise, with what that costs. */
function classifyService(show: Show, name: string, running: string, cost: string, now: number): Item {
  const s: Obj = show[`${name}.service`] ?? {};
  const since = toNum(String(alt(s.ActiveEnterTimestamp, '')).replace(/^@/, '')) ?? null;
  const base = { id: `service:${name}`, kind: 'service', label: name };
  if (s.ActiveState === 'active' && s.SubState === 'running')
    return {
      ...base,
      level: 'ok',
      summary: `${running}, up ${since !== null ? ago(since, now) : '?'}`,
      reasons: [],
      facts: { active: true, since },
    };
  const state = str(alt(s.ActiveState, 'not installed'));
  return {
    ...base,
    level: 'down',
    summary: `not running (${state}): ${cost}`,
    reasons: [{ level: 'down', text: `${name}.service is ${state}` }],
    facts: { active: false, since: null },
  };
}

export const classifyWatcher = (show: Show, now: number): Item =>
  classifyService(show, 'arr-reclaim', 'watching the library', 'deleted media keeps its torrent', now);

/** stack-api: while it is down, nginx's gate sends every page to the login page. */
export const classifyStackApi = (show: Show, now: number): Item =>
  classifyService(show, 'stack-api', 'signing in the owner', 'the site shows only its login page', now);

/** One `df -P -B1` line. */
export function classifyDisk(path: string, line: string, warn: number): Item {
  const f = line.split(/ +/);
  const base = { id: `disk:${path}`, kind: 'disk', label: path };
  const pct = toNum((f[4] ?? '').replace(/%$/, ''));
  const avail = toNum(f[3] ?? '');
  if (f.length < 6 || pct === undefined || avail === undefined)
    return { ...base, level: 'unknown', summary: 'df gave no answer', reasons: [], facts: {} };
  const gb = Math.floor(avail / 1_000_000_000);
  const r: Reason[] =
    pct >= warn ? [{ level: 'degraded', text: `${pct}% used, ${gb} GB free (warns at ${warn}%)` }] : [];
  return {
    ...base,
    level: r.length > 0 ? 'degraded' : 'ok',
    summary: `${pct}% used, ${gb} GB free`,
    reasons: r,
    facts: { usedPercent: pct, availBytes: avail, warnAt: warn },
  };
}

/** `ip -j addr` JSON and lan-address's state → the LAN item (and the addresses for the page). */
export function classifyLan(ip: unknown, state: string, apps: readonly string[]): Item {
  const addrs: { iface: string; addr: string }[] = [];
  for (const i of Array.isArray(ip) ? (ip as Obj[]) : [])
    for (const a of Array.isArray(i?.addr_info) ? (i.addr_info as Obj[]) : [])
      if (
        a?.family === 'inet' &&
        a?.scope === 'global' &&
        typeof a.local === 'string' &&
        !/^(127\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(a.local)
      )
        addrs.push({ iface: str(i.ifname), addr: a.local });
  const nowAddrs = [...new Set(addrs.map((a) => a.addr))].sort().join(' ');
  const rec: Record<string, string> = {};
  for (const line of state.split('\n')) {
    const m = /^(\S+)\s*(.*)$/s.exec(line);
    if (line.length > 0 && m) rec[m[1] ?? ''] = m[2] ?? '';
  }
  const pending = apps.filter((a) => a.length > 0 && (rec[a] ?? '') !== nowAddrs);
  return {
    id: 'lan',
    kind: 'lan',
    label: 'LAN addresses',
    level: addrs.length === 0 ? 'down' : pending.length > 0 ? 'degraded' : 'ok',
    summary: addrs.length === 0 ? 'no LAN address' : addrs.map((a) => `${a.addr} (${a.iface})`).join(', '),
    reasons:
      pending.length > 0
        ? [
            {
              level: 'degraded',
              text: `address settings not applied yet: ${pending.join(', ')} (lan-address runs every 5 min)`,
            },
          ]
        : [],
    facts: { addresses: addrs, pending },
  };
}

// ─── drift ───────────────────────────────────────────────────────────────────

/** A configure.sh --check's exit code and output → {result, lines}. */
export function classifyDrift(rc: number, output: string): { result: string; lines: string[] } {
  const all = output.split('\n');
  const found = all.filter((l) => /^\s+(DRIFT|FAIL|FAILING|WARN|warn)\s/.test(l)).slice(0, 20);
  const drift = all.filter((l) => /^\s+DRIFT\s/.test(l)).length;
  const fail = all.filter((l) => /^\s+FAIL\s/.test(l)).length;
  const warn = all.filter((l) => /^\s+(FAILING|WARN|warn)\s/.test(l)).length;
  const result =
    rc === 124
      ? 'failed'
      : rc === 0
        ? warn > 0
          ? 'warn'
          : 'ok'
        : rc === 1 && drift > 0 && fail === 0
          ? 'drift'
          : 'failed';
  const lines =
    rc === 124
      ? ['timed out', ...found]
      : found.length === 0 && rc !== 0
        ? [all.filter((l) => l.length > 0).at(-1) ?? `exit ${rc}`]
        : found;
  return { result, lines: lines.map((l) => cut(l.replace(/^\s+/, ''), 300)) };
}

/** stack/deploy.sh --check's exit code and output → {result, lines}. */
export function classifyDeployDrift(rc: number, output: string): { result: string; lines: string[] } {
  const lines = output
    .split('\n')
    .filter((l) => l.length > 0 && !/^(ok:|checked|To apply|$)/.test(l))
    .slice(0, 20);
  return { result: rc === 0 ? 'ok' : rc === 1 ? 'drift' : 'failed', lines };
}

// ─── logs ────────────────────────────────────────────────────────────────────
// One log line counts as a problem when it says so: the jobs log everything at
// one journal priority, and the apps each have their own format.

const ANSI = new RegExp(String.raw`\u001b\[[0-9;?]*[A-Za-z]`, 'g');
const CONTROL = new RegExp(String.raw`[\u0000-\u0008\u000b-\u001f\u007f]`, 'g');
const clean = (s: string) => cut(s.replace(ANSI, '').replace(CONTROL, ''), LINE_MAX);
const PROBLEM =
  /\b(warn(ing)?|err(or|ors)?|fatal|crit(ical)?|exception|panic|fail(ed|ure|ing|s)?|refused|denied|unauthori[sz]ed|timed? ?out|traceback)\b/i;
/** Known noise that says error but is not: Plex prints both lines on every start. */
const noise = (s: string) => /libusb_init/i.test(s);
export const isProblem = (msg: string) => (PROBLEM.test(msg) || /\bDRIFT\b/.test(msg)) && !noise(msg);

export interface LogLine {
  t: string | null;
  msg: string;
}

export function logLines(kind: 'journal' | 'docker', raw: string): LogLine[] {
  return raw
    .split('\n')
    .filter((l) => l.length > 0 && !l.startsWith('-- '))
    .map((l) => {
      if (kind === 'journal') {
        const m = /^(\S+) \S+ (.*)$/s.exec(l);
        return { t: m ? (m[1] ?? null) : null, msg: clean(m ? (m[2] ?? '') : l) };
      }
      const m = /^([0-9]{4}-[0-9]{2}-[0-9]{2}T\S+Z) ?(.*)$/s.exec(l);
      return {
        t: m ? (m[1] ?? '').replace(/(\.[0-9]{3})[0-9]*Z$/, '$1Z') : null,
        msg: clean(m ? (m[2] ?? '') : l),
      };
    });
}

export function logSource(kind: 'journal' | 'docker', id: string, label: string, raw: string, error: string) {
  const all = logLines(kind, raw);
  const problems = all.filter((l) => isProblem(l.msg));
  return {
    id,
    kind,
    label,
    scanned: all.length,
    tail: all.slice(-LOG_KEEP),
    problems: problems.slice(-LOG_KEEP),
    problemCount: problems.length,
    error: error === '' ? null : error,
  };
}

// ─── running it ──────────────────────────────────────────────────────────────

/** What a URL answered: curl's %{http_code} (0 when nothing did), its time, the body. */
export interface Fetched {
  code: number;
  seconds: number;
  body: string;
}

export interface Deps {
  /** docker, systemctl, df, ip: stdout only, as the bash discarded stderr. */
  run: Run;
  /** journalctl, docker logs and the checks: stdout and stderr as one stream, in order (2>&1). */
  runMerged: (argv: readonly string[], timeoutMs: number) => Promise<{ code: number; output: string }>;
  fetch: (url: string, headers: Record<string, string>, timeoutMs: number) => Promise<Fetched>;
  /** qBittorrent's login, which needs its cookie. */
  http: Http;
  /** Epoch seconds. */
  now: () => number;
  log: Log;
  which: (cmd: string) => boolean;
  env: Env;
  /** The install: its .env, the configure scripts, deploy.sh. */
  repo: string;
}

type Mode = 'file' | 'stdout' | 'audit';

interface Ctx {
  deps: Deps;
  mode: Mode;
  envText: string;
  appdata: string;
  outDir: string;
  tHttp: number;
  disk: string;
  secrets: string[];
}

/** A key from .env itself, as the bash env_get read it (the environment does not override). */
const envKey = (c: Ctx, key: string) => envFileValue(c.envText, key);
const readOr = (path: string): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};
const stripNl = (s: string) => s.replace(/\n+$/, '');

async function probeServarr(c: Ctx, app: string, ver: string, keyVar: string): Promise<Probe> {
  const base = `http://127.0.0.1:${APP_PORT[app]}/api/${ver}`;
  const h = { 'X-Api-Key': envKey(c, keyVar) };
  const health = await c.deps.fetch(`${base}/health`, h, c.tHttp);
  const status = await c.deps.fetch(`${base}/system/status`, h, c.tHttp);
  return servarrProbe(health.code, health.seconds, health.body, status.body, APP_PORT[app] ?? 0);
}

async function probeBazarr(c: Ctx): Promise<Probe> {
  const h = { 'X-API-KEY': readBazarrKey(join(c.appdata, 'bazarr/config/config.yaml')) };
  const health = await c.deps.fetch(`http://127.0.0.1:6767/api/system/health`, h, c.tHttp);
  const status = await c.deps.fetch(`http://127.0.0.1:6767/api/system/status`, h, c.tHttp);
  return bazarrProbe(health.code, health.seconds, health.body, status.body);
}

async function probeSeerr(c: Ctx): Promise<Probe> {
  const r = await c.deps.fetch(`http://127.0.0.1:5055/api/v1/status`, {}, c.tHttp);
  return seerrProbe(r.code, r.seconds, r.body);
}

async function probePlex(c: Ctx): Promise<Probe> {
  const r = await c.deps.fetch(`http://127.0.0.1:32400/identity`, {}, c.tHttp);
  return plexProbe(r.code, r.seconds, r.body.replaceAll('\n', ''));
}

// /login/, not /: every other page sends a signed-out caller there (stack-api's gate).
async function probeDocs(c: Ctx): Promise<Probe> {
  const r = await c.deps.fetch(`http://127.0.0.1:8088/login/`, {}, c.tHttp);
  return httpProbe(r.code, r.seconds, 8088);
}

async function probeFlaresolverr(c: Ctx, ip: unknown): Promise<Probe> {
  if (typeof ip !== 'string' || ip === '') return { ...NO_PROBE };
  const r = await c.deps.fetch(`http://${ip}:${FLARESOLVERR_PORT}/`, {}, c.tHttp);
  const body = parse(r.body);
  return {
    ...httpProbe(r.code, r.seconds, FLARESOLVERR_PORT),
    version: body !== null && typeof body === 'object' && !Array.isArray(body) ? ((body as Obj).version ?? null) : null,
  };
}

const statePath = (c: Ctx) => join(c.appdata, '.stack-status.state');

/** The job's private state (backoff), 0600, replaced atomically. */
export function stateSet(path: string, key: string, value: number): void {
  const cur = parse(readOr(path));
  const next = { ...(cur !== null && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}), [key]: value };
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

async function probeQbittorrent(c: Ctx): Promise<Probe> {
  const now = c.deps.now();
  const until = Number(alt(at(parse(readOr(statePath(c))), 'qbtBackoffUntil'), 0)) || 0;
  if (until > now) return qbtProbe(0, '', 0, '', '', until, now);
  const login = await qbtLogin(c.deps.http, {
    url: 'http://127.0.0.1:8081',
    user: envKey(c, 'QBT_ARR_USER'),
    pass: envKey(c, 'QBT_ARR_PASS'),
    timeoutMs: c.tHttp,
  });
  if (login.kind === 'unreachable') return qbtProbe(0, '', 0, '', '', 0, now);
  if (login.kind === 'refused') {
    if (login.status === 401 || login.status === 403 || login.body.includes('Fails'))
      stateSet(statePath(c), 'qbtBackoffUntil', now + QBT_BACKOFF);
    return qbtProbe(login.status, login.body, 0, '', '', 0, now);
  }
  const info = await login.session.get('/api/v2/transfer/info');
  const version = await login.session.get('/api/v2/app/version');
  await login.session.post('/api/v2/auth/logout', {});
  return qbtProbe(204, '', info.status, info.text, version.text, 0, now);
}

async function collectLogs(c: Ctx) {
  const sources = [];
  for (const u of LOG_UNITS) {
    const r = await c.deps.runMerged(
      ['journalctl', '-u', `${u}.service`, '-n', String(LOG_SCAN), '-o', 'short-iso', '--no-pager'],
      T_CMD,
    );
    sources.push(logSource('journal', `unit:${u}`, u, r.output, r.code ? `journalctl exit ${r.code}` : ''));
  }
  for (const app of STATUS_APPS) {
    if (ON_DEMAND_APPS.includes(app)) continue;
    const r = await c.deps.runMerged(['docker', 'logs', '--timestamps', '--tail', String(LOG_SCAN), app], T_CMD);
    sources.push(logSource('docker', `container:${app}`, app, r.output, r.code ? `docker logs exit ${r.code}` : ''));
  }
  return sources;
}

/** The drift item, from the last hourly drift.json. */
export function classifyDriftDoc(d: Obj | null, now: number): Item {
  const base = { id: 'drift', kind: 'drift', label: 'settings check' };
  if (d === null) return { ...base, level: 'unknown', summary: 'not run yet (hourly)', reasons: [], facts: {} };
  const at0 = Number(d.generatedAtEpoch);
  const deploy = at(d, 'deploy');
  const r: Reason[] = [];
  if (now - at0 > DRIFT_STALE)
    r.push({ level: 'degraded', text: `last settings check ${ago(at0, now)} ago: stack-status-drift.timer` });
  if (at(deploy, 'result') === 'drift') r.push({ level: 'degraded', text: 'units differ from the repo: task deploy' });
  else if (at(deploy, 'result') === 'failed') r.push({ level: 'degraded', text: 'deploy check failed' });
  const apps = Array.isArray(d.apps) ? (d.apps as Obj[]) : [];
  const matching = apps.filter((a) => a?.result === 'ok' || a?.result === 'warn').length;
  return {
    ...base,
    level: levelOf(r),
    summary:
      r.length > 0
        ? (r[0]?.text ?? '')
        : `checked ${ago(at0, now)} ago: ${matching}/${apps.length} apps match the repo`,
    reasons: r,
    facts: { checkedAt: d.generatedAtEpoch ?? null, deploy },
  };
}

/** {degraded: 2, down: 3, …}, keys in jq's order. */
const countsOf = (levels: readonly string[]) => {
  const n: Record<string, number> = {};
  for (const l of [...levels].sort()) n[l] = (n[l] ?? 0) + 1;
  return n;
};

/** Validate, redact, guard, then write atomically (mode 644: nginx is uid 101). */
export function publish(c: Pick<Ctx, 'deps' | 'mode' | 'outDir' | 'secrets'>, name: string, doc: unknown): boolean {
  const { log } = c.deps;
  let raw: string | undefined;
  try {
    raw = JSON.stringify(doc);
  } catch {
    raw = undefined;
  }
  if (raw === undefined) return (log(`ERROR: ${name} is not valid JSON — not published`), false);
  const red = redact(JSON.parse(raw), c.secrets);
  const text = JSON.stringify(red);
  const n = leaks(text, c.secrets);
  if (n > 0) return (log(`ERROR: redaction guard: ${n} secret occurrence(s) left in ${name} — not published`), false);
  if (c.mode === 'stdout') return (log(JSON.stringify(red, null, 2)), true);
  if (c.mode === 'audit') {
    const bytes = new TextEncoder().encode(`${text}\n`).length;
    const masked = text.split(REDACTED).length - 1;
    log(`${name.padEnd(12)} ${String(bytes).padStart(7)} bytes, ${String(masked).padStart(4)} masked, ${n} leaks`);
    return true;
  }
  const tmp = join(c.outDir, `.${name}.${Math.random().toString(36).slice(2, 8)}`);
  try {
    writeFileSync(tmp, `${text}\n`);
    chmodSync(tmp, 0o644);
    renameSync(tmp, join(c.outDir, name));
    return true;
  } catch {
    rmSync(tmp, { force: true });
    log(`ERROR: cannot write ${join(c.outDir, name)}`);
    return false;
  }
}

/** One journal line when a level changed since the published status, else quiet. */
function logChanges(c: Ctx, status: { overall: string; apps: Item[]; host: Item[] }) {
  if (c.mode !== 'file') return;
  let changed: string;
  const old = parse(readOr(join(c.outDir, 'status.json'))) as { apps?: Item[]; host?: Item[] } | null;
  if (old === null || !Array.isArray(old.apps) || !Array.isArray(old.host)) changed = 'first run';
  else {
    const was: Record<string, string> = {};
    for (const i of [...old.apps, ...old.host]) was[i.id] = i.level;
    changed = [...status.apps, ...status.host]
      .filter((i) => (was[i.id] ?? 'new') !== i.level)
      .map((i) => `${i.id} ${was[i.id] ?? 'new'}→${i.level}`)
      .join(', ');
  }
  if (changed) c.deps.log(`overall ${status.overall}: ${changed}`);
}

async function fastRun(c: Ctx): Promise<boolean> {
  const { deps } = c;
  const start = deps.now();
  const now = start;
  const inspect = await deps.run(['docker', 'inspect', ...STATUS_APPS], { timeoutMs: T_CMD });
  const containers = containersJson(inspect.stdout);

  const units = ['arr-reclaim.service', 'stack-api.service', ...TIMERS.flatMap((t) => [`${t}.timer`, `${t}.service`])];
  // Probes in parallel; each request is capped by STACK_STATUS_T_HTTP.
  const [probes, sources, show, timers, ip, dfLine] = await Promise.all([
    Promise.all([
      probeServarr(c, 'radarr', 'v3', 'RADARR_API_KEY'),
      probeServarr(c, 'sonarr', 'v3', 'SONARR_API_KEY'),
      probeServarr(c, 'prowlarr', 'v1', 'PROWLARR_API_KEY'),
      probeBazarr(c),
      probeSeerr(c),
      probePlex(c),
      probeDocs(c),
      probeQbittorrent(c),
      probeFlaresolverr(c, containers.flaresolverr?.ips[0]),
    ]).then(([radarr, sonarr, prowlarr, bazarr, seerr, plex, docs, qbittorrent, flaresolverr]) => ({
      radarr,
      sonarr,
      prowlarr,
      bazarr,
      seerr,
      plex,
      docs,
      qbittorrent,
      flaresolverr,
    })),
    collectLogs(c),
    deps
      .run(
        [
          'systemctl',
          'show',
          ...units,
          '--timestamp=unix',
          '-p',
          'Id,UnitFileState,ActiveState,SubState,Result,ExecMainStatus,ActiveEnterTimestamp',
        ],
        { timeoutMs: T_CMD },
      )
      .then((r) => parseShow(r.stdout)),
    deps
      .run(['systemctl', 'list-timers', '--all', '--output=json', ...TIMERS.map((t) => `${t}.timer`)], {
        timeoutMs: T_CMD,
      })
      .then((r) => {
        const list = parse(r.stdout);
        const lt: ListTimers = {};
        for (const t of Array.isArray(list) ? (list as Obj[]) : [])
          lt[str(t?.unit)] = { next: t?.next ?? null, last: t?.last ?? null };
        return lt;
      }),
    deps.run(['ip', '-j', 'addr'], { timeoutMs: T_CMD }).then((r) => parse(r.stdout)),
    deps.run(['df', '-P', '-B1', c.disk], { timeoutMs: T_CMD }).then((r) => stripNl(r.stdout).split('\n').at(-1) ?? ''),
  ]);
  const lanState = stripNl(readOr(join(c.appdata, '.lan-address')));
  const driftRaw = parse(readOr(join(c.outDir, 'drift.json')));
  const driftDoc =
    driftRaw !== null && typeof driftRaw === 'object' && !Array.isArray(driftRaw) ? (driftRaw as Obj) : null;

  const apps = STATUS_APPS.map((id) => {
    const entry = Array.isArray(driftDoc?.apps) ? (driftDoc.apps as Obj[]).find((a) => a?.id === id) : undefined;
    return classifyApp({
      id,
      onDemand: ON_DEMAND_APPS.includes(id),
      container: containers[id] ?? null,
      probe: (probes as Record<string, Probe | undefined>)[id] ?? null,
      now,
      drift: entry ? ({ ...entry, checkedAtEpoch: driftDoc?.generatedAtEpoch } as unknown as DriftEntry) : null,
    });
  });
  const host = [
    classifyWatcher(show, now),
    classifyStackApi(show, now),
    ...TIMERS.map((t) => classifyTimer(t, show, timers)),
    classifyDisk(c.disk, dfLine, DISK_WARN),
    classifyLan(ip, lanState, LAN_APPS),
    classifyDriftDoc(driftDoc, now),
  ];
  const notes =
    show['pms-update.service']?.ActiveState === 'activating'
      ? ['The weekly update is running: containers may restart.']
      : [];

  const all = [...apps, ...host];
  const generatedAt = local('%Y-%m-%dT%H:%M:%S%z', now);
  const status = {
    schema: 1,
    generatedAt,
    generatedAtEpoch: now,
    runSeconds: deps.now() - start,
    staleAfterSeconds: STALE_AFTER,
    overall: worst(all.map((i) => i.level)),
    counts: countsOf(all.map((i) => i.level)),
    notes,
    lan: host.find((i) => i.id === 'lan')?.facts.addresses ?? [],
    apps,
    host,
  };
  const logs = { schema: 1, generatedAt, generatedAtEpoch: now, sources };

  logChanges(c, status);
  const okStatus = publish(c, 'status.json', status);
  const okLogs = publish(c, 'logs.json', logs);
  return okStatus && okLogs;
}

async function driftRun(c: Ctx): Promise<boolean> {
  const { deps } = c;
  const now = deps.now();
  const apps = [];
  for (const id of DRIFT_APPS) {
    const start = deps.now();
    const r = await deps.runMerged([join(deps.repo, 'apps', id, 'configure.sh'), '--check'], T_CONFIGURE);
    apps.push({ id, rc: r.code, seconds: deps.now() - start, ...classifyDrift(r.code, r.output) });
  }
  const d = await deps.runMerged([join(deps.repo, 'stack/deploy.sh'), '--check'], T_DEPLOY);
  const deploy = classifyDeployDrift(d.code, d.output);
  const doc = {
    schema: 1,
    generatedAt: local('%Y-%m-%dT%H:%M:%S%z', now),
    generatedAtEpoch: now,
    apps,
    deploy,
  };
  if (c.mode === 'file')
    deps.log(`settings check: ${[...apps.map((a) => `${a.id} ${a.result}`), `deploy ${deploy.result}`].join(', ')}`);
  return publish(c, 'drift.json', doc);
}

const USAGE = 'usage: stack-status.sh [--drift] [--stdout | --audit]';

export async function main(argv: readonly string[], deps: Deps): Promise<number> {
  const { env, log, repo } = deps;
  let drift = false;
  let mode: Mode = 'file';
  for (const arg of argv) {
    if (arg === '--drift') drift = true;
    else if (arg === '--stdout') mode = 'stdout';
    else if (arg === '--audit') mode = 'audit';
    else if (arg === '-h' || arg === '--help') {
      log(headerHelp(await Bun.file(import.meta.path).text()));
      return 0;
    } else throw new UsageError(USAGE);
  }
  if (!deps.which('docker')) return (log('missing command: docker'), 3);
  const envPath = join(repo, '.env');
  let envText: string;
  try {
    envText = readFileSync(envPath, 'utf8');
  } catch {
    return (log(`no ${envPath}`), 3);
  }
  const appdata = env.APPDATA || envFileValue(envText, 'APPDATA') || '/opt/appdata';
  const outDir = env.STACK_STATUS_DIR || join(appdata, 'docs-status');

  if (mode === 'file') {
    let writable = false;
    try {
      writable = statSync(outDir).isDirectory();
      accessSync(outDir, constants.W_OK);
    } catch {
      writable = false;
    }
    if (!writable) {
      log(`ERROR: ${outDir} is missing or not writable — create it as yourself: install -d -m 755 ${outDir}`);
      return 1;
    }
  }

  let lock = null;
  if (mode === 'file') {
    const path = join(appdata, drift ? '.stack-status-drift.lock' : '.stack-status.lock');
    try {
      lock = tryLock(path);
    } catch {
      return (log(`cannot open ${path}`), 1);
    }
    if (lock === null) return (log(`Another run holds ${path} — skipping.`), 0);
  }

  try {
    const secrets = secretsList([
      ...envSecretValues(envText),
      readSeerrKey(join(appdata, 'seerr/settings.json')),
      readBazarrKey(join(appdata, 'bazarr/config/config.yaml')),
      readPlexToken(plexPrefsPath(appdata)),
    ]);
    if (mode === 'audit') {
      const keys = unclassifiedKeys(envText).join(' ');
      log(`secrets loaded: ${secrets.length} literal value(s); unclassified .env keys (masked): ${keys || 'none'}`);
    }
    const c: Ctx = {
      deps,
      mode,
      envText,
      appdata,
      outDir,
      tHttp: (Number(env.STACK_STATUS_T_HTTP) || 5) * 1000,
      disk: env.STACK_STATUS_DISK || '/mnt/data',
      secrets,
    };
    return (await (drift ? driftRun(c) : fastRun(c))) ? 0 : 1;
  } finally {
    lock?.release();
  }
}

/** curl's habits: %{http_code} 0 when nothing answered, and the time it took. */
export function timedFetch(http: Http): Deps['fetch'] {
  return async (url, headers, timeoutMs) => {
    const t0 = performance.now();
    const r = await http(url, { headers, timeoutMs });
    return { code: r.status, seconds: (performance.now() - t0) / 1000, body: r.text };
  };
}

/** stdout and stderr as one stream, in the order written: `exec "$@" 2>&1`. */
export const merged =
  (r: Run): Deps['runMerged'] =>
  async (argv, timeoutMs) => {
    const res = await r(['sh', '-c', 'exec "$@" 2>&1', 'sh', ...argv], { timeoutMs });
    return { code: res.code, output: stripNl(res.stdout) };
  };

if (import.meta.main) {
  const http = makeHttp();
  await runMain(() =>
    main(Bun.argv.slice(2), {
      run,
      runMerged: merged(run),
      fetch: timedFetch(http),
      http,
      now: () => Math.floor(Date.now() / 1000),
      log: out,
      which: (cmd) => Bun.which(cmd) !== null,
      env: process.env,
      repo: resolve(import.meta.dir, '../..'),
    }),
  );
}
