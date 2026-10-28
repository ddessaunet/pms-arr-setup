// stack/lib/plex.test.ts — the token reader. The expected values are what the
// bash scripts' sed returned (`plex_token` in update-stack.sh, as in
// apps/plex/configure.sh before it), recorded before update-stack.sh, its last
// user, was ported (step 6).

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plexPrefsPath, plexTokenOf, readPlexToken } from './plex.ts';

const tmp = mkdtempSync(join(tmpdir(), 'plex-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const CASES: Record<string, [xml: string, want: string]> = {
  'one line': [
    '<?xml version="1.0"?>\n<Preferences MachineIdentifier="abc" PlexOnlineToken="tOkEn123" PlexOnlineUsername="u"/>\n',
    'tOkEn123',
  ],
  none: ['<Preferences MachineIdentifier="abc"/>\n', ''],
  'empty token': ['<Preferences PlexOnlineToken="" />\n', ''],
  'two lines: the first wins': ['<a PlexOnlineToken="first"/>\n<b PlexOnlineToken="second"/>\n', 'first'],
  'two on a line: the last wins': ['<a PlexOnlineToken="one" PlexOnlineToken="two"/>\n', 'two'],
  'an empty one first: still the first': ['<a PlexOnlineToken=""/>\n<b PlexOnlineToken="real"/>\n', ''],
  'empty file': ['', ''],
};

describe('plexTokenOf', () => {
  let n = 0;
  for (const [name, [xml, want]] of Object.entries(CASES)) {
    test(name, () => {
      const path = join(tmp, `prefs-${n++}.xml`);
      writeFileSync(path, xml);
      expect(plexTokenOf(xml)).toBe(want);
      expect(readPlexToken(path)).toBe(want);
    });
  }
  test('a missing file', () => expect(readPlexToken(join(tmp, 'none.xml'))).toBe(''));
});

test('the path under APPDATA', () =>
  expect(plexPrefsPath('/opt/appdata')).toBe(
    '/opt/appdata/plex/Library/Application Support/Plex Media Server/Preferences.xml',
  ));
