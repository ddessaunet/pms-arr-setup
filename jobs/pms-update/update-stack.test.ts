// jobs/pms-update/update-stack.test.ts — unit fixtures for update-stack.ts, and main
// against a fake docker and a fake Plex: pull, the gate, recreate, the health
// wait and the rollback, which the bash tests could only leave to a live box.
//
// Offline, and changes nothing outside a scratch folder. The clock is fake, so
// a 180 s health wait takes no time.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpRequest, HttpResponse } from '../../stack/lib/http.ts';
import { tryLock } from '../../stack/lib/lock.ts';
import type { Run } from '../../stack/lib/run.ts';
import { HOOKS, identityOf, main, sessionCount, short, versionOf, type Ctx, type Deps } from './update-stack.ts';

const SCRATCH = mkdtempSync(join(tmpdir(), 'update-stack-test-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

// ─── hooks ────────────────────────────────────────────────────────────────────
describe('hooks', () => {
  test('plex has a gate', () => expect(HOOKS.plex?.gate).toBeFunction());
  test('plex has an identity check', () => expect(HOOKS.plex?.identity).toBeFunction());
  test('a new service has no gate', () => expect(HOOKS.qbittorrent?.gate).toBeUndefined());
  test('short image id', () => expect(short('sha256:0123456789abcdef')).toBe('0123456789ab'));
  test('short, without the prefix', () => expect(short('0123456789abcdef')).toBe('0123456789ab'));
});

// ─── the session parser ───────────────────────────────────────────────────────
describe('sessionCount', () => {
  test('size=0 → 0', () => expect(sessionCount('<MediaContainer size="0">')).toBe(0));
  test('size=2 → 2', () =>
    expect(sessionCount('<?xml version="1.0"?>\n<MediaContainer size="2" allowSync="1">')).toBe(2));
  test('librarySize is not size', () => expect(sessionCount('<MediaContainer librarySize="9" size="1">')).toBe(1));
  test('not XML is an error', () => expect(sessionCount('Fails.')).toBeNull());
  test('no size is an error', () => expect(sessionCount('<MediaContainer>')).toBeNull());
  test('an empty size is an error', () => expect(sessionCount('<MediaContainer size="">')).toBeNull());
});

// ─── identity ─────────────────────────────────────────────────────────────────
const IDENT =
  '<?xml version="1.0" encoding="UTF-8"?>\n<MediaContainer size="0" apiVersion="1.2.3" claimed="1" machineIdentifier="f3860770aca2" version="1.43.4.10903-e5521bd8c">';
describe('identityOf / versionOf', () => {
  test('machineIdentifier', () => expect(identityOf(IDENT)).toBe('f3860770aca2'));
  test('server version, not the XML or API version', () => expect(versionOf(IDENT)).toBe('1.43.4.10903-e5521bd8c'));
  test('nothing → empty', () => expect(identityOf('')).toBe(''));
});

// ─── a fake box ───────────────────────────────────────────────────────────────
const PLEX_REF = 'lscr.io/linuxserver/plex:latest';
const QBT_REF = 'lscr.io/linuxserver/qbittorrent:latest';
const OLD = 'sha256:aaaaaaaaaaaa0000';
const NEW = 'sha256:bbbbbbbbbbbb1111';

interface Container {
  cid: string;
  ref: string;
  image: string;
  running: boolean;
  started: number;
  /** Restarts at every look: running each time, never with the same start time. */
  crashLoop?: boolean;
}

interface Box {
  services: Record<string, string>; // service → image ref
  containers: Record<string, Container | undefined>;
  /** Local tags: ref → image ID. */
  tags: Record<string, string>;
  /** What a pull of the ref fetches. */
  registry: Record<string, string>;
  /** How a container on this image behaves. */
  behaviour: Record<string, 'ok' | 'down' | 'crashloop' | 'fresh'>;
  pullFails: Set<string>;
  dockerDown?: boolean;
  composeBroken?: boolean;
  sessions: { status: number; body: string; error?: string };
  calls: string[];
  removed: string[];
  clock: number;
}

function newBox(over: Partial<Box> = {}): Box {
  return {
    services: { plex: PLEX_REF, qbittorrent: QBT_REF },
    containers: {
      plex: { cid: 'c-plex', ref: PLEX_REF, image: OLD, running: true, started: 1 },
      qbittorrent: { cid: 'c-qbt', ref: QBT_REF, image: OLD, running: true, started: 1 },
    },
    tags: { [PLEX_REF]: OLD, [QBT_REF]: OLD },
    registry: { [PLEX_REF]: NEW, [QBT_REF]: NEW },
    behaviour: { [OLD]: 'ok', [NEW]: 'ok' },
    pullFails: new Set(),
    sessions: { status: 200, body: '<MediaContainer size="0">' },
    calls: [],
    removed: [],
    clock: 0,
    ...over,
  };
}

let starts = 100;
function dockerFake(box: Box): Run {
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false });
  const fail = (stderr = 'Error') => ({ code: 1, stdout: '', stderr: `${stderr}\n`, timedOut: false });
  const byCid = (cid: string) => Object.values(box.containers).find((c) => c?.cid === cid);
  return async (argv) => {
    const a = argv.slice(1);
    const cmd = a.join(' ');
    box.calls.push(cmd);
    if (box.dockerDown) return fail('Cannot connect to the Docker daemon');
    if (cmd === 'info') return ok('Server: …\n');
    if (cmd === 'compose config -q') return box.composeBroken ? fail('yaml: line 3') : ok();
    const [, , , last] = a;
    if (cmd.startsWith('compose ps -q ')) {
      const c = box.containers[a[3]!];
      return ok(c ? `${c.cid}\n` : '');
    }
    if (a[0] === 'inspect') {
      const c = byCid(last!);
      if (!c) return fail('No such object');
      if (a[2] === '{{.Config.Image}}') return ok(`${c.ref}\n`);
      if (a[2] === '{{.Image}}') return ok(`${c.image}\n`);
      if (a[2] === '{{.State.Running}}') return ok(`${c.running}\n`);
      if (a[2] === '{{.State.StartedAt}}') {
        if (c.crashLoop) c.started = starts++;
        return ok(`${c.started}\n`);
      }
    }
    if (cmd.startsWith('image inspect -f {{.Id}} ')) {
      const id = box.tags[a[4]!];
      return id ? ok(`${id}\n`) : fail('No such image');
    }
    if (cmd.startsWith('compose pull -q ')) {
      const svc = a[3]!;
      if (box.pullFails.has(svc)) return fail('manifest unknown');
      box.tags[box.services[svc]!] = box.registry[box.services[svc]!]!;
      return ok();
    }
    if (cmd.startsWith('compose up -d --no-deps ')) {
      const svc = a[4]!;
      const ref = box.services[svc]!;
      const image = box.tags[ref]!;
      const b = box.behaviour[image] ?? 'ok';
      box.containers[svc] = {
        cid: `c-${svc}-${starts}`,
        ref,
        image,
        running: b !== 'down',
        started: starts++,
        crashLoop: b === 'crashloop',
      };
      return { code: 0, stdout: '', stderr: ` Container ${svc}  Recreated\n`, timedOut: false };
    }
    if (a[0] === 'tag') {
      box.tags[a[2]!] = a[1]!;
      return ok();
    }
    if (a[0] === 'image' && a[1] === 'rm') {
      box.removed.push(a[2]!);
      return ok();
    }
    return fail(`unexpected: docker ${cmd}`);
  };
}

