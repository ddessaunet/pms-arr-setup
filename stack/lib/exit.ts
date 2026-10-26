// stack/lib/exit.ts — exit codes, and the wrapper every main runs in.
//
// The configure scripts share one meaning per code: 0 applied and verified ·
// 1 drift, or a step failed · 2 usage · 3 broken (unreachable, not configured).
// stack-status reads 1 as drift, so an unexpected error must never land on it:
// runMain maps a throw to the script's own "broken" code. Jobs with codes of
// their own (pms-update's 0–10) say so in their header and pass `broken`.
//
// process.exitCode is set, never process.exit(): exiting early could cut off
// output that is still being written to a pipe.

import { err, type Log } from './log.ts';

export const EXIT = { ok: 0, drift: 1, usage: 2, broken: 3 } as const;

/** A bad command line: printed as is, exit 2. */
export class UsageError extends Error {
  override name = 'UsageError';
}

export interface MainOptions {
  /** The code for an unexpected error (default 3). */
  broken?: number;
  log?: Log;
}

/** The code main ends with; a throw becomes `usage` or `broken`, with a line on stderr. */
export async function exitCodeOf(main: () => number | Promise<number>, opts: MainOptions = {}): Promise<number> {
  const log = opts.log ?? err;
  try {
    return await main();
  } catch (e) {
    if (e instanceof UsageError) {
      log(e.message);
      return EXIT.usage;
    }
    log(`error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return opts.broken ?? EXIT.broken;
  }
}

/** Runs main and sets process.exitCode from it. The one call at the bottom of a script. */
export async function runMain(main: () => number | Promise<number>, opts: MainOptions = {}): Promise<void> {
  process.exitCode = await exitCodeOf(main, opts);
}
