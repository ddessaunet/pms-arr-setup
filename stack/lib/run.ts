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

import { constants } from 'node:os';

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
