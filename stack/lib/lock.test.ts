// stack/lib/lock.test.ts — lock.ts and util-linux flock exclude each other on
// the same file, both ways, as bash and TypeScript jobs must while both exist.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryLock, waitLock } from './lock.ts';

const tmp = mkdtempSync(join(tmpdir(), 'lock-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const lockFile = () => join(tmp, `l${n++}.lock`);

/** `flock -n FILE true`, as the bash jobs take it: 0 got it, 1 held. */
function bashTry(path: string): number {
  return Bun.spawnSync(['flock', '-n', path, 'true']).exitCode;
}

/** A bash holder: `exec 9>FILE; flock 9`, held for ms, then gone. */
async function bashHolds(path: string, ms: number) {
  const proc = Bun.spawn(['bash', '-c', `exec 9>"$0"; flock 9 && echo held && sleep ${ms / 1000}`, path], {
    stdout: 'pipe',
  });
  const reader = proc.stdout.getReader();
  await reader.read(); // "held"
  reader.releaseLock();
  return proc;
}

describe('against util-linux flock', () => {
  test('held here: bash cannot take it, then can after release', () => {
    const path = lockFile();
    const lock = tryLock(path);
    expect(lock).not.toBeNull();
    expect(bashTry(path)).toBe(1);
    lock?.release();
    expect(bashTry(path)).toBe(0);
  });

  test('held by bash: tryLock is null, then succeeds once it is gone', async () => {
    const path = lockFile();
    const holder = await bashHolds(path, 500);
    expect(tryLock(path)).toBeNull();
    await holder.exited;
    const lock = tryLock(path);
    expect(lock).not.toBeNull();
    lock?.release();
  });

  test('waitLock waits for bash to let go (flock -w)', async () => {
    const path = lockFile();
    const holder = await bashHolds(path, 400);
    const t0 = Date.now();
    const lock = await waitLock(path, 5000, 50);
    expect(lock).not.toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
    lock?.release();
    await holder.exited;
  });

  test('waitLock gives up at the deadline', async () => {
    const path = lockFile();
    const holder = await bashHolds(path, 3000);
    const t0 = Date.now();
    expect(await waitLock(path, 300, 50)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1500);
    holder.kill();
    await holder.exited;
  });

  test('bash flock -w waits for a TypeScript holder', async () => {
    const path = lockFile();
    const lock = tryLock(path);
    setTimeout(() => lock?.release(), 300);
    const waiter = Bun.spawn(['flock', '-w', '5', path, 'true']);
    expect(await waiter.exited).toBe(0);
  });
});

describe('in one process', () => {
  test('a second open of the same file is excluded too (flock is per open file)', () => {
    const path = lockFile();
    const a = tryLock(path);
    expect(tryLock(path)).toBeNull();
    a?.release();
    const b = tryLock(path);
    expect(b).not.toBeNull();
    b?.release();
  });

  test('release twice is harmless', () => {
    const lock = tryLock(lockFile());
    lock?.release();
    expect(() => lock?.release()).not.toThrow();
  });

  test('a lock file that cannot be opened throws', () => {
    expect(() => tryLock(join(tmp, 'no/such/dir/x.lock'))).toThrow();
  });
});
