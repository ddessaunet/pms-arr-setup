import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';
import {
  adviceLine,
  adviceParagraphs,
  byAttention,
  elapsed,
  modelLabel,
  parseAdvice,
  parseAdviseState,
  pickModel,
  parseReport,
  parseRequests,
  requestedLine,
  searchLine,
  titleOf,
  whereLine,
  type RequestReport,
} from './requests-view.ts';

const row = (over: Partial<RequestReport> = {}): RequestReport => ({
  id: 37,
  type: 'movie',
  app: 'radarr',
  title: 'Hope',
  year: 2026,
  requestedBy: 'owner',
  requestedAt: '2026-10-27T23:19:20.000Z',
  profile: 'UHD Bluray + WEB',
  seasons: [],
  verdict: { code: 'no-4k', level: 'degraded', summary: 'No 4K release yet.', details: [], next: 'Switch it.' },
  releases: null,
  canAnalyse: true,
  ...over,
});

test('parseRequests: the shape the page reads, or null', () => {
  const doc = { generatedAt: '2026-10-28T12:00:00Z', open: [row()], available: 3, errors: [] };
  assert.equal(parseRequests(doc)?.open[0]?.title, 'Hope');
  assert.equal(parseRequests({ open: [] }), null);
  assert.equal(parseRequests({ ...doc, open: [{ id: 1 }] }), null);
  assert.equal(parseReport(row())?.id, 37);
  assert.equal(parseReport({ error: 'busy' }), null);
});

const advice = {
  text: 'It is waiting.',
  provider: 'ollama',
  model: 'qwen2.5:3b',
  at: '2026-10-28T11:58:00Z',
  seconds: 38.4,
};
const qwen = { id: 'ollama/qwen2.5:3b', provider: 'ollama', model: 'qwen2.5:3b' };
const llama = { id: 'ollama/llama3.2', provider: 'ollama', model: 'llama3.2' };

test('parseRequests: the AI fields are optional', () => {
  const doc = { generatedAt: '2026-10-28T12:00:00Z', open: [row({ advice })], available: 0, errors: [] };
  assert.equal(parseRequests(doc)?.ai, undefined);
  assert.equal(parseRequests({ ...doc, ai: null })?.ai, null);
  assert.equal(parseRequests({ ...doc, ai: { models: [qwen], default: qwen.id } })?.ai?.default, qwen.id);
  assert.equal(parseRequests(doc)?.open[0]?.advice?.model, 'qwen2.5:3b');
});

test('parseAdvice: the shape the panel reads, or null', () => {
  assert.equal(parseAdvice(advice)?.text, 'It is waiting.');
  assert.equal(parseAdvice({ ...advice, seconds: '38' }), null);
  assert.equal(parseAdvice({ error: 'not found' }), null);
  assert.equal(parseAdvice(null), null);
});

test('parseAdviseState: each state, or null', () => {
  const job = { id: 37, model: 'qwen2.5:3b', startedAt: '2026-10-28T12:00:00Z' };
  assert.deepEqual(parseAdviseState({ state: 'running', job }), { state: 'running', job });
  assert.equal(parseAdviseState({ state: 'running', job: { id: 37 } }), null);
  assert.equal(parseAdviseState({ state: 'done', advice })?.state, 'done');
  assert.equal(parseAdviseState({ state: 'done', advice: {} }), null);
  assert.deepEqual(parseAdviseState({ state: 'failed', error: 'boom' }), { state: 'failed', error: 'boom' });
  assert.deepEqual(parseAdviseState({ state: 'idle' }), { state: 'idle' });
  assert.equal(parseAdviseState({ error: 'not found' }), null);
});

test('elapsed: minutes and seconds', () => {
  const now = Date.parse('2026-10-28T12:03:05Z');
  assert.equal(elapsed('2026-10-28T12:00:00Z', now), '3:05');
  assert.equal(elapsed('2026-10-28T12:02:23Z', now), '0:42');
  assert.equal(elapsed('later', now), '0:00');
});

