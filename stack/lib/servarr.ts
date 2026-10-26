// stack/lib/servarr.ts — the API plumbing shared by the Servarr configure
// scripts: a port of stack/lib/servarr.sh, which stays until its last bash
// user is ported.
//
// Prowlarr, Radarr and Sonarr are one code base underneath: the same API-key
// header, the same forms login, the same /config/host object. Only the API
// version differs (Prowlarr v1, Radarr/Sonarr v3). Log lines are the bash
// ones, word for word: stack-status parses the DRIFT/FAIL/FAILING lines.

import { httpCode, is2xx, jsonOf, type Http, type HttpResponse } from './http.ts';
import type { Log } from './log.ts';

export interface ServarrConfig {
  /** Compose service name, and the hostname other containers reach it by. */
  name: string;
  /** e.g. http://127.0.0.1:9696 */
  url: string;
  key: string;
  api: 'v1' | 'v3';
  /** WebUI login. */
  user: string;
  pass: string;
  /** Per request / for the API to come up. */
  timeoutMs: number;
  waitMs: number;
  /** ALLOWED_HOSTS_EXTRA, split: only for rehearsing against throwaway containers. */
  extraHosts?: readonly string[];
}

export interface ServarrDeps {
  http: Http;
  log: Log;
  sleep: (ms: number) => Promise<void>;
  /** Milliseconds, for deadlines. */
  now: () => number;
  hostname: () => string;
  lanIps: () => string[];
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface ApiResult {
  ok: boolean;
  status: number;
  text: string;
  json: unknown;
}

/** A resource from a schema: download client, notification, application. */
export interface Resource {
  fields: { name: string; value?: Json; [key: string]: Json | undefined }[];
  [key: string]: unknown;
}

// ─── pure helpers ─────────────────────────────────────────────────────────────

/** jq's `==`: the same JSON, whatever the key order. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every((k) => k in b && jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}

/** ALLOWED_HOSTS_EXTRA's names: comma- or space-separated, empty by default. */
export function splitHosts(value: string | undefined): string[] {
  return (value ?? '').split(/[,\s]+/).filter(Boolean);
}

/** The keys of `want` whose value differs in `got`, in want's order. */
export function hostDrift(got: Readonly<Record<string, unknown>>, want: JsonObject): string[] {
  return Object.keys(want).filter((k) => !jsonEqual(got[k] ?? null, want[k]));
}

/** Sets fields[].value from a {name: value} map; fields not in it are kept. */
export function fieldsSet<R extends Resource>(resource: R, map: JsonObject): R {
  return { ...resource, fields: resource.fields.map((f) => (f.name in map ? { ...f, value: map[f.name] } : f)) };
}

/** Names in the map whose field value differs (a missing field is null). */
export function fieldsDrift(resource: Resource, map: JsonObject): string[] {
  const got: Record<string, Json> = {};
  for (const f of resource.fields ?? []) got[f.name] = f.value ?? null;
  return Object.keys(map).filter((k) => !jsonEqual(got[k] ?? null, map[k]));
}

/** A whole resource from a schema entry (or an existing one) with our values in. */
export function resourceWant(base: Resource, top: JsonObject, fields: JsonObject): Resource {
  return fieldsSet({ ...base, ...top } as Resource, fields);
}

/** Drift in a resource: top-level keys and field values, secrets left out (both apps mask them on read). */
export function resourceDrift(cur: Resource, top: JsonObject, fields: JsonObject): string[] {
  return [...hostDrift(cur, top), ...fieldsDrift(cur, fields)];
}

/**
 * The first error message of a failed write, for the log: `.[0].errorMessage`
 * of a validation error list. As api_error's jq has it, an object body gives
 * nothing (`.[0]` on an object is an error there, and it ends the expression).
 */
export function apiError(text: string): string {
  const body = jsonOf({ text });
  if (!Array.isArray(body)) return '';
  const msg = (body[0] as Record<string, unknown> | undefined)?.errorMessage;
  if (msg === undefined || msg === null || msg === false) return '';
  return (typeof msg === 'string' ? msg : JSON.stringify(msg)).slice(0, 160);
}

/** Success redirects to the return URL; failure to /login?…loginFailed=true. Both are 302. */
export function loginRedirectOk(location: string | null | undefined): boolean {
  return !!location && !location.includes('loginFailed');
}

// ─── the client ───────────────────────────────────────────────────────────────

export interface Servarr {
  /** Paths are relative to /api/<version>. */
  api(method: string, path: string, body?: unknown): Promise<ApiResult>;
  get(path: string): Promise<ApiResult>;
  waitReady(): Promise<boolean>;
  loginOk(): Promise<boolean>;
  allowedHosts(service?: string): string;
  wantHost(): JsonObject;
  applyHost(): Promise<boolean>;
  verifyHost(): Promise<boolean>;
  applyResource(r: ResourceSpec & { secretName: string; secret: string }): Promise<boolean>;
  verifyResource(r: ResourceSpec): Promise<boolean>;
}

export interface ResourceSpec {
  label: string;
  /** downloadclient, notification, applications */
  endpoint: string;
  implementation: string;
  top: JsonObject;
  fields: JsonObject;
}

export function servarr(cfg: ServarrConfig, deps: ServarrDeps): Servarr {
  const { http, log } = deps;
  const toResult = (r: HttpResponse): ApiResult => ({
    ok: is2xx(r.status),
    status: r.status,
    text: r.text,
    json: jsonOf(r),
  });

  // POST and PUT always send JSON, an empty body when there is none.
  const api: Servarr['api'] = async (method, path, body) => {
    const headers: Record<string, string> = { 'X-Api-Key': cfg.key };
    const sends = method === 'POST' || method === 'PUT';
    if (sends) headers['Content-Type'] = 'application/json';
    const r = await http(`${cfg.url}/api/${cfg.api}${path}`, {
      method,
      headers,
      body: sends ? (body === undefined ? '' : JSON.stringify(body)) : undefined,
      timeoutMs: cfg.timeoutMs,
    });
    return toResult(r);
  };
  const get = (path: string) => api('GET', path);

  const waitReady = async () => {
    const deadline = deps.now() + cfg.waitMs;
    for (;;) {
      const r = await get('/system/status');
      if (r.ok) return true;
      if (r.status === 401) return false; // up, but the key is wrong: waiting will not help
      if (deps.now() >= deadline) return false;
      await deps.sleep(3000);
    }
  };

  const loginOk = async () => {
    const r = await http(`${cfg.url}/login?returnUrl=/`, {
      method: 'POST',
      body: new URLSearchParams({ username: cfg.user, password: cfg.pass }),
      timeoutMs: cfg.timeoutMs,
      redirect: 'manual',
    });
    return r.status !== 0 && loginRedirectOk(r.headers.get('location'));
  };

  // Required whenever auth is not required for local addresses: the service
  // name (other containers), 127.0.0.1 (these scripts), the box's names.
  const allowedHosts = (service?: string) =>
    [service ?? cfg.name, 'localhost', '127.0.0.1', deps.hostname(), ...deps.lanIps(), ...(cfg.extraHosts ?? [])].join(
      ',',
    );

  // The host-config keys these scripts own; everything else is left as the app has it.
  const wantHost = (): JsonObject => ({
    username: cfg.user,
    authenticationMethod: 'forms',
    authenticationRequired: 'disabledForLocalAddresses',
    allowedHosts: allowedHosts(),
  });

  // allowedHosts must be set before the app will save a login in
  // "not required for local addresses" mode (a 400 otherwise).
  const applyHost = async () => {
    const r = await get('/config/host');
    if (!r.ok) {
      log(`  FAIL  read host config (HTTP ${httpCode(r.status)})`);
      return false;
    }
    const cur = r.json as JsonObject;
    const want = wantHost();
    const drift = hostDrift(cur, want);
    if (drift.length === 0 && (await loginOk())) {
      log('  login and allowed hosts already set');
      return true;
    }
    const put = await api('PUT', `/config/host/${String(cur.id ?? null)}`, {
      ...cur,
      ...want,
      password: cfg.pass,
      passwordConfirmation: cfg.pass,
    });
    if (!put.ok) {
      log(`  FAIL  host config (HTTP ${httpCode(put.status)}): ${apiError(put.text)}`);
      return false;
    }
    log('  login and allowed hosts set');

    // The host filter reads allowedHosts at startup only (trap 10): until a
    // restart the app keeps enforcing the previous list. Restarting now makes
    // the list just written the one in force.
    if (drift.includes('allowedHosts')) {
      log(`  restarting ${cfg.name} so the new allowed hosts take effect`);
      await api('POST', '/system/restart');
      await deps.sleep(5000);
      if (!(await waitReady())) {
        log(`  FAIL  ${cfg.name} did not come back after the restart`);
        return false;
      }
    }
    return true;
  };

  const verifyHost = async () => {
    const r = await get('/config/host');
    if (!r.ok) {
      log(`  FAIL  read host config (HTTP ${httpCode(r.status)})`);
      return false;
    }
    const cur = r.json as JsonObject;
    const drift = hostDrift(cur, wantHost());
    let ok = true;
    if (drift.length === 0) {
      log(`  ok       host: forms login, not required locally; allowed hosts ${String(cur.allowedHosts ?? null)}`);
    } else {
      log(`  DRIFT    host: ${drift.map((k) => `${k} `).join('')}`);
      ok = false;
    }
    if (await loginOk()) log(`  ok       login as ${cfg.user}`);
    else {
      log(`  DRIFT    login as ${cfg.user} is refused`);
      ok = false;
    }
    return ok;
  };

  const byImplementation = (list: unknown, impl: string) =>
    (Array.isArray(list) ? (list as Resource[]) : []).find((x) => x.implementation === impl);

  // The secret goes in on every write, since both apps mask it on read.
  const applyResource: Servarr['applyResource'] = async ({
    label,
    endpoint,
    implementation,
    top,
    fields,
    secretName,
    secret,
  }) => {
    const r = await get(`/${endpoint}`);
    if (!r.ok) {
      log(`  FAIL  read ${label} (HTTP ${httpCode(r.status)})`);
      return false;
    }
    const cur = byImplementation(r.json, implementation);
    const withSecret = { ...fields, [secretName]: secret };
    if (!cur) {
      const s = await get(`/${endpoint}/schema`);
      if (!s.ok) {
        log(`  FAIL  ${label} schema (HTTP ${httpCode(s.status)})`);
        return false;
      }
      const base = byImplementation(s.json, implementation);
      if (!base) {
        log(`  FAIL  ${label} schema has no ${implementation}`);
        return false;
      }
      const add = await api('POST', `/${endpoint}`, resourceWant(base, top, withSecret));
      if (!add.ok) {
        log(`  FAIL  add ${label} (HTTP ${httpCode(add.status)}): ${apiError(add.text)}`);
        return false;
      }
      log(`  ${label} added`);
      return true;
    }
    const drift = resourceDrift(cur, top, fields);
    if (drift.length === 0) {
      log(`  ${label} already set`);
      return true;
    }
    const put = await api('PUT', `/${endpoint}/${String(cur.id ?? null)}`, resourceWant(cur, top, withSecret));
    if (!put.ok) {
      log(`  FAIL  update ${label} (HTTP ${httpCode(put.status)}): ${apiError(put.text)}`);
      return false;
    }
    log(`  ${label} updated (${drift.join(' ')})`);
    return true;
  };

  const verifyResource: Servarr['verifyResource'] = async ({ label, endpoint, implementation, top, fields }) => {
    const r = await get(`/${endpoint}`);
    if (!r.ok) {
      log(`  FAIL  read ${label} (HTTP ${httpCode(r.status)})`);
      return false;
    }
    const cur = byImplementation(r.json, implementation);
    if (!cur) {
      log(`  DRIFT    ${label} missing`);
      return false;
    }
    const drift = resourceDrift(cur, top, fields);
    if (drift.length > 0) {
      log(`  DRIFT    ${label}: ${drift.map((k) => `${k} `).join('')}`);
      return false;
    }
    // Tests the stored settings, secret included: the one check of the password.
    // A failing test is reported, but is not drift.
    const t = await api('POST', `/${endpoint}/test`, cur);
    if (t.ok) log(`  ok       ${label} — test passes`);
    else log(`  FAILING  ${label} — test fails: ${apiError(t.text)}`);
    return true;
  };

  return {
    api,
    get,
    waitReady,
    loginOk,
    allowedHosts,
    wantHost,
    applyHost,
    verifyHost,
    applyResource,
    verifyResource,
  };
}
