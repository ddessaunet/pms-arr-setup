// stack/lib/plex.ts — the Plex server's identity, and its own token from Preferences.xml.
//
// Nothing to keep in sync, and it is the admin token /status/sessions needs.
// The same match as the bash scripts' sed: the first line that has
// PlexOnlineToken="…" (the last such attribute on that line). It goes in the
// X-Plex-Token header, never in a URL.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The live server's machineIdentifier (CLAUDE.md trap 4): a container that
 * answers with another one started on a fresh config. stack-status checks it,
 * and stack-api signs in only the account that owns it.
 */
export const PLEX_IDENTITY = 'f3860770aca2ec05cf2566b02ff81a83d4dbb157';

/** Where Preferences.xml is under APPDATA. */
export function plexPrefsPath(appdata: string): string {
  return join(appdata, 'plex/Library/Application Support/Plex Media Server/Preferences.xml');
}

/** PlexOnlineToken from Preferences.xml text; "" when there is none. */
export function plexTokenOf(xml: string): string {
  for (const line of xml.split('\n')) {
    const m = /.*PlexOnlineToken="([^"]*)"/.exec(line);
    if (m) return m[1] ?? '';
  }
  return '';
}

/** The token from the file; "" when it is missing or unreadable. */
export function readPlexToken(prefsPath: string): string {
  try {
    return plexTokenOf(readFileSync(prefsPath, 'utf8'));
  } catch {
    return '';
  }
}
