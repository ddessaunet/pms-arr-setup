// Pure helpers for the sign-in: the login page (login-client.ts) and the pages
// that send a signed-out viewer there (session.ts). jobs/stack-api runs the
// sign-in; nginx sends every page there while nobody is signed in.

export const LOGIN_PATH = '/login/';

/**
 * Where to go after signing in, from ?next=: a path on this site, never
 * another host (`//evil`, `/\evil`), the login page itself, or anything with
 * control characters. Anything else is the front page.
 */
export function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if ([...raw].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return '/';
  if (raw === '/login' || raw.startsWith(LOGIN_PATH)) return '/';
  return raw;
}

/** The login page, coming back to `path` afterwards. */
export const loginUrl = (path: string) => `${LOGIN_PATH}?next=${encodeURIComponent(path)}`;

export type PinAnswer =
  | { kind: 'ok' }
  | { kind: 'pending' }
  | { kind: 'denied'; text: string }
  | { kind: 'expired' }
  | { kind: 'error'; text: string };

/** What a poll of /api/auth/pin/:id said. */
export function pinAnswer(status: number, body: unknown): PinAnswer {
  const b = (body ?? {}) as { state?: unknown; error?: unknown };
  const error = typeof b.error === 'string' ? b.error : '';
  if (status === 200 && b.state === 'ok') return { kind: 'ok' };
  if (status === 200 && b.state === 'pending') return { kind: 'pending' };
  if (status === 403) return { kind: 'denied', text: error || 'Only the owner of this Plex server can sign in.' };
  if (status === 410) return { kind: 'expired' };
  return { kind: 'error', text: error || `stack-api answered ${status}` };
}
