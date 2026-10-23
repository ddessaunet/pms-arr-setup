// stack/lib/plex.test.ts — the token reader, against prefs_token in apps/plex/configure.sh.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { plexPrefsPath, plexTokenOf, readPlexToken } from './plex.ts';

const PLEX_CONFIGURE = resolve(import.meta.dir, '../../apps/plex/configure.sh');
const tmp = mkdtempSync(join(tmpdir(), 'plex-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function bashToken(path: string): string {
  const r = Bun.spawnSync(['bash', '-c', '. "$0" && prefs_token "$1"', PLEX_CONFIGURE, path], {
    env: { ...process.env, PLEX_CONFIGURE_LIB: '1', APPDATA: tmp },
  });
  return r.stdout.toString().replace(/\n$/, '');
}

const CASES: Record<string, string> = {
  'one line':
    '<?xml version="1.0"?>\n<Preferences MachineIdentifier="abc" PlexOnlineToken="tOkEn123" PlexOnlineUsername="u"/>\n',
  none: '<Preferences MachineIdentifier="abc"/>\n',
  'empty token': '<Preferences PlexOnlineToken="" />\n',
  'two lines: the first wins': '<a PlexOnlineToken="first"/>\n<b PlexOnlineToken="second"/>\n',
  'two on a line: the last wins': '<a PlexOnlineToken="one" PlexOnlineToken="two"/>\n',
  'empty file': '',
};

describe('plexTokenOf matches prefs_token', () => {
  let n = 0;
  for (const [name, xml] of Object.entries(CASES)) {
    test(name, () => {
      const path = join(tmp, `prefs-${n++}.xml`);
      writeFileSync(path, xml);
      expect(readPlexToken(path)).toBe(bashToken(path));
      expect(plexTokenOf(xml)).toBe(bashToken(path));
    });
  }
  test('a missing file', () => expect(readPlexToken(join(tmp, 'none.xml'))).toBe(''));
});

test('the path under APPDATA', () =>
  expect(plexPrefsPath('/opt/appdata')).toBe(
    '/opt/appdata/plex/Library/Application Support/Plex Media Server/Preferences.xml',
  ));