/** Plex as the box would answer: its identity follows the image it runs on. */
function plexFake(box: Box) {
  const urls: { url: string; headers: Record<string, string> }[] = [];
  const http = async (url: string, req: HttpRequest): Promise<HttpResponse> => {
    urls.push({ url, headers: req.headers ?? {} });
    const res = (status: number, text: string, error?: string) => ({ status, text, headers: new Headers(), error });
    const c = box.containers.plex;
    if (!c?.running) return res(0, '', 'Unable to connect');
    if (url.endsWith('/status/sessions')) return res(box.sessions.status, box.sessions.body, box.sessions.error);
    if (url.endsWith('/identity')) {
      const ident = box.behaviour[c.image] === 'fresh' ? 'ffffffffffff' : 'f3860770aca2';
      const version = c.image === NEW ? '1.43.5' : '1.43.4';
      return res(200, `<MediaContainer size="0" machineIdentifier="${ident}" version="${version}">`);
    }
    return res(404, '');
  };
  return { http, urls };
}

function tree(name: string, { dotenv = true, appdata = true, token = 'tOkEn' } = {}) {
  const repo = join(SCRATCH, name);
  mkdirSync(repo);
  if (dotenv) writeFileSync(join(repo, '.env'), 'UPDATE_SERVICES=plex qbittorrent\nUPDATE_HEALTH_WAIT=180\n');
  const appdataDir = join(repo, 'appdata');
  if (appdata) mkdirSync(appdataDir);
  const prefs = join(repo, 'Preferences.xml');
  if (token) writeFileSync(prefs, `<Preferences PlexOnlineToken="${token}"/>\n`);
  return { repo, appdata: appdataDir, prefs };
}

