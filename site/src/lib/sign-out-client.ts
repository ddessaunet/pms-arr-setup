// The header's "Sign out" button (components/overrides/SocialIcons.astro):
// stack-api drops the session and its cookie, then the login page.

import { qa } from './dom.ts';
import { LOGIN_PATH } from './login-view.ts';

async function signOut(button: HTMLButtonElement) {
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } finally {
    location.assign(LOGIN_PATH);
  }
}

for (const b of qa<HTMLButtonElement>('[data-sign-out]')) b.addEventListener('click', () => void signOut(b));
