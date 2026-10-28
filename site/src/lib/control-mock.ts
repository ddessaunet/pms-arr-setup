// A ControlApi that acts on nothing: every action plays a script of log lines
// shaped like the real command's output, then lands in the history. It is what
// the control page runs until a control backend exists (control-api.ts). The
// deployed commit and the history live in sessionStorage, so they survive a
// reload in the same tab and never reach another viewer.

import {
  BusyError,
  type ActionKind,
  type Commit,
  type ControlApi,
  type ControlEvent,
  type DeployStep,
  type Deployed,
  type RunRecord,
  type Scenario,
} from './control-api.ts';

/** main's newest commits, newest first: the mock deploys the first. */
export const MOCK_COMMITS: Commit[] = [
  { sha: 'ca50509', subject: "port prowlarr's configure script to typescript (#62)" },
  { sha: '7dc026d', subject: "port plex's configure script to typescript (#61)" },
  { sha: '9a74e7a', subject: 'port arr-fallback-search to typescript (#60)' },
];

const STORAGE_KEY = 'pms-control-mock';
const MAX_HISTORY = 20;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export interface MockOptions {
  /** Waits between lines; tests pass one that returns at once. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  storage?: StorageLike | null;
  lineMs?: number;
}

/** A stretch of a script: its step (deploys only), its lines, and whether it fails there. */
interface Beat {
  step?: DeployStep;
  lines: string[];
  fail?: boolean;
}

interface Saved {
  deployed: Deployed | null;
  history: RunRecord[];
}

function seed(now: Date): Saved {
  const ago = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
  const record = (h: number, commit: Commit, ok: boolean, seconds: number, summary: string): RunRecord => ({
    id: `seed-${commit.sha}-${h}`,
    kind: 'deploy',
    target: 'main',
    commit,
    startedAt: ago(h),
    seconds,
    ok,
    summary,
    log: ok
      ? [
          'git fetch origin main',
          `origin/main → ${commit.sha}`,
          '… lint, test, site:build, install, deploy.sh',
          'deploy: no drift',
        ]
      : [
          'git fetch origin main',
          `origin/main → ${commit.sha}`,
          'FAIL  stack/lib/plex.test.ts',
          'test: 1 suite failed',
        ],
  });
  const [, current, older] = MOCK_COMMITS;
  return {
    deployed: { commit: current, at: ago(20) },
    history: [
      record(20, current, true, 142, `deployed ${current.sha}`),
      record(21, current, false, 58, `failed at test: ${current.sha} not deployed`),
      record(46, older, true, 137, `deployed ${older.sha}`),
    ],
  };
}

function load(storage: StorageLike | null, now: Date): Saved {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Saved;
      if (Array.isArray(s.history)) return s;
    }
  } catch {
    // unreadable or blocked storage: start from the seed
  }
  return seed(now);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class MockControlApi implements ControlApi {
  private running: { kind: ActionKind; target: string } | null = null;
  private state: Saved;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly storage: StorageLike | null;
  private readonly lineMs: number;
  private runs = 0;

  constructor(opts: MockOptions = {}) {
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? (() => new Date());
    this.storage = opts.storage ?? null;
    this.lineMs = opts.lineMs ?? 450;
    this.state = load(this.storage, this.now());
  }

  busy() {
    return this.running;
  }
  deployed() {
    return this.state.deployed;
  }
  history() {
    return this.state.history;
  }

  deploy(opts: { scenario?: Scenario } = {}): AsyncIterable<ControlEvent> {
    const to = MOCK_COMMITS[0];
    const from = this.state.deployed?.commit ?? null;
    const failTest = opts.scenario === 'fail-test';
    const beats: Beat[] = [
      {
        step: 'fetch',
        lines: [
          'git fetch origin main',
          from?.sha === to.sha
            ? `origin/main is ${to.sha}, already deployed: deploying it again`
            : `origin/main ${from?.sha ?? '(none)'} → ${to.sha}  ${to.subject}`,
          `checks on ${to.sha}: task lint test ✓  task site:test site:check ✓`,
        ],
      },
      {
        step: 'lint',
        lines: ['task: [lint] shellcheck 0.11.0', 'task: [lint] vp check, tsc --noEmit', 'lint: no problems'],
      },
      {
        step: 'test',
        lines: failTest
          ? [
              'task: [test] stack/run-tests.sh',
              'PASS  stack/layout.test.sh',
              'FAIL  jobs/arr-reclaim/arr-reclaim.test.ts: keeps a torrent whose file was moved',
              'test: 1 suite failed',
            ]
          : [
              'task: [test] stack/run-tests.sh',
              'PASS  stack/layout.test.sh',
              'PASS  stack/deploy.test.sh',
              'PASS  jobs/arr-reclaim/arr-reclaim.test.ts',
              'PASS  bun test',
            ],
        fail: failTest,
      },
      { step: 'site:build', lines: ['task: [site:build] astro build → site/.dist-next', 'swapped site/dist'] },
      {
        step: 'install',
        lines: ['stack/install.sh → /opt/arr-setup', 'rsync: 6 files changed, 0 deleted', 'units rendered'],
      },
      {
        step: 'deploy.sh',
        lines: [
          'stack/deploy.sh',
          'units: 0 changed',
          'pms-update.timer armed (plexmediaserver is masked)',
          'restarted arr-reclaim.service',
        ],
      },
      { step: 'verify', lines: ['stack/deploy.sh --check', 'deploy: no drift'] },
    ];
    return this.play('deploy', 'main', to, beats, (ok, seconds) => {
      if (!ok && from?.sha === to.sha) return `failed at test: ${to.sha} stays live, unchanged`;
      if (!ok) return `failed at test: ${to.sha} not deployed, ${from?.sha ?? 'nothing'} still live`;
      this.state.deployed = { commit: to, at: this.now().toISOString() };
      return `deployed ${to.sha} in ${seconds} s`;
    });
  }

  restart(target: string): AsyncIterable<ControlEvent> {
    const lines =
      target === 'arr-reclaim'
        ? ['systemctl restart arr-reclaim.service', 'arr-reclaim: watching the library']
        : [`docker restart ${target}`, `${target}: stopped`, `${target}: started`, `${target}: health check passed`];
    return this.play('restart', target, null, [{ lines }], () => `${target} restarted`);
  }

  runJob(id: string): AsyncIterable<ControlEvent> {
    const lines =
      id === 'recyclarr'
        ? ['task recyclarr:sync', 'radarr: profiles and custom formats up to date', 'sonarr: profiles up to date']
        : [`systemctl start ${id}.service`, `${id}: started`, `${id}: finished (success)`];
    return this.play('job', id, null, [{ lines }], () => `${id} ran`);
  }

  checkDrift(): AsyncIterable<ControlEvent> {
    const lines = [
      'task check',
      'qbittorrent: ok',
      'prowlarr: warn  FAILING  1337x (flare)',
      'radarr: ok',
      'sonarr: ok',
      'seerr: ok',
      'bazarr: ok',
      'deploy: ok',
    ];
    return this.play('drift', 'all', null, [{ lines }], () => 'no drift, 1 warning');
  }

  /**
   * Claims the lock at the call, not at the first step, so a second click is
   * refused even before the first action's events are read.
   */
  private play(
    kind: ActionKind,
    target: string,
    commit: Commit | null,
    beats: Beat[],
    finish: (ok: boolean, seconds: number) => string,
  ): AsyncIterable<ControlEvent> {
    if (this.running) throw new BusyError(this.running);
    this.running = { kind, target };
    const started = this.now();
    const id = `${kind}-${started.getTime()}-${++this.runs}`;
    return this.steps({ id, kind, target, commit, started }, beats, finish);
  }

  private async *steps(
    run: { id: string; kind: ActionKind; target: string; commit: Commit | null; started: Date },
    beats: Beat[],
    finish: (ok: boolean, seconds: number) => string,
  ): AsyncGenerator<ControlEvent> {
    const log: string[] = [];
    let ok = true;
    try {
      for (const [i, beat] of beats.entries()) {
        if (beat.step) yield { type: 'step', step: beat.step, state: 'running' };
        for (const msg of beat.lines) {
          await this.sleep(this.lineMs);
          log.push(msg);
          yield { type: 'line', t: this.now().toISOString(), msg };
        }
        if (beat.fail) {
          ok = false;
          if (beat.step) yield { type: 'step', step: beat.step, state: 'failed' };
          for (const rest of beats.slice(i + 1)) {
            if (rest.step) yield { type: 'step', step: rest.step, state: 'skipped' };
          }
          break;
        }
        if (beat.step) yield { type: 'step', step: beat.step, state: 'ok' };
      }
      const seconds = Math.round((this.now().getTime() - run.started.getTime()) / 1000);
      const summary = finish(ok, seconds);
      const { id, kind, target, commit } = run;
      this.state.history = [
        { id, kind, target, commit, startedAt: run.started.toISOString(), seconds, ok, summary, log },
        ...this.state.history,
      ].slice(0, MAX_HISTORY);
      this.save();
      yield { type: 'done', ok, summary };
    } finally {
      this.running = null;
    }
  }

  private save() {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // full or blocked storage: the history lasts until the page is closed
    }
  }
}
