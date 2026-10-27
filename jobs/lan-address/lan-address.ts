// jobs/lan-address/lan-address.ts — when the box's LAN addresses change, apply the
// settings of the apps that list them again.
//
//   jobs/lan-address/lan-address.sh              apply the apps that are behind
//   jobs/lan-address/lan-address.sh --dry-run    say which ones; changes nothing
//   jobs/lan-address/lan-address.sh --force      apply all of them
//
// Normally run by lan-address.timer beside it (2 min after boot, then every
// 5 min), or as `task lan-address:run` / `:dry` / `:force`.
//
// The box's address is reserved on the router (10.0.0.50), but it has moved
// before: the old router's DHCP took it .86 → .87 and back on reboots. A lost
// reservation or a new router would move it again. qBittorrent, Prowlarr, Radarr and
// Sonarr refuse a request to an address they don't list ("Unauthorized",
// "Invalid Hostname"), and Seerr links to Radarr and Sonarr by address. Their
// configure.sh scripts list the addresses the box has when they run, so this runs
// them again, but only for an app whose recorded addresses differ from now:
// Prowlarr's configure re-syncs its indexers on every run.
//
// Exit: 0 nothing to do, or every app applied · 1 an app failed (it is retried
// on the next run) · 2 usage.

import { renameSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { headerHelp, parseCli } from '../../stack/lib/cli.ts';
import { envGet, type Env } from '../../stack/lib/env.ts';
import { runMain } from '../../stack/lib/exit.ts';
import { tryLock, type Lock } from '../../stack/lib/lock.ts';
import { out, type Log } from '../../stack/lib/log.ts';
import { lanIps } from '../../stack/lib/net.ts';
import { run, type Run } from '../../stack/lib/run.ts';

// The apps whose settings hold the box's addresses, in the order Taskfile.yml's
// CONFIGURED applies them. Bazarr reaches Plex as host.docker.internal, and Plex
// is pinned to an interface by name, so neither is one of them.
export const LAN_ADDRESS_APPS = ['qbittorrent', 'prowlarr', 'radarr', 'sonarr', 'seerr'] as const;

// ─── pure helpers (jobs/lan-address/lan-address.test.ts) ──────────────────────

/** C-locale order: byte order, which is code-unit order for these ASCII lines. */
const byteOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The box's LAN addresses now, sorted, on one line. Empty before DHCP answers.
 * Read as the configure scripts read them (stack/lib/net.ts), so the two agree.
 */
export function addressesNow(addresses: readonly string[]): string {
  return [...new Set(addresses)].sort(byteOrder).join(' ');
}

/** The addresses recorded for an app in the state text ("<app> <addresses>" lines). */
export function stateOf(state: string, app: string): string {
  // awk's `$1 == a { sub(/^[^ ]+ */, ""); print; exit }`: the first line whose
  // first field is the app, without that field.
  for (const line of state.split('\n')) {
    if (line.trim().split(/[ \t]+/)[0] === app) return line.replace(/^[^ ]+ */, '');
  }
  return '';
}

/** The state text with the app's line set to the addresses. */
export function stateSet(state: string, app: string, addresses: string): string {
  return [...state.split('\n').filter((l) => l !== '' && !l.startsWith(`${app} `)), `${app} ${addresses}`]
    .sort(byteOrder)
    .join('\n');
}

/** The apps, of those given, whose recorded addresses are not these. */
export function pendingApps(state: string, now: string, apps: readonly string[]): string[] {
  return apps.filter((app) => stateOf(state, app) !== now);
}

/** Output lines indented under the app's heading, as `sed 's/^/    /'`. */
export function indented(output: string): string[] {
  if (output === '') return [];
  return output
    .replace(/\n$/, '')
    .split('\n')
    .map((l) => `    ${l}`);
}

// ─── main ─────────────────────────────────────────────────────────────────────

export interface Deps {
  run: Run;
  log: Log;
  env: Env;
  repo: string;
  /** The box's LAN addresses, in any order (stack/lib/net.ts). */
  addresses: () => readonly string[];
}

/** Apply one app's settings: its configure.sh, stdout and stderr as one stream. */
async function runConfigure(deps: Deps, app: string): Promise<{ ok: boolean; output: string }> {
  const script = join(deps.repo, 'apps', app, 'configure.sh');
  const r = await deps.run(['sh', '-c', 'exec "$@" 2>&1', 'sh', script]);
  return { ok: r.code === 0, output: r.stdout };
}

function readState(path: string): string {
  try {
    return readFileSync(path, 'utf8').replace(/\n+$/, '');
  } catch {
    return '';
  }
}

/** Write the state beside it, then rename: a crash never leaves half a file. 0600, as mktemp made it. */
function writeState(path: string, text: string, log: Log): boolean {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, `${text}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // never created
    }
    log(`WARN: cannot write ${path}`);
    return false;
  }
}

const USAGE = 'usage: lan-address.sh [--dry-run|--force]';

export async function main(argv: readonly string[], deps: Deps): Promise<number> {
  const { env, log } = deps;
  const cli = parseCli(argv, { flags: ['--dry-run', '--force'], usage: USAGE });
  if (cli.help) {
    log(headerHelp(await Bun.file(import.meta.path).text()));
    return 0;
  }
  const dry = cli.flags['--dry-run'];

  const appdata = envGet('APPDATA', { repo: deps.repo, env }) || '/opt/appdata';
  const statePath = env.LAN_ADDRESS_STATE || join(appdata, '.lan-address');
  const lockPath = env.LAN_ADDRESS_LOCK || join(appdata, '.lan-address.lock');
  const appList = env.LAN_ADDRESS_APPS ? env.LAN_ADDRESS_APPS.split(/\s+/).filter(Boolean) : [...LAN_ADDRESS_APPS];

  const now = addressesNow(deps.addresses());
  if (now === '') {
    log('No LAN address yet — trying again next run.');
    return 0;
  }

  let lock: Lock | null = null;
  if (!dry) {
    try {
      lock = tryLock(lockPath);
    } catch {
      log(`cannot open ${lockPath}`);
      return 1;
    }
    if (lock === null) {
      log(`Another run holds ${lockPath} — skipping.`);
      return 0;
    }
  }

  try {
    let state = readState(statePath);
    const apps = cli.flags['--force'] ? appList : pendingApps(state, now, appList);
    if (apps.length === 0) return 0; // the common case, every 5 minutes: quiet

    log(`LAN addresses now: ${now}`);
    for (const app of apps) log(`  ${app}: ${stateOf(state, app) || 'never applied'} → ${now}`);
    if (dry) {
      log('Dry run: nothing applied.');
      return 0;
    }

    let rc = 0;
    let doneAny = false;
    const failed: string[] = [];
    for (const app of apps) {
      log(`── ${app}`);
      const r = await runConfigure(deps, app);
      for (const line of indented(r.output)) log(line);
      if (r.ok) {
        state = stateSet(state, app, now);
        if (!writeState(statePath, state, log)) rc = 1;
        doneAny = true;
      } else {
        log(`  ${app}: configure failed — trying again next run`);
        failed.push(app);
        rc = 1;
      }
    }

    if (failed.length === 0) log(`Stack now at ${now}.`);
    else {
      if (doneAny) log(`Applied the others; the stack answers at ${now}.`);
      log(`Still pending: ${failed.join(' ')}`);
    }
    return rc;
  } finally {
    lock?.release();
  }
}

if (import.meta.main) {
  await runMain(() =>
    main(Bun.argv.slice(2), {
      run,
      log: out,
      env: process.env,
      repo: resolve(import.meta.dir, '../..'),
      addresses: () => lanIps(),
    }),
  );
}
