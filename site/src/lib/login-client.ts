// The login page's script (components/LoginPanel.astro). Signing in is Plex's
// PIN flow, run by jobs/stack-api: ask it for a PIN, open plex.tv's page for it
// in a popup, and poll until the user approved it there. stack-api then checks
// that the account owns this Plex server and sets the session cookie itself;
// the Plex token never reaches this page.

import { el, q } from './dom.ts';
import { pinAnswer, safeNext } from './login-view.ts';

const POLL_MS = 1000;
const GIVE_UP_MS = 10 * 60_000; // plex.tv's PINs last about 15 min
const LABEL = 'Sign in with Plex';

const next = safeNext(new URLSearchParams(location.search).get('next'));
const button = q<HTMLButtonElement>('[data-login]');
const msg = q('[data-login-msg]');

function say(text: string, level = '', link?: { href: string; text: string }) {
  if (!msg) return;
  msg.dataset.level = level;
  msg.replaceChildren(text);
  if (link) {
    const a = el('a', '', link.text);
    a.href = link.href;
    a.target = '_blank';
    a.rel = 'noopener';
    msg.append(' ', a);
  }
}

function ready(on: boolean) {
  if (!button) return;
  button.disabled = !on;
  button.removeAttribute('aria-busy');
  button.textContent = LABEL;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (res: Response) => res.json().catch(() => null) as Promise<Record<string, unknown> | null>;

/** Already signed in: go on. stack-api away: say so, since nobody can sign in. */
async function init() {
  try {
    const res = await fetch('/api/auth/me', { cache: 'no-store' });
    if (res.ok) return location.replace(next);
    if (res.status === 401) {
      if (new URLSearchParams(location.search).has('next')) say('Sign in to see that page.');
      return ready(true);
    }
  } catch {
    // below
  }
  say('stack-api is not answering, so nobody can sign in right now. On the box: task stack-api:status.', 'down');
  ready(false);
}

async function signIn() {
  if (!button) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = 'Waiting for Plex…';
  say('');
  // Opened now, in the click, or the browser blocks it; it gets plex.tv's address below.
  const popup = window.open('', 'plex-sign-in', 'popup,width=600,height=720');
  try {
    const res = await fetch('/api/auth/pin', { method: 'POST' });
    const pin = await json(res);
    if (!res.ok || typeof pin?.id !== 'number' || typeof pin.authUrl !== 'string')
      throw new Error(typeof pin?.error === 'string' ? pin.error : `stack-api answered ${res.status}`);
    if (popup) popup.location.href = pin.authUrl;
    else say('The browser blocked the Plex window.', 'degraded', { href: pin.authUrl, text: 'Open it here' });

    for (const until = Date.now() + GIVE_UP_MS; Date.now() < until;) {
      await sleep(POLL_MS);
      const poll = await fetch(`/api/auth/pin/${pin.id}`, { cache: 'no-store' });
      const a = pinAnswer(poll.status, await json(poll));
      if (a.kind === 'pending' && popup?.closed) {
        say('The Plex window closed before signing in.');
        return ready(true);
      }
      if (a.kind === 'pending') continue;
      popup?.close();
      if (a.kind === 'ok') return location.replace(next);
      if (a.kind === 'denied') say(a.text, 'down');
      else if (a.kind === 'expired') say('That sign-in expired. Try again.', 'degraded');
      else say(`Could not sign in: ${a.text}`, 'down');
      return ready(true);
    }
    popup?.close();
    say('Plex never said yes. Try again.', 'degraded');
  } catch (e) {
    popup?.close();
    say(`Could not sign in: ${e instanceof Error ? e.message : String(e)}`, 'down');
  }
  ready(true);
}

button?.addEventListener('click', () => void signIn());
void init();
