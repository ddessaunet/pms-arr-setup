// stack/lib/run.test.ts — exit codes, output, stdin, timeouts, as timeout(1) has them.

import { describe, expect, test } from 'bun:test';
import { lines, run, TIMEOUT } from './run.ts';

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

describe('lines', () => {
  test('each line as it comes, then the end', async () => {
    const src = lines(['sh', '-c', 'echo one; echo "two  words"; sleep 0.2; printf "three\\npartial"']);
    expect(await src.next(2000)).toBe('one');
    expect(await src.next(2000)).toBe('two  words');
    expect(await src.next(2000)).toBe('three');
    expect(await src.next(2000)).toBeNull(); // a last line without a newline is dropped, as read does
    expect(await src.next(2000)).toBeNull();
  });

  test('no line in time is TIMEOUT, and the line still comes after', async () => {
    const src = lines(['sh', '-c', 'sleep 0.3; echo late']);
    expect(await src.next(50)).toBe(TIMEOUT);
    expect(await src.next(2000)).toBe('late');
  });

  test('close stops the command', async () => {
    const src = lines(['sleep', '30']);
    const t0 = Date.now();
    src.close();
    expect(await src.next(5000)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test('a missing command ends at once', async () => {
    expect(await lines(['/nonexistent/cmd']).next(5000)).toBeNull();
  });
});
