// stack/lib/keys.test.ts — seerrKey and bazarrKey on every shape of file seen or
// guessed. The expected values are what the bash readers they replace returned
// (jq's `.main.apiKey // empty`, and an awk over the auth: block), recorded
// before stack-status.sh, their last user, was ported (step 4).

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bazarrKey, readBazarrKey, readSeerrKey, seerrKey } from './keys.ts';

const tmp = mkdtempSync(join(tmpdir(), 'keys-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const SEERR: Record<string, [json: string, want: string]> = {
  'the key': ['{"clientId":"c","main":{"apiKey":"MTc1abc==","applicationTitle":"Seerr"}}', 'MTc1abc=='],
  'no main': ['{"clientId":"c"}', ''],
  'null key': ['{"main":{"apiKey":null}}', ''],
  'empty key': ['{"main":{"apiKey":""}}', ''],
  'a number': ['{"main":{"apiKey":42}}', '42'],
  'not JSON': ['{"main":', ''],
  'a JSON string': ['"main"', ''],
};

describe('seerrKey', () => {
  for (const [name, [json, want]] of Object.entries(SEERR)) test(name, () => expect(seerrKey(json)).toBe(want));
  test('read from a file', () => {
    writeFileSync(join(tmp, 'settings.json'), SEERR['the key']![0]);
    expect(readSeerrKey(join(tmp, 'settings.json'))).toBe('MTc1abc==');
  });
  test('a missing file', () => expect(readSeerrKey(join(tmp, 'none'))).toBe(''));
});

const BAZARR: Record<string, [yaml: string, want: string]> = {
  'the key': ['general:\n  ip: 0.0.0.0\nauth:\n  apikey: 0123abcd\n  type: form\n', '0123abcd'],
  quoted: ["auth:\n  apikey: '0123abcd'\n", '0123abcd'],
  'double-quoted': ['auth:\n  apikey: "0123abcd"\n', '0123abcd'],
  'a comment after it': ['auth:\n  apikey: abc # set by bazarr\n', 'abc'],
  'apikey elsewhere first': ['plex:\n  apikey: plexkey\nauth:\n  apikey: authkey\n', 'authkey'],
  'only elsewhere': ['plex:\n  apikey: plexkey\nauth:\n  type: form\n', ''],
  'block ended by a top-level key': ['auth:\n  type: form\ngeneral:\n  apikey: nope\n', ''],
  'a blank line in the block': ['auth:\n  type: form\n\n  apikey: still\n', 'still'],
  'a tab-indented line ends it': ['auth:\n\tapikey: tabbed\n', ''],
  'empty value': ['auth:\n  apikey:\n', ''],
  'no space after the colon': ['auth:\n  apikey:abc\n', ''],
  'auth: inline': ['auth: {}\n  apikey: x\n', 'x'],
  nothing: ['', ''],
};

describe('bazarrKey', () => {
  for (const [name, [yaml, want]] of Object.entries(BAZARR)) test(name, () => expect(bazarrKey(yaml)).toBe(want));
  test('read from a file', () => {
    writeFileSync(join(tmp, 'config.yaml'), BAZARR['the key']![0]);
    expect(readBazarrKey(join(tmp, 'config.yaml'))).toBe('0123abcd');
  });
  test('a missing file', () => expect(readBazarrKey(join(tmp, 'none'))).toBe(''));
});
