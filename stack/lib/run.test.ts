// stack/lib/run.test.ts — exit codes, output, stdin, timeouts, as timeout(1) has them.

import { describe, expect, test } from 'bun:test';
import { run } from './run.ts';

describe('run', () => {
  test('output and exit code', async () => {
    const r = await run(['sh', '-c', 'echo out; echo err >&2; exit 3']);
    expect(r).toEqual({ code: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false });
  });

  test('argv is not a shell', async () => {
    expect((await run(['echo', '$HOME; rm -rf /'])).stdout).toBe('$HOME; rm -rf /\n');
  });

  test('stdin, then end of input', async () => {
    expect((await run(['cat'], { stdin: 'secret\n' })).stdout).toBe('secret\n');
  });

  test('without stdin it reads end of input at once', async () => {
    const r = await run(['cat'], { timeoutMs: 2000 });
    expect(r).toMatchObject({ code: 0, stdout: '', timedOut: false });
  });

  test('a timeout is 124', async () => {
    const t0 = Date.now();
    const r = await run(['sleep', '5'], { timeoutMs: 200 });
    expect(r).toMatchObject({ code: 124, timedOut: true });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test('one that ignores SIGTERM is killed', async () => {
    // exec: the timeout signals the command, not processes it started.
    const r = await run(['sh', '-c', 'trap "" TERM; exec sleep 10'], { timeoutMs: 100 });
    expect(r).toMatchObject({ code: 124, timedOut: true });
  });

  test('a missing command is 127', async () => {
    const r = await run(['/nonexistent/cmd']);
    expect(r.code).toBe(127);
    expect(r.stderr).toContain('/nonexistent/cmd');
  });

  test('killed by a signal is 128 + n', async () => {
    expect((await run(['sh', '-c', 'kill -KILL $$'])).code).toBe(137);
  });

  test('env and cwd', async () => {
    const r = await run(['sh', '-c', 'printf "%s %s" "$X" "$PWD"'], { env: { X: 'y' }, cwd: '/tmp' });
    expect(r.stdout).toBe('y /tmp');
  });
});