test('adviceLine: the model, when, and how long', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  assert.equal(adviceLine(advice, now), 'AI · qwen2.5:3b · 2 min ago · took 38 s');
  assert.equal(adviceLine({ ...advice, at: 'nope' }, now), 'AI · qwen2.5:3b · took 38 s');
});

test('adviceParagraphs: split on blank lines, empty ones dropped, capped', () => {
  assert.deepEqual(adviceParagraphs('One.\n\n  \n\nTwo,\nstill two.\n\nNext: switch it.  '), [
    'One.',
    'Two,\nstill two.',
    'Next: switch it.',
  ]);
  assert.deepEqual(adviceParagraphs('   '), []);
  assert.equal(adviceParagraphs(Array.from({ length: 20 }, (_, i) => `p${i}`).join('\n\n')).length, 8);
  assert.equal(adviceParagraphs('x'.repeat(2000))[0]?.length, 1201);
});

test('modelLabel: the provider only when there is more than one', () => {
  assert.equal(modelLabel(llama, [qwen, llama]), 'llama3.2');
  const claude = { id: 'anthropic/claude-haiku-5-5', provider: 'anthropic', model: 'claude-haiku-5-5' };
  assert.equal(modelLabel(llama, [qwen, llama, claude]), 'llama3.2 (ollama)');
});

test('pickModel: the stored choice while listed, else the default, else the first', () => {
  const ai = { models: [qwen, llama], default: qwen.id };
  assert.equal(pickModel(ai, llama.id)?.id, llama.id);
  assert.equal(pickModel(ai, 'ollama/gone')?.id, qwen.id);
  assert.equal(pickModel(ai, null)?.id, qwen.id);
  assert.equal(pickModel({ models: [llama], default: 'ollama/gone' }, null)?.id, llama.id);
  assert.equal(pickModel({ models: [], default: '' }, null), null);
});

test('titleOf: the year once, and the requested seasons', () => {
  assert.equal(titleOf(row()), 'Hope (2026)');
  assert.equal(
    titleOf(row({ title: 'Dark Matter (2024)', year: 2024, type: 'tv', seasons: [2] })),
    'Dark Matter (2024), season 2',
  );
  assert.equal(titleOf(row({ type: 'tv', seasons: [1, 2] })), 'Hope (2026), seasons 1, 2');
  assert.equal(titleOf(row({ year: null })), 'Hope');
});

test('requestedLine and whereLine', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  assert.equal(requestedLine(row(), now), 'requested by owner today');
  assert.equal(requestedLine(row({ requestedAt: '2026-10-25T12:00:00Z' }), now), 'requested by owner 3 days ago');
  assert.equal(whereLine(row()), 'Radarr · UHD Bluray + WEB');
  assert.equal(whereLine(row({ app: 'sonarr', profile: null })), 'Sonarr');
});

test('searchLine', () => {
  assert.equal(searchLine(null), '');
  const s = {
    searchedAt: 0,
    total: 128,
    matched: 19,
    approved: 0,
    byResolution: {},
    reasons: [],
    best: null,
    oversize: null,
  };
  assert.equal(searchLine(s), 'Last search: 128 results, 19 for it, none acceptable.');
});

test('byAttention: down, degraded, unknown, then ok; newest first within', () => {
  const rows = [
    row({ id: 1, verdict: { ...row().verdict, level: 'ok' } }),
    row({ id: 2, verdict: { ...row().verdict, level: 'unknown' } }),
    row({ id: 3, verdict: { ...row().verdict, level: 'down' } }),
    row({ id: 4, requestedAt: '2026-10-28T00:00:00Z' }),
    row({ id: 5 }),
  ];
  assert.deepEqual(
    rows.sort(byAttention).map((r) => r.id),
    [3, 4, 5, 2, 1],
  );
});