let n = 0;
async function go(
  box: Box,
  argv: string[] = [],
  opts: Parameters<typeof tree>[1] & { env?: Record<string, string> } = {},
) {
  const t = tree(`t-${++n}`, opts);
  const lines: string[] = [];
  const plex = plexFake(box);
  const deps: Deps = {
    run: dockerFake(box),
    http: plex.http,
    log: (l) => lines.push(l),
    stdout: (l) => lines.push(`out: ${l}`),
    stderr: (l) => lines.push(`err: ${l}`),
    sleep: async (ms) => void (box.clock += ms),
    now: () => box.clock,
    env: { APPDATA: t.appdata, PLEX_PREFS: t.prefs, ...opts.env },
    repo: t.repo,
    user: () => 'dario',
  };
  const code = await main(argv, deps);
  return { code, lines, plex, t };
}

const recreated = (box: Box) => box.calls.filter((c) => c.startsWith('compose up'));

// ─── the streaming gate ───────────────────────────────────────────────────────
describe('the plex gate', () => {
  const gateAs = async (sessions: Box['sessions'], token = 'tOkEn') => {
    const box = newBox({ sessions });
    const t = tree(`g-${++n}`, { token });
    const lines: string[] = [];
    const c = {
      deps: { http: plexFake(box).http, log: (l: string) => lines.push(l) } as unknown as Deps,
      plexUrl: 'http://127.0.0.1:32400',
      plexPrefs: t.prefs,
      plexTimeoutMs: 10_000,
    } as Ctx;
    return { rc: await HOOKS.plex!.gate!(c), lines };
  };
  test('nobody watching → clear', async () =>
    expect((await gateAs({ status: 200, body: '<MediaContainer size="0">' })).rc).toBe(0));
  test('someone watching → defer', async () => {
    const r = await gateAs({ status: 200, body: '<MediaContainer size="1">' });
    expect(r.rc).toBe(1);
    expect(r.lines).toEqual(['plex: 1 active session(s) — deferring to the next run.']);
  });
  test('token rejected (401) → 4', async () => expect((await gateAs({ status: 401, body: '' })).rc).toBe(4));
  test('any error status → 4, as curl -f', async () => expect((await gateAs({ status: 500, body: '' })).rc).toBe(4));
  test('refused → 5, never a guess', async () => {
    const r = await gateAs({ status: 0, body: '', error: 'Unable to connect' });
    expect(r.rc).toBe(5);
    expect(r.lines).toEqual(['plex: ERROR: Plex is running but not answering (Unable to connect)']);
  });
  test('timed out → 5', async () =>
    expect((await gateAs({ status: 0, body: '', error: 'The operation timed out.' })).rc).toBe(5));
  test('garbage answer → 5', async () => expect((await gateAs({ status: 200, body: 'Fails.' })).rc).toBe(5));
  test('no token at all → 4', async () => {
    const r = await gateAs({ status: 200, body: '<MediaContainer size="0">' }, '');
    expect(r.rc).toBe(4);
    expect(r.lines[0]).toMatch(/^plex: ERROR: no PlexOnlineToken in .* — cannot tell whether anyone is streaming$/);
  });
  test('the token goes in a header, never the URL', async () => {
    const box = newBox();
    const r = await go(box, ['plex']);
    const asked = r.plex.urls.find((u) => u.url.endsWith('/status/sessions'))!;
    expect(asked.url).toBe('http://127.0.0.1:32400/status/sessions');
    expect(asked.headers['X-Plex-Token']).toBe('tOkEn');
  });
});

