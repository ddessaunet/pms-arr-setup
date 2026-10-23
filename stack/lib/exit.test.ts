// stack/lib/exit.test.ts — what a main's outcome becomes as an exit code.

import { describe, expect, test } from 'bun:test';
import { EXIT, exitCodeOf, UsageError } from './exit.ts';

function collect() {
  const lines: string[] = [];
  return { lines, log: (l: string) => void lines.push(l) };
}

describe('exitCodeOf', () => {
  test("main's own code", async () => {
    expect(await exitCodeOf(() => 1)).toBe(1);
    expect(await exitCodeOf(async () => 0)).toBe(0);
  });

  test('a usage error is 2, with its message', async () => {
    const { lines, log } = collect();
    const code = await exitCodeOf(
      () => {
        throw new UsageError('usage: x.sh [--check]');
      },
      { log },
    );
    expect(code).toBe(EXIT.usage);
    expect(lines).toEqual(['usage: x.sh [--check]']);
  });

  test('anything else is "broken", never 1 (which is drift)', async () => {
    const { lines, log } = collect();
    const code = await exitCodeOf(
      async () => {
        throw new Error('boom');
      },
      { log },
    );
    expect(code).toBe(EXIT.broken);
    expect(lines[0]).toStartWith('error: Error: boom');
  });

  test("a job's own broken code", async () => {
    const code = await exitCodeOf(
      () => {
        throw new Error('x');
      },
      { broken: 10, log: () => {} },
    );
    expect(code).toBe(10);
  });
});
