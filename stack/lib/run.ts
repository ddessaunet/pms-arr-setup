// stack/lib/run.ts — runs an external command: the one place that spawns one.
//
// Not Bun.$: that is a shell of its own, throws on a non-zero exit and has no
// timeout. Here argv goes straight to execve, nothing throws, and the result
// says what happened in the terms the bash scripts used:
//   code 124   timed out (as timeout(1) reports it); SIGTERM, then SIGKILL 2 s later.
//              Only the command is signalled, not what it started: a shell
//              wrapper must `exec` its last command, or a child holding the
//              output open keeps run() waiting.
//   code 127   the command does not exist
//   128 + n    killed by signal n
// Secrets go in through stdin, never argv (argv is visible in ps).
//
// lines() is the other way in, for a command that runs for good (inotifywait
// -m): its stdout one line at a time, as it comes, each read with a timeout,
// as bash's `read -t`.

import { constants } from 'node:os';
import { err } from './log.ts';

export interface RunOptions {
  /** Kill it after this long (default: never). */
  timeoutMs?: number;
  /** Written to its stdin, which is then closed. Without it, stdin is /dev/null. */
  stdin?: string | Uint8Array;
  /** The whole environment (default: this process's). */
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type Run = (argv: readonly string[], opts?: RunOptions) => Promise<RunResult>;

const KILL_GRACE_MS = 2000;

export const run: Run = async (argv, opts = {}) => {
  let proc: Bun.Subprocess<'pipe' | 'ignore', 'pipe', 'pipe'>;
  try {
    proc = Bun.spawn([...argv], {
      stdin: opts.stdin === undefined ? 'ignore' : 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: opts.env ?? process.env,
      cwd: opts.cwd,
    });
  } catch (e) {
    return { code: 127, stdout: '', stderr: `${argv[0]}: ${(e as Error).message}`, timedOut: false };
  }
  if (opts.stdin !== undefined && proc.stdin) {
    const sink = proc.stdin as Bun.FileSink;
    sink.write(opts.stdin);
    await sink.end();
  }

  let timedOut = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  if (opts.timeoutMs !== undefined) {
    timers.push(
      setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        timers.push(setTimeout(() => proc.kill('SIGKILL'), KILL_GRACE_MS));
      }, opts.timeoutMs),
    );
  }
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    let code = exit;
    if (timedOut) code = 124;
    else if (proc.signalCode) code = 128 + (constants.signals[proc.signalCode as keyof typeof constants.signals] ?? 0);
    return { code, stdout, stderr, timedOut };
  } finally {
    for (const t of timers) clearTimeout(t);
  }
};

/** What LineSource.next gives when no line came in time. */
export const TIMEOUT = Symbol('timeout');

/** A running command's stdout, line by line. */
export interface LineSource {
  /** The next line, without its newline; TIMEOUT when none came within timeoutMs; null at the end. */
  next(timeoutMs: number): Promise<string | typeof TIMEOUT | null>;
  /** Stops the command. */
  close(): void;
}

export type Lines = (argv: readonly string[]) => LineSource;

/**
 * Starts a command and reads its stdout as lines. Its stderr is this process's
 * (the journal, under systemd), and its stdin is /dev/null. A last line without
 * a newline is dropped, as `read` returns failure on it; the end comes when the
 * command closes its stdout. A command that cannot start ends at once, with a
 * line on stderr.
 */
export const lines: Lines = (argv) => {
  const queue: string[] = [];
  let ended = false;
  // Who waits in next(), if anyone (an object: TypeScript narrows a plain let to null).
  const waiter: { wake: (() => void) | null } = { wake: null };
  let proc: Bun.Subprocess<'ignore', 'pipe', 'inherit'> | undefined;
  try {
    proc = Bun.spawn([...argv], { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' });
  } catch (e) {
    err(`${argv[0]}: ${(e as Error).message}`);
    ended = true;
  }
  if (proc) {
    const stdout = proc.stdout;
    void (async () => {
      const decoder = new TextDecoder();
      let buf = '';
      try {
        for await (const chunk of stdout) {
          buf += decoder.decode(chunk, { stream: true });
          for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
            queue.push(buf.slice(0, i));
            buf = buf.slice(i + 1);
          }
          waiter.wake?.();
        }
      } finally {
        ended = true;
        waiter.wake?.();
      }
    })();
  }
  return {
    async next(timeoutMs) {
      if (queue.length === 0 && !ended) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            waiter.wake = null;
            resolve();
          }, timeoutMs);
          waiter.wake = () => {
            clearTimeout(timer);
            waiter.wake = null;
            resolve();
          };
        });
      }
      if (queue.length > 0) return queue.shift()!;
      return ended ? null : TIMEOUT;
    },
    close() {
      proc?.kill();
    },
  };
};
