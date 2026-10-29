// jobs/lan-address/lan-address.test.ts — unit fixtures for lan-address.ts, main with
// the addresses and the configure scripts stood in for, and the names it shares
// with its units and Taskfile.yml.
//
// Offline, and changes nothing outside a scratch folder.

import { afterAll, describe, expect, test } from 'bun:test';
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { tryLock } from '../../stack/lib/lock.ts';
import { run as realRun, type Run } from '../../stack/lib/run.ts';
import {
  addressesNow,
  indented,
  LAN_ADDRESS_APPS,
  main,
  pendingApps,
  stateOf,
  stateSet,
  type Deps,
} from './lan-address.ts';

const ROOT = resolve(import.meta.dir, '../..');
const SCRATCH = mkdtempSync(join(tmpdir(), 'lan-address-test-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

// ─── addresses ────────────────────────────────────────────────────────────────
describe('addressesNow', () => {
  test('sorted, deduplicated, one line', () =>
    expect(addressesNow(['192.168.0.87', '192.168.0.67', '192.168.0.87'])).toBe('192.168.0.67 192.168.0.87'));
  test('none yet → empty', () => expect(addressesNow([])).toBe(''));
  test('byte order, as LC_ALL=C sort', () =>
    expect(addressesNow(['10.0.0.9', '10.0.0.50'])).toBe('10.0.0.50 10.0.0.9'));
});

// ─── state ────────────────────────────────────────────────────────────────────
describe('stateOf / stateSet / pendingApps', () => {
  const S = 'prowlarr 192.168.0.66 192.168.0.86\nqbittorrent 192.168.0.67 192.168.0.87';
  const NOW = '192.168.0.67 192.168.0.87';
  test("reads an app's addresses", () => expect(stateOf(S, 'prowlarr')).toBe('192.168.0.66 192.168.0.86'));
  test('an app never applied → empty', () => expect(stateOf(S, 'seerr')).toBe(''));
  test('no app is a prefix of another', () => expect(stateOf(S, 'prowl')).toBe(''));
  test('the first line for an app wins', () => expect(stateOf('a 1\na 2', 'a')).toBe('1'));
  test("set replaces the app's line", () =>
    expect(stateSet(S, 'prowlarr', NOW)).toBe(
      'prowlarr 192.168.0.67 192.168.0.87\nqbittorrent 192.168.0.67 192.168.0.87',
    ));
  test('set adds a new app, sorted', () =>
    expect(stateSet(S, 'radarr', NOW)).toBe(
      'prowlarr 192.168.0.66 192.168.0.86\nqbittorrent 192.168.0.67 192.168.0.87\nradarr 192.168.0.67 192.168.0.87',
    ));
  test('set on empty state', () => expect(stateSet('', 'seerr', NOW)).toBe(`seerr ${NOW}`));
  test('pending: changed and never applied, not current', () =>
    expect(pendingApps(S, NOW, ['qbittorrent', 'prowlarr', 'radarr'])).toEqual(['prowlarr', 'radarr']));
  test('pending: nothing when all current', () =>
    expect(pendingApps(`qbittorrent ${NOW}`, NOW, ['qbittorrent'])).toEqual([]));
});

describe('indented', () => {
  test('every line, blank ones too, four spaces in', () =>
    expect(indented('a\n\nb\n')).toEqual(['    a', '    ', '    b']));
  test('no output, no lines', () => expect(indented('')).toEqual([]));
  test('a last line without a newline is kept', () => expect(indented('a\nb')).toEqual(['    a', '    b']));
});

// ─── a run, with the configure scripts stood in for ───────────────────────────
let n = 0;
function fixture() {
  const dir = join(SCRATCH, `run-${++n}`);
  mkdirSync(dir);
  const state = join(dir, 'state');
  const lock = join(dir, 'lock');
  let ran: string[] = [];
  let lines: string[] = [];
  // The apps listed in failing fail; every call is recorded.
  const go = async (addr: string, args: string[] = [], failing: string[] = []) => {
    ran = [];
    lines = [];
    const fake: Run = async (argv) => {
      const app = argv.at(-1)!.split('/').at(-2)!;
      ran.push(app);
      const ok = !failing.includes(app);
      return { code: ok ? 0 : 3, stdout: ok ? `${app}: ok\n` : `${app}: unreachable\n`, stderr: '', timedOut: false };
    };
    const deps: Deps = {
      run: fake,
      log: (l) => lines.push(l),
      env: { LAN_ADDRESS_STATE: state, LAN_ADDRESS_LOCK: lock, LAN_ADDRESS_APPS: 'qbittorrent prowlarr seerr' },
      repo: dir,
      addresses: () => (addr === '' ? [] : addr.split(' ')),
    };
    return main(args, deps);
  };
  return {
    go,
    state,
    lock,
    ran: () => ran.join(' '),
    lines: () => lines,
    stateText: () => readFileSync(state, 'utf8'),
  };
}

describe('main', () => {
  const f = fixture();
  const A = '192.168.0.67 192.168.0.87';
  const B = '192.168.0.66 192.168.0.86';

  test('first run: every app; a failure → exit 1; only the apps that applied are recorded', async () => {
    expect(await f.go(A, [], ['prowlarr'])).toBe(1);
    expect(f.ran()).toBe('qbittorrent prowlarr seerr');
    expect(f.stateText()).toBe(`qbittorrent ${A}\nseerr ${A}\n`);
  });

  test('the log says what changed, what failed and what is left', () =>
    expect(f.lines()).toEqual([
      `LAN addresses now: ${A}`,
      `  qbittorrent: never applied → ${A}`,
      `  prowlarr: never applied → ${A}`,
      `  seerr: never applied → ${A}`,
      '── qbittorrent',
      '    qbittorrent: ok',
      '── prowlarr',
      '    prowlarr: unreachable',
      '  prowlarr: configure failed — trying again next run',
      '── seerr',
      '    seerr: ok',
      `Applied the others; the stack answers at ${A}.`,
      'Still pending: prowlarr',
    ]));

  test('the state file is 0600, as mktemp made it', () => expect(statSync(f.state).mode & 0o777).toBe(0o600));

  test('next run: only the one that failed; all applied → exit 0', async () => {
    expect(await f.go(A)).toBe(0);
    expect(f.ran()).toBe('prowlarr');
    expect(f.lines().at(-1)).toBe(`Stack now at ${A}.`);
  });

  test('no change: nothing runs, nothing logged, exit 0', async () => {
    expect(await f.go(A)).toBe(0);
    expect(f.ran()).toBe('');
    expect(f.lines()).toEqual([]);
  });

  test('dry run: nothing runs, state untouched', async () => {
    expect(await f.go(B, ['--dry-run'])).toBe(0);
    expect(f.ran()).toBe('');
    expect(
      f
        .stateText()
        .split('\n')
        .filter((l) => l.endsWith(A)),
    ).toHaveLength(3);
    expect(f.lines().at(2)).toBe(`  prowlarr: ${A} → ${B}`);
    expect(f.lines().at(-1)).toBe('Dry run: nothing applied.');
  });

  test('an address change: every app again, all recorded at the new addresses', async () => {
    await f.go(B);
    expect(f.ran()).toBe('qbittorrent prowlarr seerr');
    expect(
      f
        .stateText()
        .split('\n')
        .filter((l) => l.endsWith(B)),
    ).toHaveLength(3);
  });

  test('--force: every app, changed or not', async () => {
    await f.go(B, ['--force']);
    expect(f.ran()).toBe('qbittorrent prowlarr seerr');
  });

  test('no address yet: nothing runs, exit 0', async () => {
    expect(await f.go('')).toBe(0);
    expect(f.ran()).toBe('');
    expect(f.lines()).toEqual(['No LAN address yet — trying again next run.']);
  });

  test('unknown argument → usage error (exit 2 through runMain)', () =>
    expect(f.go(B, ['--bogus'])).rejects.toThrow('usage: lan-address.sh [--dry-run|--force]'));

  test('a held lock: nothing runs, exit 0', async () => {
    const held = tryLock(f.lock)!;
    try {
      expect(await f.go(A, ['--force'])).toBe(0);
      expect(f.ran()).toBe('');
      expect(f.lines()).toEqual([`Another run holds ${f.lock} — skipping.`]);
    } finally {
      held.release();
    }
  });

  test('a dry run ignores the lock', async () => {
    const held = tryLock(f.lock)!;
    try {
      expect(await f.go(A, ['--dry-run'])).toBe(0);
      expect(f.lines().at(-1)).toBe('Dry run: nothing applied.');
    } finally {
      held.release();
    }
  });

  test('a state it cannot write: the app applied, exit 1', async () => {
    const g = fixture();
    mkdirSync(g.state); // a folder where the file goes: the rename fails
    expect(await g.go(A, [], [])).toBe(1);
    expect(g.ran()).toBe('qbittorrent prowlarr seerr');
    expect(g.lines()).toContain(`WARN: cannot write ${g.state}`);
  });

  test('--help prints the header', async () => {
    expect(await f.go(A, ['--help'])).toBe(0);
    expect(f.lines()[0]).toStartWith('jobs/lan-address/lan-address.ts — when the box');
  });
});

describe('a real configure script', () => {
  test('stdout and stderr in the order written, indented; stdin is empty', async () => {
    const repo = join(SCRATCH, 'repo');
    mkdirSync(join(repo, 'apps/x'), { recursive: true });
    const script = join(repo, 'apps/x/configure.sh');
    writeFileSync(script, '#!/bin/sh\necho one\necho two >&2\nread -r l && echo "stdin: $l"\necho three\n');
    chmodSync(script, 0o755);
    const lines: string[] = [];
    const rc = await main([], {
      run: realRun,
      log: (l) => lines.push(l),
      env: { LAN_ADDRESS_STATE: join(repo, 'state'), LAN_ADDRESS_LOCK: join(repo, 'lock'), LAN_ADDRESS_APPS: 'x' },
      repo,
      addresses: () => ['10.0.0.50'],
    });
    expect(rc).toBe(0);
    expect(lines.slice(2, 6)).toEqual(['── x', '    one', '    two', '    three']);
  });
});

// ─── one name, several owners ─────────────────────────────────────────────────
describe('the units and the app list', () => {
  const unit = readFileSync(join(ROOT, 'jobs/lan-address/lan-address.service'), 'utf8');
  const timer = readFileSync(join(ROOT, 'jobs/lan-address/lan-address.timer'), 'utf8');
  test('the timer runs this script', () =>
    expect(unit.match(/^ExecStart=(.*)$/m)?.[1]).toBe('@PMS_HOME@/jobs/lan-address/lan-address.sh'));
  test('the unit allows netlink, which reading the addresses needs', () =>
    expect(unit).toMatch(/^RestrictAddressFamilies=.*AF_NETLINK/m));
  test('the unit leaves Bun its JIT (no MemoryDenyWriteExecute)', () =>
    expect(unit).not.toMatch(/^MemoryDenyWriteExecute=yes/m));
  test('the timer fires after boot and every 5 minutes', () =>
    expect(timer.match(/^On(Boot|UnitActive)Sec=.*$/gm)).toEqual(['OnBootSec=2min', 'OnUnitActiveSec=5min']));
  // Every app with a configure.sh, in Taskfile.yml's order, except Bazarr and
  // Maintainerr (no address) and Plex (pinned to an interface name, not an address).
  test('the apps are CONFIGURED minus bazarr, plex and maintainerr', () => {
    const configured = readFileSync(join(ROOT, 'Taskfile.yml'), 'utf8').match(/^ {2}CONFIGURED: (.*)$/m)![1]!;
    expect<string[]>([...LAN_ADDRESS_APPS]).toEqual(
      configured.split(' ').filter((a) => !['bazarr', 'plex', 'maintainerr'].includes(a)),
    );
  });
  for (const app of LAN_ADDRESS_APPS)
    test(`apps/${app}/configure.sh is executable`, () =>
      expect(() => accessSync(join(ROOT, 'apps', app, 'configure.sh'), constants.X_OK)).not.toThrow());
});
