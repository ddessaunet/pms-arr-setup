// jobs/stack-api/app.ts — stack-api's routes (Hono). stack-api.ts serves them on
// the socket nginx proxies /api/ to; tests call app.request() directly.
//
//   GET  /api/health          no session needed: "is stack-api up", for the login page
//   GET  /api/auth/check      204 signed in, 401 not: nginx's auth_request asks this
//                             before serving any page or /live/ file
//   GET  /api/auth/me         who is signed in
//   POST /api/auth/pin        start a Plex sign-in: { id, authUrl }
//   GET  /api/auth/pin/:id    poll it: pending · expired · denied (not the owner) ·
//                             ok, which sets the session cookie
//   POST /api/auth/logout     end the session
//   everything else under /api/ needs a session (401 without one): the
//   request doctor's routes (requests.ts) are added by stack-api.ts
//
// Only the account that owns this Plex server (PLEX_IDENTITY) gets a session.
// The Plex token is used to find out who that is and then dropped. Cookies
// and tokens are never logged. A non-GET request from another origin is
// refused (hono/csrf), and every answer is no-store.

import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import { secureHeaders } from 'hono/secure-headers';
import type { Http } from '../../stack/lib/http.ts';
import type { Log } from '../../stack/lib/log.ts';
import { authUrl, checkPin, createPin, ownsServer, plexAccount, type PlexClient } from '../../stack/lib/plex-auth.ts';
import type { Session, Store } from './store.ts';

export const SESSION_COOKIE = 'pms_session';
export const SESSION_TTL = 30 * 24 * 3600_000; // ms
export const PIN_TTL = 15 * 60_000; // ms: plex.tv's strong PINs last about as long
const TOUCH_EVERY = 60_000; // ms between lastSeen writes for one session

export interface AppDeps {
  http: Http;
  store: Store;
  /** Epoch milliseconds. */
  now: () => number;
  log: Log;
  /** The Plex server whose owner may sign in. */
  serverId: string;
  /** n random bytes. */
  random: (n: number) => Uint8Array;
  /** plex.tv, unless a test points it elsewhere. */
  plexBase?: string;
}

export type Env = { Variables: { session: Session; token: string } };

/** A sliding-window limit per key: allow() is false once `max` calls fell in the last `windowMs`. */
export class RateLimit {
  private seen = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  allow(key: string, now: number): boolean {
    const recent = (this.seen.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (recent.length >= this.max) {
      this.seen.set(key, recent);
      return false;
    }
    recent.push(now);
    this.seen.set(key, recent);
    return true;
  }
}

const base64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');
/** The browser's address, as nginx passes it (the socket itself has none). */
export const clientIp = (c: Context) => c.req.header('x-real-ip') ?? 'local';

/** The session the request's cookie opens, or null. */
export function sessionOf(c: Context, d: AppDeps): { token: string; session: Session } | null {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const session = d.store.session(token, d.now());
  return session ? { token, session } : null;
}

export function makeApp(d: AppDeps): Hono<Env> {
  const app = new Hono<Env>();
  const plex = (): PlexClient => ({ http: d.http, clientId: d.store.clientId(), base: d.plexBase });
  const pinStarts = new RateLimit(10, 10 * 60_000);
  const pinPolls = new RateLimit(600, 10 * 60_000);

  app.use('/api/*', secureHeaders({ crossOriginResourcePolicy: 'same-origin' }));
  app.use('/api/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.use('/api/*', csrf());

  // The gate. Public: health and the sign-in itself; everything else needs a session.
  app.use('/api/*', async (c, next) => {
    const path = c.req.path;
    if (path === '/api/health' || path.startsWith('/api/auth/')) return next();
    const s = sessionOf(c, d);
    if (!s) return c.json({ error: 'signed out' }, 401);
    c.set('session', s.session);
    c.set('token', s.token);
    return next();
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.get('/api/auth/check', (c) => {
    const s = sessionOf(c, d);
    if (!s) return c.body(null, 401);
    const now = d.now();
    if (now - s.session.lastSeen > TOUCH_EVERY) d.store.touchSession(s.token, now);
    return c.body(null, 204);
  });

  app.get('/api/auth/me', (c) => {
    const s = sessionOf(c, d);
    if (!s) return c.json({ error: 'signed out' }, 401);
    return c.json({ username: s.session.username, expires: new Date(s.session.expires).toISOString() });
  });

  app.post('/api/auth/pin', async (c) => {
    if (!pinStarts.allow(clientIp(c), d.now()))
      return c.json({ error: 'too many sign-in attempts; wait a few minutes' }, 429);
    const p = plex();
    const pin = await createPin(p);
    if (!pin.ok) {
      d.log(`sign-in: ${pin.error}`);
      return c.json({ error: 'plex.tv did not answer; try again' }, 502);
    }
    d.store.addPin(pin.value.id, d.now());
    return c.json({ id: pin.value.id, authUrl: authUrl(p.clientId, pin.value.code) });
  });

  app.get('/api/auth/pin/:id', async (c) => {
    const now = d.now();
    if (!pinPolls.allow(clientIp(c), now)) return c.json({ error: 'too many requests' }, 429);
    const id = Number(c.req.param('id'));
    const created = Number.isSafeInteger(id) ? d.store.pinCreated(id) : null;
    if (created === null || now - created > PIN_TTL) return c.json({ state: 'expired' }, 410);
    const p = plex();
    const pin = await checkPin(p, id);
    if (!pin.ok) {
      if (pin.status === 404) {
        d.store.dropPin(id);
        return c.json({ state: 'expired' }, 410);
      }
      d.log(`sign-in: ${pin.error}`);
      return c.json({ error: 'plex.tv did not answer; try again' }, 502);
    }
    if (pin.value === null) return c.json({ state: 'pending' });

    // Approved: the token is good for this one check, then gone.
    d.store.dropPin(id);
    const token = pin.value;
    const [account, owns] = await Promise.all([plexAccount(p, token), ownsServer(p, token, d.serverId)]);
    if (!account.ok || !owns.ok) {
      d.log(`sign-in: ${!account.ok ? account.error : !owns.ok ? owns.error : ''}`);
      return c.json({ error: 'plex.tv did not answer; try again' }, 502);
    }
    if (!owns.value) {
      d.log(`sign-in refused: ${account.value.username} does not own this Plex server`);
      return c.json({ state: 'denied', error: 'Only the owner of this Plex server can sign in.' }, 403);
    }
    const session = base64url(d.random(32));
    d.store.addSession(session, account.value, now, SESSION_TTL);
    setCookie(c, SESSION_COOKIE, session, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_TTL / 1000,
    });
    d.log(`signed in: ${account.value.username}`);
    return c.json({ state: 'ok', username: account.value.username });
  });

  app.post('/api/auth/logout', (c) => {
    const s = sessionOf(c, d);
    if (s) {
      d.store.dropSession(s.token);
      d.log(`signed out: ${s.session.username}`);
    }
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.body(null, 204);
  });

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((e, c) => {
    // HTTPException carries its own answer (csrf's 403).
    if ('getResponse' in e && typeof e.getResponse === 'function') return e.getResponse() as Response;
    d.log(`error: ${c.req.method} ${c.req.path}: ${e instanceof Error ? e.message : String(e)}`);
    return c.json({ error: 'stack-api failed; see its journal' }, 500);
  });
  return app;
}
