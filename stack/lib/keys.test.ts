// stack/lib/keys.test.ts — seerrKey against stack-status.sh's seerr_api_key,
// and bazarrKey against bazarr_key, run from apps/bazarr/configure.sh.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bazarrKey, readBazarrKey, readSeerrKey, seerrKey } from './keys.ts';

const APPS = resolve(import.meta.dir, '../../apps');
const tmp = mkdtempSync(join(tmpdir(), 'keys-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** fn from the app's configure.sh, sourced with its LIB guard, on a file. */
function bash(app: string, guard: string, fn: string, path: string): string {
  const r = Bun.spawnSync(
    ['bash', '-c', `. "$0" >/dev/null 2>&1 && ${fn} "$1"`, join(APPS, app, 'configure.sh'), path],
    {
      env: { ...process.env, [guard]: '1', APPDATA: tmp },
    },
  );
  return r.stdout.toString().replace(/\n$/, '');
}

/** seerr_api_key from jobs/stack-status/stack-status.sh, on a file standing in for settings.json. */
function stackStatusSeerrKey(path: string): string {
  const src = readFileSync(resolve(import.meta.dir, '../../jobs/stack-status/stack-status.sh'), 'utf8');
  const fn = /^seerr_api_key\(\) \{\n[\s\S]*?\n\}$/m.exec(src)?.[0];
  if (!fn) throw new Error('no seerr_api_key in stack-status.sh');
  const dir = mkdtempSync(join(tmp, 'appdata-'));
  mkdirSync(join(dir, 'seerr'));
  writeFileSync(join(dir, 'seerr/settings.json'), readFileSync(path));
  const r = Bun.spawnSync(['bash', '-c', `${fn}\nseerr_api_key`], { env: { ...process.env, APPDATA: dir } });
  return r.stdout.toString().replace(/\n$/, '');
}

let n = 0;
function file(text: string): string {
  const path = join(tmp, `f${n++}`);
  writeFileSync(path, text);
  return path;
}

const SEERR: Record<string, string> = {
  'the key': '{"clientId":"c","main":{"apiKey":"MTc1abc==","applicationTitle":"Seerr"}}',
  'no main': '{"clientId":"c"}',
  'null key': '{"main":{"apiKey":null}}',
  'empty key': '{"main":{"apiKey":""}}',
  'a number': '{"main":{"apiKey":42}}',
  'not JSON': '{"main":',
  'a JSON string': '"main"',
};

describe("seerrKey matches stack-status's seerr_api_key", () => {
  for (const [name, json] of Object.entries(SEERR)) {
    test(name, () => {
      const path = file(json);
      expect(seerrKey(json)).toBe(stackStatusSeerrKey(path));
    });
  }
  test('a missing file', () => expect(readSeerrKey(join(tmp, 'none'))).toBe(''));
});

const BAZARR: Record<string, string> = {
  'the key': 'general:\n  ip: 0.0.0.0\nauth:\n  apikey: 0123abcd\n  type: form\n',
  quoted: "auth:\n  apikey: '0123abcd'\n",
  'double-quoted': 'auth:\n  apikey: "0123abcd"\n',
  'a comment after it': 'auth:\n  apikey: abc # set by bazarr\n',
  'apikey elsewhere first': 'plex:\n  apikey: plexkey\nauth:\n  apikey: authkey\n',
  'only elsewhere': 'plex:\n  apikey: plexkey\nauth:\n  type: form\n',
  'block ended by a top-level key': 'auth:\n  type: form\ngeneral:\n  apikey: nope\n',
  'a blank line in the block': 'auth:\n  type: form\n\n  apikey: still\n',
  'a tab-indented line ends it': 'auth:\n\tapikey: tabbed\n',
  'empty value': 'auth:\n  apikey:\n',
  'no space after the colon': 'auth:\n  apikey:abc\n',
  'auth: inline': 'auth: {}\n  apikey: x\n',
  nothing: '',
};

describe('bazarrKey matches bazarr_key', () => {
  for (const [name, yaml] of Object.entries(BAZARR)) {
    test(name, () => {
      const path = file(yaml);
      expect(bazarrKey(yaml)).toBe(bash('bazarr', 'BAZARR_CONFIGURE_LIB', 'bazarr_key', path));
    });
  }
  test('the key', () => expect(bazarrKey(BAZARR['the key'] ?? '')).toBe('0123abcd'));
  test('a missing file', () => expect(readBazarrKey(join(tmp, 'none'))).toBe(''));
});
