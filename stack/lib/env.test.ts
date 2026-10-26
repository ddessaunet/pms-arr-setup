// stack/lib/env.test.ts — envGet keeps env_get's rules (stack/lib/servarr.sh).
// The parity cases run the bash function itself on the same .env and compare.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { envFileValue, envGet, envSeconds } from './env.ts';

const SERVARR = resolve(import.meta.dir, 'servarr.sh');
const tmp = mkdtempSync(join(tmpdir(), 'env-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function repoWith(envText: string | null): string {
  const repo = join(tmp, String(n++));
  mkdirSync(repo);
  if (envText !== null) writeFileSync(join(repo, '.env'), envText);
  return repo;
}

/** What `KEY="${KEY:-$(env_get KEY)}"` (or `${KEY-…}`) gives in bash. */
function bashGet(repo: string, key: string, env: Record<string, string>, emptyWins = false): string {
  const expand = emptyWins ? `\${${key}-$(env_get ${key})}` : `\${${key}:-$(env_get ${key})}`;
  const r = Bun.spawnSync(['bash', '-c', `REPO="$1"; . "$2"; v="${expand}"; printf '%s' "$v"`, '_', repo, SERVARR], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
  });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString();
}

describe('envFileValue', () => {
  test('the last KEY= line wins', () => expect(envFileValue('A=1\nA=2\n', 'A')).toBe('2'));
  test('a later empty line wins too', () => expect(envFileValue('A=1\nA=\n', 'A')).toBe(''));
  test('quotes are kept', () => expect(envFileValue('A="x y"\n', 'A')).toBe('"x y"'));
  test('a prefix of another key is not it', () => expect(envFileValue('AB=1\n', 'A')).toBe(''));
  test('only at the start of a line', () => expect(envFileValue('export A=1\n #A=2\n', 'A')).toBe(''));
  test('rejects a name that is not one', () => expect(() => envFileValue('', 'A.*')).toThrow());
});

// Each .env is read for every key in KEYS, with and without the variable set.
const FILES: Record<string, string | null> = {
  'no .env': null,
  empty: '',
  plain: 'A=1\nB=two words\n',
  'duplicates, last wins': 'A=1\nB=x\nA=3\n',
  'last is empty': 'A=1\nA=\n',
  quoted: `A="quoted"\nB='single'\nC="a=b"\n`,
  'equals in the value': 'A==x=y\n',
  'spaces around =': 'A =1\nB= 2 \n',
  'export and comments': 'export A=1\n#B=2\n  C=3\nB=4 # not a comment\n',
  'CRLF lines': 'A=1\r\nB=2\r\n',
  'no final newline': 'A=1\nB=2',
  prefixes: 'AB=1\nA_B=2\nA=3\n',
  'trailing spaces': 'A=x  \n',
};
const KEYS = ['A', 'B', 'C', 'A_B'];

describe('envGet matches bash env_get', () => {
  for (const [name, text] of Object.entries(FILES)) {
    test(name, () => {
      const repo = repoWith(text);
      for (const key of KEYS) {
        for (const env of [{}, { [key]: 'from-env' }, { [key]: '' }]) {
          expect({ key, env, got: envGet(key, { repo, env }) }).toEqual({ key, env, got: bashGet(repo, key, env) });
          expect({ key, env, emptyWins: envGet(key, { repo, env, emptyWins: true }) }).toEqual({
            key,
            env,
            emptyWins: bashGet(repo, key, env, true),
          });
        }
      }
    });
  }
});

describe('envGet precedence', () => {
  const repo = repoWith('A=file\n');
  test('a non-empty variable wins', () => expect(envGet('A', { repo, env: { A: 'env' } })).toBe('env'));
  test('an empty one does not', () => expect(envGet('A', { repo, env: { A: '' } })).toBe('file'));
  test('unless emptyWins', () => expect(envGet('A', { repo, env: { A: '' }, emptyWins: true })).toBe(''));
  test('unset: .env', () => expect(envGet('A', { repo, env: {} })).toBe('file'));
});

describe('envSeconds', () => {
  test('unset or empty: the default', () => {
    expect(envSeconds({}, 'T', 15)).toBe(15_000);
    expect(envSeconds({ T: '' }, 'T', 15)).toBe(15_000);
  });
  test('seconds, fractions too', () => expect(envSeconds({ T: '2.5' }, 'T', 15)).toBe(2500));
  test('not a number is an error', () => {
    expect(() => envSeconds({ T: 'abc' }, 'T', 15)).toThrow('T is not a number of seconds: abc');
    expect(() => envSeconds({ T: '-1' }, 'T', 15)).toThrow();
  });
});
