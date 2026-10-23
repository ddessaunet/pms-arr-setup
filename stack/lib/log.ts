// stack/lib/log.ts — log lines, written synchronously.
//
// A job's stdout is journald's pipe. Writing synchronously means every line is
// out before the next step runs and before the process ends, with no buffered
// tail lost to an exit. Formats stay as the bash scripts print them:
//   out('  DRIFT    host: allowedHosts')          configure scripts, as is
//   stamped('reclaim: ')('…')                    "[2026-10-23 18:00:00] reclaim: …"

import { writeSync } from 'node:fs';

/** Writes one line. */
export type Log = (line: string) => void;
export type Clock = () => Date;

function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text);
  let off = 0;
  while (off < bytes.length) {
    try {
      off += writeSync(fd, bytes, off);
    } catch (e) {
      // A non-blocking pipe that is full: wait for the reader, don't drop the line.
      if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') throw e;
      Bun.sleepSync(1);
    }
  }
}

export const out: Log = (line) => writeAll(1, `${line}\n`);
export const err: Log = (line) => writeAll(2, `${line}\n`);

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/**
 * date(1)'s formats, in local time (TZ applies): %Y %m %d %H %M %S %F %T %z %s %%.
 * Hand-written, because Intl has no %z and toISOString is UTC.
 */
export function strftime(fmt: string, d: Date): string {
  return fmt.replace(/%([YmdHMSFTzs%])/g, (_, c: string) => {
    switch (c) {
      case 'Y':
        return pad(d.getFullYear(), 4);
      case 'm':
        return pad(d.getMonth() + 1);
      case 'd':
        return pad(d.getDate());
      case 'H':
        return pad(d.getHours());
      case 'M':
        return pad(d.getMinutes());
      case 'S':
        return pad(d.getSeconds());
      case 'F':
        return strftime('%Y-%m-%d', d);
      case 'T':
        return strftime('%H:%M:%S', d);
      case 'z': {
        const off = -d.getTimezoneOffset();
        const abs = Math.abs(off);
        return `${off < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
      }
      case 's':
        return String(Math.floor(d.getTime() / 1000));
      default:
        return '%';
    }
  });
}

/** A log that stamps each line `[%F %T] ` and then `prefix`, as the jobs' bash log() does. */
export function stamped(prefix = '', write: Log = out, clock: Clock = () => new Date()): Log {
  return (line) => write(`[${strftime('%F %T', clock())}] ${prefix}${line}`);
}
