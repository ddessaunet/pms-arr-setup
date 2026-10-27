// stack/lib/keys.ts — API keys that live in an app's own config, not in .env.
//
//   seerrKey    main.apiKey from /opt/appdata/seerr/settings.json (trap 12)
//   bazarrKey   auth.apikey from /opt/appdata/bazarr/config/config.yaml
//
// The same logic as seerr_api_key and bazarr_api_key in
// jobs/stack-status/stack-status.sh. Each is "" when the file or the key is missing:
// the app has not written it yet.

import { readFileSync } from 'node:fs';

function readOr(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** `.main.apiKey // empty` of settings.json text. */
export function seerrKey(json: string): string {
  let settings: unknown;
  try {
    settings = JSON.parse(json);
  } catch {
    return '';
  }
  const key = (settings as { main?: { apiKey?: unknown } } | null)?.main?.apiKey;
  if (key === undefined || key === null || key === false) return '';
  return typeof key === 'string' ? key : JSON.stringify(key);
}

/**
 * auth.apikey from config.yaml text, without a YAML parser: the first
 * `apikey:` line inside the top-level `auth:` block, which ends at the next
 * line that does not start with a space. Quotes are dropped, and only the
 * first word after `apikey:` is the key.
 */
export function bazarrKey(yaml: string): string {
  let on = false;
  for (const line of yaml.split('\n')) {
    if (line.startsWith('auth:')) {
      on = true;
      continue;
    }
    if (/^[^ ]/.test(line)) on = false;
    const words = line.split(/[ \t]+/).filter(Boolean);
    if (on && words[0] === 'apikey:') return (words[1] ?? '').replace(/["']/g, '');
  }
  return '';
}

export const readSeerrKey = (settingsPath: string) => seerrKey(readOr(settingsPath) ?? '');
export const readBazarrKey = (configPath: string) => bazarrKey(readOr(configPath) ?? '');
