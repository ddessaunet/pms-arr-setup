// The control page's seam between the UI (control-client.ts) and whatever acts
// on the server. Today that is control-mock.ts, which only simulates: the docs
// container serves files and nothing else (apps/docs). A real backend replaces
// it by implementing ControlApi, streaming each action's events over HTTP
// (server-sent events map onto ControlEvent one to one).

/** The steps of a deploy, in order: what `task deploy` does from a source. */
export const DEPLOY_STEPS = ['fetch', 'lint', 'test', 'site:build', 'install', 'deploy.sh', 'verify'] as const;
export type DeployStep = (typeof DEPLOY_STEPS)[number];
export type StepState = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';

export type ControlEvent =
  | { type: 'step'; step: DeployStep; state: StepState }
  | { type: 'line'; t: string; msg: string }
  | { type: 'done'; ok: boolean; summary: string };

export type ActionKind = 'deploy' | 'restart' | 'job' | 'drift';

export interface Commit {
  sha: string;
  subject: string;
}

/** One finished action, as the history lists it. */
export interface RunRecord {
  id: string;
  kind: ActionKind;
  target: string;
  commit: Commit | null;
  startedAt: string;
  seconds: number;
  ok: boolean;
  summary: string;
  log: string[];
}

export interface Deployed {
  commit: Commit;
  at: string;
}

/** Which way a simulated deploy goes. A real backend ignores it. */
export type Scenario = 'success' | 'fail-test';

export interface ControlApi {
  /** The running action, or null. One at a time, as the real deploy's lock. */
  busy(): { kind: ActionKind; target: string } | null;
  deployed(): Deployed | null;
  /** Newest first. */
  history(): RunRecord[];
  /** Each throws BusyError at the call while another action runs. */
  deploy(opts?: { scenario?: Scenario }): AsyncIterable<ControlEvent>;
  restart(target: string): AsyncIterable<ControlEvent>;
  runJob(id: string): AsyncIterable<ControlEvent>;
  checkDrift(): AsyncIterable<ControlEvent>;
}

export class BusyError extends Error {
  constructor(running: { kind: ActionKind; target: string }) {
    super(`busy: ${running.kind} ${running.target} is still running`);
    this.name = 'BusyError';
  }
}