// ─── one run ──────────────────────────────────────────────────────────────────
describe('main', () => {
  test('a healthy update: versions logged, the old image removed', async () => {
    const box = newBox();
    const r = await go(box, ['plex']);
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      'Services:   plex',
      'Dry run:    0',
      `plex: running aaaaaaaaaaaa (${PLEX_REF})`,
      'plex: new image bbbbbbbbbbbb',
      'plex: version before: 1.43.4',
      'plex: recreating on bbbbbbbbbbbb',
      'err:  Container plex  Recreated',
      'plex: version after:  1.43.5',
      'plex: updated.',
    ]);
    expect(box.containers.plex?.image).toBe(NEW);
    expect(box.removed).toEqual([OLD]);
  });

  test('every service in UPDATE_SERVICES (.env) by default', async () => {
    const box = newBox();
    const r = await go(box);
    expect(r.lines[1]).toBe('Services:   plex qbittorrent');
    expect(recreated(box)).toEqual(['compose up -d --no-deps plex', 'compose up -d --no-deps qbittorrent']);
  });

  test('a service without hooks: healthy once it stays up 20 s', async () => {
    const box = newBox();
    const r = await go(box, ['qbittorrent']);
    expect(r.code).toBe(0);
    expect(box.clock).toBe(20_000);
    expect(r.lines).not.toContainEqual(expect.stringContaining('version'));
  });

  test('not running → skipped, 0', async () => {
    const box = newBox();
    box.containers.plex = undefined;
    const r = await go(box, ['plex']);
    expect(r.code).toBe(0);
    expect(r.lines.at(-1)).toBe('plex: not running — skipping.');
    expect(box.calls).not.toContain('compose pull -q plex');
  });

  test('already current → nothing to do', async () => {
    const box = newBox({ registry: { [PLEX_REF]: OLD, [QBT_REF]: OLD } });
    const r = await go(box, ['plex']);
    expect(r.code).toBe(0);
    expect(r.lines.at(-1)).toBe('plex: already current — nothing to do.');
    expect(recreated(box)).toEqual([]);
  });

  test('pull fails → 6', async () => {
    const box = newBox({ pullFails: new Set(['plex']) });
    const r = await go(box, ['plex']);
    expect(r.code).toBe(6);
    expect(r.lines.slice(-2)).toEqual(['err: manifest unknown', 'plex: ERROR: pull failed']);
  });

  test('someone streaming → deferred, 0, nothing recreated; the pulled image waits', async () => {
    const box = newBox({ sessions: { status: 200, body: '<MediaContainer size="2">' } });
    const r = await go(box, ['plex']);
    expect(r.code).toBe(0);
    expect(recreated(box)).toEqual([]);
    expect(box.tags[PLEX_REF]).toBe(NEW);
  });

  test('a failed gate stops that service with its code', async () => {
    const box = newBox({ sessions: { status: 401, body: '' } });
    expect((await go(box, ['plex'])).code).toBe(4);
    expect(recreated(box)).toEqual([]);
  });

  test('--dry-run: pulls and gates, recreates nothing', async () => {
    const box = newBox();
    const r = await go(box, ['--dry-run', 'plex']);
    expect(r.code).toBe(0);
    expect(r.lines[2]).toBe('Dry run:    1');
    expect(r.lines.at(-1)).toBe('plex: dry run — would recreate on bbbbbbbbbbbb.');
    expect(box.calls).toContain('compose pull -q plex');
    expect(r.plex.urls.map((u) => u.url)).toEqual(['http://127.0.0.1:32400/status/sessions']);
    expect(recreated(box)).toEqual([]);
  });

  test('DRY_RUN=1 in the environment does the same', async () => {
    const box = newBox();
    const r = await go(box, ['plex'], { env: { DRY_RUN: '1' } });
    expect(r.lines[2]).toBe('Dry run:    1');
    expect(recreated(box)).toEqual([]);
  });

  test("plex's identity unreadable before → 5, nothing recreated", async () => {
    // A Plex that answers /status/sessions but not /identity.
    const box2 = newBox();
    const plex = plexFake(box2);
    const t = tree(`id-${++n}`);
    const lines: string[] = [];
    const code = await main(['plex'], {
      run: dockerFake(box2),
      http: async (url, req) =>
        url.endsWith('/identity') ? { status: 0, text: '', headers: new Headers(), error: 'x' } : plex.http(url, req),
      log: (l) => lines.push(l),
      stdout: () => {},
      stderr: () => {},
      sleep: async () => {},
      now: () => 0,
      env: { APPDATA: t.appdata, PLEX_PREFS: t.prefs },
      repo: t.repo,
      user: () => 'dario',
    });
    expect(code).toBe(5);
    expect(lines.at(-1)).toBe('plex: ERROR: cannot read its identity before updating');
    expect(recreated(box2)).toEqual([]);
  });

  test('a fresh config (another identity) → rolled back, 9; the old image kept', async () => {
    const box = newBox({ behaviour: { [OLD]: 'ok', [NEW]: 'fresh' } });
    const r = await go(box, ['plex']);
    expect(r.code).toBe(9);
    expect(box.containers.plex?.image).toBe(OLD);
    expect(box.tags[PLEX_REF]).toBe(OLD);
    expect(box.removed).toEqual([]);
    expect(box.calls).toContain(`tag ${OLD} ${PLEX_REF}`);
    expect(r.lines).toContain('plex: ERROR: not healthy within 180s on bbbbbbbbbbbb — rolling back to aaaaaaaaaaaa');
    expect(r.lines.at(-1)).toBe(
      "plex: rolled back; aaaaaaaaaaaa is serving. Next week's run will try bbbbbbbbbbbb again.",
    );
  });

  test('the health wait gives up at UPDATE_HEALTH_WAIT', async () => {
    const box = newBox({ behaviour: { [OLD]: 'ok', [NEW]: 'down' } });
    await go(box, ['plex'], { env: { UPDATE_HEALTH_WAIT: '30' } });
    // 30 s of 5 s polls on the new image, then the old one answers at once.
    expect(box.clock).toBe(30_000);
  });

  test('a crash loop never counts as steady → rolled back', async () => {
    const box = newBox({ behaviour: { [OLD]: 'ok', [NEW]: 'crashloop' } });
    const r = await go(box, ['qbittorrent']);
    expect(r.code).toBe(9);
    expect(box.containers.qbittorrent?.image).toBe(OLD);
  });

  test('the rollback fails too → 10, the service is DOWN', async () => {
    const box = newBox({ behaviour: { [OLD]: 'down', [NEW]: 'down' } });
    const r = await go(box, ['qbittorrent']);
    expect(r.code).toBe(10);
    expect(r.lines.at(-1)).toBe('qbittorrent: ERROR: rollback failed — qbittorrent is DOWN. See docs/updating.md.');
  });

  test('several services: each is tried, the worst code wins', async () => {
    const box = newBox({ pullFails: new Set(['plex']) });
    const r = await go(box, ['plex', 'qbittorrent']);
    expect(r.code).toBe(6);
    expect(box.containers.qbittorrent?.image).toBe(NEW);
  });

  test('another run holds the lock → 0, nothing pulled', async () => {
    const box = newBox();
    const t = tree(`lock-${++n}`);
    const lockPath = join(t.appdata, '.update-stack.lock');
    const held = tryLock(lockPath)!;
    try {
      const r = await go(box, ['plex'], { env: { UPDATE_LOCK: lockPath } });
      expect(r.code).toBe(0);
      expect(r.lines).toEqual([`Another update holds ${lockPath} — exiting.`]);
      expect(box.calls).not.toContain('compose pull -q plex');
    } finally {
      held.release();
    }
  });

  test('--help prints the header', async () => {
    const r = await go(newBox(), ['--help']);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toStartWith('out: jobs/pms-update/update-stack.ts — weekly, safe image updates');
  });

  test('an unknown flag is a usage error', () =>
    expect(go(newBox(), ['--bogus'])).rejects.toThrow('usage: update-stack.sh [--dry-run] [service...]'));
});

