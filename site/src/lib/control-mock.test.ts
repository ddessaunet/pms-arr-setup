// Unit tests for control-mock.ts and control-view.ts: `task site:test`.

import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BusyError, DEPLOY_STEPS, type ControlEvent } from './control-api.ts';
import { MOCK_COMMITS, MockControlApi } from './control-mock.ts';
import { driftRows, jobRows, runningRows } from './control-view.ts';
import { parseStatus } from './status-view.ts';

const instant = () => Promise.resolve();
const fixedNow = () => new Date('2026-10-27T12:00:00Z');

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

async function drain(events: AsyncIterable<ControlEvent>): Promise<ControlEvent[]> {
  const out: ControlEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const steps = (events: ControlEvent[]) => events.flatMap((e) => (e.type === 'step' ? [`${e.step}:${e.state}`] : []));

test('a deploy walks every step in order and moves the deployed commit', async () => {
  const api = new MockControlApi({ sleep: instant, now: fixedNow });
  assert.notEqual(api.deployed()?.commit.sha, MOCK_COMMITS[0].sha, 'the seed starts one commit behind main');

  const events = await drain(api.deploy());
  assert.deepEqual(
    steps(events),
    DEPLOY_STEPS.flatMap((s) => [`${s}:running`, `${s}:ok`]),
  );
  const done = events.at(-1);
  assert.equal(done?.type, 'done');
  assert.ok(done?.type === 'done' && done.ok);
  assert.equal(api.deployed()?.commit.sha, MOCK_COMMITS[0].sha);
  assert.equal(api.history()[0].kind, 'deploy');
  assert.ok(api.history()[0].ok);
});

test('a failing test stops the deploy, skips the rest and keeps the old commit', async () => {
  const api = new MockControlApi({ sleep: instant, now: fixedNow });
  const before = api.deployed()?.commit.sha;

  const events = await drain(api.deploy({ scenario: 'fail-test' }));
  assert.deepEqual(steps(events), [
    'fetch:running',
    'fetch:ok',
    'lint:running',
    'lint:ok',
    'test:running',
    'test:failed',
    'site:build:skipped',
    'install:skipped',
    'deploy.sh:skipped',
    'verify:skipped',
  ]);
  const done = events.at(-1);
  assert.ok(done?.type === 'done' && !done.ok);
  assert.equal(api.deployed()?.commit.sha, before);
  assert.equal(api.history()[0].ok, false);
});

test('one action at a time, refused at the call, free again once it ends', async () => {
  const api = new MockControlApi({ sleep: instant, now: fixedNow });
  const first = api.restart('bazarr');
  assert.deepEqual(api.busy(), { kind: 'restart', target: 'bazarr' });
  assert.throws(() => api.deploy(), BusyError);
  assert.throws(() => api.runJob('pms-update'), BusyError);

  await drain(first);
  assert.equal(api.busy(), null);
  await drain(api.checkDrift());
  assert.deepEqual(
    api
      .history()
      .slice(0, 2)
      .map((r) => `${r.kind} ${r.target}`),
    ['drift all', 'restart bazarr'],
  );
});

test('the history survives a reload through storage, and bad storage falls back to the seed', async () => {
  const storage = memoryStorage();
  const api = new MockControlApi({ sleep: instant, now: fixedNow, storage });
  await drain(api.runJob('arr-fallback-search'));

  const reloaded = new MockControlApi({ sleep: instant, now: fixedNow, storage });
  assert.equal(reloaded.history()[0].target, 'arr-fallback-search');
  assert.equal(reloaded.history().length, api.history().length);

  storage.setItem('pms-control-mock', '{not json');
  assert.equal(new MockControlApi({ storage }).history().length, 3);
  const throwing = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  const blocked = new MockControlApi({ sleep: instant, storage: throwing });
  await drain(blocked.restart('arr-reclaim')); // saving fails quietly
  assert.equal(blocked.history()[0].target, 'arr-reclaim');
});

// The rows come from the job's own golden status.json, as the page gets it.
const golden = parseStatus(
  JSON.parse(readFileSync(new URL('../../../jobs/stack-status/testdata/status.golden.json', import.meta.url), 'utf8')),
);
assert.ok(golden);
const now = (golden.generatedAtEpoch + 60) * 1000;

test('running: every container with its facts, then the watcher; one-shot apps left out', () => {
  const rows = runningRows(golden, { plex: 'Plex' }, now);
  assert.ok(!rows.some((r) => r.id === 'recyclarr'));
  const plex = rows.find((r) => r.id === 'plex');
  assert.equal(plex?.name, 'Plex');
  assert.equal(plex?.version, '1.43.4');
  assert.equal(plex?.target, 'plex');
  const bazarr = rows.find((r) => r.id === 'bazarr');
  assert.equal(bazarr?.state, 'restarting');
  assert.equal(bazarr?.restarts, '5');
  assert.equal(rows.find((r) => r.id === 'decluttarr')?.state, 'running (unhealthy)');
  const last = rows.at(-1);
  assert.equal(last?.kind, 'service');
  assert.equal(last?.target, 'arr-reclaim');
  assert.equal(last?.state, 'active');
});

test('jobs: every timer, then recyclarr on demand', () => {
  const rows = jobRows(golden, now);
  assert.deepEqual(
    rows.map((r) => r.id),
    ['pms-update', 'arr-fallback-search', 'lan-address', 'stack-status', 'stack-status-drift', 'recyclarr'],
  );
  const update = rows[0];
  assert.equal(update.last, 'never');
  assert.equal(update.result, 'exit-code');
  assert.equal(update.level, 'degraded');
});

test('drift: the apps the check covers, then the deploy; a warning is degraded', () => {
  const rows = driftRows(golden, {});
  assert.deepEqual(
    rows.map((r) => `${r.id}:${r.result}:${r.level}`),
    ['prowlarr:warn:degraded', 'radarr:ok:ok', 'deploy:ok:ok'],
  );
  assert.deepEqual(rows[0].lines, ['FAILING  1337x (flare)']);
});
