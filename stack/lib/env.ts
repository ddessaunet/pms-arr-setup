// stack/lib/env.ts — reads one key from .env without sourcing it.
//
// The same rules as env_get in stack/lib/servarr.sh, which every bash script
// copies (env.test.ts runs both and compares):
//   - the last `KEY=` line wins; a line must start with the key
//   - nothing is unquoted or trimmed: KEY="a b" reads as "a b" with the quotes
//   - no .env, or no such line, reads as ""
//   - a non-empty environment variable wins over .env (`${KEY:-$(env_get KEY)}`);
//     with { emptyWins: true } a set-but-empty one does too (`${KEY-…}`)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Env = Readonly<Record<string, string | undefined>>;

export interface EnvOptions {
  /** The tree whose .env is read: the install, or a source with its own .env. */
  repo: string;
  /** The environment; process.env unless a test passes its own. */
  env?: Env;
  /** A set-but-empty variable wins over .env too, as bash's `${KEY-…}` does. */
  emptyWins?: boolean;
}

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** KEY's value in .env text: the last `KEY=` line, verbatim; "" when there is none. */
export function envFileValue(text: string, key: string): string {
  if (!KEY.test(key)) throw new Error(`not an environment variable name: ${key}`);
  const prefix = `${key}=`;
  let value = '';
  for (const line of text.split('\n')) {
    if (line.startsWith(prefix)) value = line.slice(prefix.length);
  }
  return value;
}

/** The text of repo/.env, or "" when it cannot be read. */
export function readEnvFile(repo: string): string {
  try {
    return readFileSync(join(repo, '.env'), 'utf8');
  } catch {
    return '';
  }
}

/** KEY from the environment, else from repo/.env. */
export function envGet(key: string, opts: EnvOptions): string {
  const fromEnv = (opts.env ?? process.env)[key];
  if (fromEnv !== undefined && (fromEnv !== '' || opts.emptyWins)) return fromEnv;
  return envFileValue(readEnvFile(opts.repo), key);
}

/**
 * Milliseconds from a variable that holds seconds, as the bash scripts pass
 * `${X:-60}` to curl's --max-time: unset or empty is the default. Not a
 * number is an error, not a silent default.
 */
export function envSeconds(env: Env, key: string, fallbackSeconds: number): number {
  const v = env[key];
  if (v === undefined || v === '') return fallbackSeconds * 1000;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key} is not a number of seconds: ${v}`);
  return n * 1000;
}
