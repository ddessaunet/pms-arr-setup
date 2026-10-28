// stack/lib/env.test.ts — envGet keeps the rules of the bash scripts' env_get.
// The values in FILES are what env_get gave on the same .env, recorded before
// the last bash copy (stack/lib/servarr.sh) was deleted.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envFileValue, envGet, envSeconds } from './env.ts';

const tmp = mkdtempSync(join(tmpdir(), 'env-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function repoWith(envText: string | null): string {
  const repo = join(tmp, String(n++));
  mkdirSync(repo);
  if (envText !== null) writeFileSync(join(repo, '.env'), envText);
  return repo;
}

describe('envFileValue', () => {
  test('the last KEY= line wins', () => expect(envFileValue('A=1\nA=2\n', 'A')).toBe('2'));
  test('a later empty line wins too', () => expect(envFileValue('A=1\nA=\n', 'A')).toBe(''));
  test('quotes are kept', () => expect(envFileValue('A="x y"\n', 'A')).toBe('"x y"'));
  test('a prefix of another key is not it', () => expect(envFileValue('AB=1\n', 'A')).toBe(''));
  test('only at the start of a line', () => expect(envFileValue('export A=1\n #A=2\n', 'A')).toBe(''));
  test('rejects a name that is not one', () => expect(() => envFileValue('', 'A.*')).toThrow());
});

// Each .env, and what bash's env_get read from it for each key. With the
// variable set it wins; set but empty, .env wins unless emptyWins (`${KEY-…}`).
const FILES: Record<string, [string | null, Record<string, string>]> = {
  'no .env': [null, {}],
  empty: ['', {}],
  plain: ['A=1\nB=two words\n', { A: '1', B: 'two words' }],
  'duplicates, last wins': ['A=1\nB=x\nA=3\n', { A: '3', B: 'x' }],
  'last is empty': ['A=1\nA=\n', {}],
  quoted: [`A="quoted"\nB='single'\nC="a=b"\n`, { A: '"quoted"', B: "'single'", C: '"a=b"' }],
  'equals in the value': ['A==x=y\n', { A: '=x=y' }],
  'spaces around =': ['A =1\nB= 2 \n', { B: ' 2 ' }],
  'export and comments': ['export A=1\n#B=2\n  C=3\nB=4 # not a comment\n', { B: '4 # not a comment' }],
  'CRLF lines': ['A=1\r\nB=2\r\n', { A: '1\r', B: '2\r' }],
  'no final newline': ['A=1\nB=2', { A: '1', B: '2' }],
  prefixes: ['AB=1\nA_B=2\nA=3\n', { A: '3', A_B: '2' }],
  'trailing spaces': ['A=x  \n', { A: 'x  ' }],
};
const KEYS = ['A', 'B', 'C', 'A_B'];

describe('envGet reads as bash env_get did', () => {
  for (const [name, [text, values]] of Object.entries(FILES)) {
    test(name, () => {
      const repo = repoWith(text);
      for (const key of KEYS) {
        const file = values[key] ?? '';
        const got = (env: Record<string, string>, emptyWins = false) => envGet(key, { repo, env, emptyWins });
        expect({ key, got: [got({}), got({ [key]: 'from-env' }), got({ [key]: '' })] }).toEqual({
          key,
          got: [file, 'from-env', file],
        });
        expect({ key, emptyWins: [got({}, true), got({ [key]: 'from-env' }, true), got({ [key]: '' }, true)] }).toEqual(
          {
            key,
            emptyWins: [file, 'from-env', ''],
          },
        );
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
