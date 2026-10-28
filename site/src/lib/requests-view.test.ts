import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';
import {
  byAttention,
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
