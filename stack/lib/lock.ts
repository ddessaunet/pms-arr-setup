// stack/lib/lock.ts — flock(2) on a lock file, shared with the bash scripts.
//
// The bash jobs take their locks with util-linux flock on an open file
// (`exec 9>"$LOCK"; flock -n 9`). This takes the same kind of lock on the same
// file, through libc, so while bash and TypeScript versions of a job both
// exist, each excludes the other (lock.test.ts proves it both ways). A lock
// lives as long as its file descriptor: release() closes it, and so does the
// process ending.
//
//   tryLock(path)              now, or null when someone else holds it
//   waitLock(path, timeoutMs)  as flock -w: retries until the deadline, then null

import { dlopen, FFIType, read } from 'bun:ffi';
import { closeSync, openSync } from 'node:fs';

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const EWOULDBLOCK = 11;
const EINTR = 4;

let libc: ReturnType<typeof openLibc> | undefined;
function openLibc() {
  return dlopen('libc.so.6', {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  }).symbols;
}

/** 0 locked · EWOULDBLOCK held elsewhere · another errno on a real error. */
function flock(fd: number, op: number): number {
  libc ??= openLibc();
  for (;;) {
    if (libc.flock(fd, op) === 0) return 0;
    const ptr = libc.__errno_location();
    const errno = ptr === null ? -1 : read.i32(ptr);
    if (errno !== EINTR) return errno;
  }
}

export interface Lock {
  readonly path: string;
  release(): void;
}

/** The lock now, or null when it is held. Throws when the file cannot be opened or locked at all. */
export function tryLock(path: string): Lock | null {
  // Append, as `exec 9>>"$LOCK"`: opening never truncates what a holder wrote.
  const fd = openSync(path, 'a');
  const errno = flock(fd, LOCK_EX | LOCK_NB);
  if (errno !== 0) {
    closeSync(fd);
    if (errno === EWOULDBLOCK) return null;
    throw new Error(`flock ${path}: errno ${errno}`);
  }
  let held = true;
  return {
    path,
    release() {
      if (!held) return;
      held = false;
      flock(fd, LOCK_UN);
      closeSync(fd);
    },
  };
}

/** The lock, waiting up to timeoutMs for its holder; null if it is still held then. */
export async function waitLock(path: string, timeoutMs: number, pollMs = 100): Promise<Lock | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lock = tryLock(path);
    if (lock || Date.now() >= deadline) return lock;
    await Bun.sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}
