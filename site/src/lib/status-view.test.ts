// Unit tests for status-view.ts: `task site:test` (node --test, no build).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageSeconds, clock, formatAgo, isStale, levelText, parseLogs, parseStatus, serviceUrl } from './status-view.ts';

test('links follow the address the page was opened on', () => {
  assert.equal(serviceUrl({ protocol: 'http:', hostname: '192.168.0.86' }, 7878, '/'), 'http://192.168.0.86:7878/');
  assert.equal(serviceUrl({ protocol: 'http:', hostname: '192.168.0.67' }, 32400, '/web'), 'http://192.168.0.67:32400/web');
  assert.equal(serviceUrl({ protocol: 'http:', hostname: '[fd00::1]' }, 8081, '/'), 'http://[fd00::1]:8081/');
  assert.equal(serviceUrl({ protocol: 'https:', hostname: 'pms' }, 5055, '/'), 'https://pms:5055/');
});

test('age comes from the server clock, not the viewer’s', () => {
  const generated = 1791500000;                       // 22:53:20 UTC
  const serverDate = new Date((generated + 40) * 1000).toUTCString();
  const phoneWrongBy10Min = (generated + 40 + 600) * 1000;
  assert.equal(ageSeconds(generated, serverDate, phoneWrongBy10Min, phoneWrongBy10Min), 40);
  assert.equal(ageSeconds(generated, serverDate, phoneWrongBy10Min, phoneWrongBy10Min + 15000), 55);
  assert.equal(ageSeconds(generated, null, (generated + 7) * 1000, (generated + 7) * 1000), 7, 'no Date header: the browser clock');
  assert.equal(ageSeconds(generated, 'garbage', (generated - 5) * 1000, (generated - 5) * 1000), 0, 'never negative');
});

test('stale past staleAfterSeconds', () => {
  assert.equal(isStale(360, 360), false);
  assert.equal(isStale(361, 360), true);
});

test('ages read like the job writes them', () => {
  assert.deepEqual([45, 200, 7200, 259200].map(formatAgo), ['45 s', '3 min', '2 h', '3 d']);
});

test('a level is always a word and a mark', () => {
  assert.equal(levelText('ok'), '● OK');
  assert.equal(levelText('down'), '✕ Down');
  assert.equal(levelText('degraded', true), 'Stale (was ◐ Degraded)');
  assert.equal(levelText('bogus' as never), '? Unknown');
});

test('parseStatus refuses what the page cannot show', () => {
  const ok = { schema: 1, generatedAtEpoch: 1, staleAfterSeconds: 360, overall: 'ok', apps: [], host: [] };
  assert.ok(parseStatus(ok));
  assert.equal(parseStatus(null), null);
  assert.equal(parseStatus('x'), null);
  assert.equal(parseStatus({ ...ok, schema: 2 }), null, 'a newer job than the page');
  assert.equal(parseStatus({ ...ok, overall: 'great' }), null);
  assert.equal(parseStatus({ ...ok, apps: {} }), null);
  assert.ok(parseLogs({ schema: 1, sources: [] }));
  assert.equal(parseLogs({ schema: 1 }), null);
});

test('clock() shows nothing for a line without a time', () => {
  assert.equal(clock(null), '');
  assert.equal(clock('not a time'), '');
  assert.match(clock('2026-10-09T01:03:59.927Z'), /^\d{2}:\d{2}:\d{2}$/);
});