describe('preflight → 3', () => {
  test('docker unreachable', async () => {
    const r = await go(newBox({ dockerDown: true }));
    expect(r.code).toBe(3);
    expect(r.lines).toEqual(['err: docker is not reachable as dario']);
  });
  test('no .env', async () => {
    const r = await go(newBox(), [], { dotenv: false });
    expect(r.code).toBe(3);
    expect(r.lines[0]).toMatch(/^err: .*\/\.env is missing$/);
  });
  test('compose.yaml does not render', async () => {
    const r = await go(newBox({ composeBroken: true }));
    expect(r.lines).toEqual(['err: compose.yaml does not render']);
  });
  test('no appdata', async () => {
    const r = await go(newBox(), [], { appdata: false });
    expect(r.code).toBe(3);
    expect(r.lines[0]).toMatch(/^err: .*\/appdata does not exist$/);
  });
});

describe('the unit', () => {
  test('ExecStart runs the launcher', async () => {
    const unit = await Bun.file(join(import.meta.dir, 'pms-update.service')).text();
    expect(unit.match(/^ExecStart=(.*)$/m)?.[1]).toBe('@PMS_HOME@/jobs/pms-update/update-stack.sh');
    expect(unit).not.toMatch(/^MemoryDenyWriteExecute=yes/m);
  });
});
