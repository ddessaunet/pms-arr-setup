// stack/lib/qbittorrent.ts — the login to the :8081 qBittorrent, and a session on it.
//
// One rule, where the bash scripts had three copies: a login worked when the
// answer is 204 (5.2 and later, empty body) or 200 with the body "Ok." (up to
// 5.1). Anything else is a refusal (5.2: 401; earlier: 200 "Fails.").
//
// No retry after a refusal. qBittorrent bans an address after a few failed
// logins, and every container reaches it from the same docker bridge address:
// a loop here would lock arr-reclaim and Radarr/Sonarr out too (trap 19).
//
// No cookie jar: the session cookie (SID) from the login is sent back by hand,
// with the Referer its CSRF check wants. The password goes in the body.

import type { Http, HttpResponse } from './http.ts';

/** A login worked: 204, or 200 "Ok.". */
export function qbtLoginOk(status: number, body: string): boolean {
  return status === 204 || (status === 200 && body === 'Ok.');
}

/** The cookies a response sets, as one Cookie header value ("SID=…"). */
export function cookiesOf(headers: Headers): string {
  return headers
    .getSetCookie()
    .map((c) => c.split(';', 1)[0]?.trim() ?? '')
    .filter((c) => c.includes('='))
    .join('; ');
}

export interface QbtSession {
  /** GET a path (/api/v2/...). */
  get(path: string): Promise<HttpResponse>;
  /** POST a form to a path. */
  post(path: string, form: Record<string, string>): Promise<HttpResponse>;
}

export type QbtLogin =
  | { kind: 'ok'; session: QbtSession }
  /** It answered, and said no (or something that is not a yes). */
  | { kind: 'refused'; status: number; body: string }
  /** No answer: down, or too slow. */
  | { kind: 'unreachable'; error: string };

export interface QbtConfig {
  /** http://127.0.0.1:8081 */
  url: string;
  user: string;
  pass: string;
  timeoutMs: number;
}

/** Logs in once. */
export async function qbtLogin(http: Http, cfg: QbtConfig): Promise<QbtLogin> {
  const r = await http(`${cfg.url}/api/v2/auth/login`, {
    method: 'POST',
    headers: { Referer: cfg.url },
    body: new URLSearchParams({ username: cfg.user, password: cfg.pass }),
    timeoutMs: cfg.timeoutMs,
  });
  if (r.status === 0) return { kind: 'unreachable', error: r.error ?? 'no answer' };
  if (!qbtLoginOk(r.status, r.text)) return { kind: 'refused', status: r.status, body: r.text };

  const headers = (): Record<string, string> => {
    const h: Record<string, string> = { Referer: cfg.url };
    if (cookie) h.Cookie = cookie;
    return h;
  };
  const cookie = cookiesOf(r.headers);
  return {
    kind: 'ok',
    session: {
      get: (path) => http(`${cfg.url}${path}`, { headers: headers(), timeoutMs: cfg.timeoutMs }),
      post: (path, form) =>
        http(`${cfg.url}${path}`, {
          method: 'POST',
          headers: headers(),
          body: new URLSearchParams(form),
          timeoutMs: cfg.timeoutMs,
        }),
    },
  };
}
