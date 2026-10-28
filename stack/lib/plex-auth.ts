// stack/lib/plex-auth.ts — signing in with a Plex account: the PIN flow Seerr
// uses, run from the server so the account's token never reaches a page.
//
//   1. createPin    plex.tv makes a strong PIN for this client (its
//                   X-Plex-Client-Identifier, a UUID stack-api keeps)
//   2. authUrl      the page the browser opens; the user signs in there and
//                   approves this client
//   3. checkPin     the PIN's authToken once they did; null until then, and a
//                   404 once the PIN expired
//   4. plexAccount  who the token belongs to
//      ownsServer   whether that account owns this server (PLEX_IDENTITY)
//
// stack-api uses the token for 4 and then drops it: it keeps a session of its
// own, never Plex credentials. The token goes in the X-Plex-Token header, never
// in a URL, and no error message here carries it.

import { is2xx, jsonOf, type Http } from './http.ts';

export const PLEX_TV = 'https://plex.tv';
export const PLEX_APP_AUTH = 'https://app.plex.tv/auth#?';
/** What plex.tv's "approve this device" page and the account's device list call it. */
export const PLEX_PRODUCT = 'pms docs';
const T_PLEX = 10_000;

export interface PlexClient {
  http: Http;
  /** This install's X-Plex-Client-Identifier. */
  clientId: string;
  /** plex.tv, unless a test points it elsewhere. */
  base?: string;
}

export type PlexResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

export interface PlexPin {
  id: number;
  code: string;
}

export interface PlexAccount {
  id: number;
  uuid: string;
  username: string;
  title: string;
}

export function plexHeaders(clientId: string, token?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/json',
    'X-Plex-Client-Identifier': clientId,
    'X-Plex-Product': PLEX_PRODUCT,
  };
  if (token) h['X-Plex-Token'] = token;
  return h;
}

const fail = (status: number, error: string) => ({ ok: false, status, error }) as const;
const why = (what: string, status: number, error?: string) =>
  status === 0 ? `${what}: plex.tv did not answer (${error ?? 'no answer'})` : `${what}: plex.tv answered ${status}`;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A new strong PIN for this client. */
export async function createPin(c: PlexClient): Promise<PlexResult<PlexPin>> {
  const r = await c.http(`${c.base ?? PLEX_TV}/api/v2/pins?strong=true`, {
    method: 'POST',
    headers: plexHeaders(c.clientId),
    timeoutMs: T_PLEX,
  });
  if (!is2xx(r.status)) return fail(r.status, why('create PIN', r.status, r.error));
  const pin = jsonOf(r);
  if (!isObj(pin) || typeof pin.id !== 'number' || typeof pin.code !== 'string')
    return fail(r.status, 'create PIN: plex.tv answered without an id and code');
  return { ok: true, value: { id: pin.id, code: pin.code } };
}

/** The plex.tv page that signs the user in and approves the PIN's code. */
export function authUrl(clientId: string, code: string): string {
  const q = new URLSearchParams({ clientID: clientId, code, 'context[device][product]': PLEX_PRODUCT });
  return `${PLEX_APP_AUTH}${q.toString()}`;
}

/** The PIN's token: null while the user has not approved it; status 404 once it expired. */
export async function checkPin(c: PlexClient, id: number): Promise<PlexResult<string | null>> {
  const r = await c.http(`${c.base ?? PLEX_TV}/api/v2/pins/${id}`, {
    headers: plexHeaders(c.clientId),
    timeoutMs: T_PLEX,
  });
  if (r.status === 404) return fail(404, 'the PIN expired');
  if (!is2xx(r.status)) return fail(r.status, why('check PIN', r.status, r.error));
  const pin = jsonOf(r);
  if (!isObj(pin)) return fail(r.status, 'check PIN: plex.tv answered something else');
  return { ok: true, value: typeof pin.authToken === 'string' && pin.authToken !== '' ? pin.authToken : null };
}

/** The account a token belongs to. */
export async function plexAccount(c: PlexClient, token: string): Promise<PlexResult<PlexAccount>> {
  const r = await c.http(`${c.base ?? PLEX_TV}/api/v2/user`, {
    headers: plexHeaders(c.clientId, token),
    timeoutMs: T_PLEX,
  });
  if (!is2xx(r.status)) return fail(r.status, why('read the account', r.status, r.error));
  const u = jsonOf(r);
  if (!isObj(u) || typeof u.id !== 'number' || typeof u.username !== 'string')
    return fail(r.status, 'read the account: plex.tv answered without an id and username');
  return {
    ok: true,
    value: {
      id: u.id,
      uuid: typeof u.uuid === 'string' ? u.uuid : '',
      username: u.username,
      title: typeof u.title === 'string' ? u.title : u.username,
    },
  };
}

/** Whether the token's account owns the server with this machineIdentifier. */
export async function ownsServer(c: PlexClient, token: string, machineId: string): Promise<PlexResult<boolean>> {
  const r = await c.http(`${c.base ?? PLEX_TV}/api/v2/resources?includeHttps=1`, {
    headers: plexHeaders(c.clientId, token),
    timeoutMs: T_PLEX,
  });
  if (!is2xx(r.status)) return fail(r.status, why('list the servers', r.status, r.error));
  const list = jsonOf(r);
  if (!Array.isArray(list)) return fail(r.status, 'list the servers: plex.tv answered something else');
  return {
    ok: true,
    value: list.some((x) => isObj(x) && x.clientIdentifier === machineId && x.owned === true),
  };
}
