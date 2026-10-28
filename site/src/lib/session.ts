// For every page's client script: a 401 from /live/ or /api/ means the session
// ended (expired, or signed out in another tab), so go to the login page and
// come back here afterwards. nginx sends a signed-out page load there itself;
// this is for a page already open.

import { loginUrl } from './login-view.ts';

/** True, and on the way to the login page, when the answer says the session is gone. */
export function signInIfSignedOut(res: Response): boolean {
  if (res.status !== 401) return false;
  location.assign(loginUrl(location.pathname + location.search));
  return true;
}
