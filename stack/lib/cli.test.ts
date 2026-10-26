// stack/lib/cli.test.ts — flags, positionals, usage errors, help from the header.

import { describe, expect, test } from 'bun:test';
import { headerHelp, parseCli } from './cli.ts';
import { UsageError } from './exit.ts';

const spec = { flags: ['--check', '--dry-run'] as const, usage: 'usage: x.sh [--check] [--dry-run]' };

describe('parseCli', () => {
  test('nothing', () =>
    expect(parseCli([], spec)).toEqual({
      help: false,
      flags: { '--check': false, '--dry-run': false },
      positionals: [],
    }));

  test('flags', () => expect(parseCli(['--dry-run'], spec).flags).toEqual({ '--check': false, '--dry-run': true }));

  test('help', () => {
    expect(parseCli(['-h'], spec).help).toBe(true);
    expect(parseCli(['--help'], spec).help).toBe(true);
  });

  test('an unknown flag is a usage error', () => {
    expect(() => parseCli(['--chek'], spec)).toThrow(UsageError);
    expect(() => parseCli(['--chek'], spec)).toThrow('usage: x.sh [--check] [--dry-run]');
  });

  test('a word, unless positionals are taken', () => {
    expect(() => parseCli(['plex'], spec)).toThrow(UsageError);
    expect(parseCli(['plex', '--dry-run', 'seerr'], { ...spec, positionals: true }).positionals).toEqual([
      'plex',
      'seerr',
    ]);
  });
});

describe('headerHelp', () => {
  test('the leading comment, markers off, up to the first other line', () => {
    const src = "// x.ts — does x.\n//\n//   x.sh --check\n\nimport y from './y.ts';\n// not this\n";
    expect(headerHelp(src)).toBe('x.ts — does x.\n\n  x.sh --check');
  });
});
