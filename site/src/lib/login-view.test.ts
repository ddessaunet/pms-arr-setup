import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';
import { loginUrl, pinAnswer, safeNext } from './login-view.ts';

test('safeNext: a path on this site, else the front page', () => {
  assert.equal(safeNext('/logs/'), '/logs/');
  assert.equal(safeNext('/control/?x=1'), '/control/?x=1');
  for (const bad of [
    null,
    '',
    'logs/',
    'http://evil.test/',
    '//evil.test/',
    '/\\evil.test',
    '/login/',
    '/login',
    '/a\nb',
  ])
    assert.equal(safeNext(bad), '/', String(bad));
});

test('loginUrl: the path comes back encoded', () => {
  assert.equal(loginUrl('/control/?a=1&b=2'), '/login/?next=%2Fcontrol%2F%3Fa%3D1%26b%3D2');
  assert.equal(
    safeNext(new URLSearchParams(loginUrl('/control/?a=1&b=2').split('?')[1]).get('next')),
    '/control/?a=1&b=2',
  );
});

test('pinAnswer: what each poll means', () => {
  assert.deepEqual(pinAnswer(200, { state: 'ok', username: 'o' }), { kind: 'ok' });
  assert.deepEqual(pinAnswer(200, { state: 'pending' }), { kind: 'pending' });
  assert.deepEqual(pinAnswer(403, { state: 'denied', error: 'owner only' }), { kind: 'denied', text: 'owner only' });
  assert.deepEqual(pinAnswer(410, { state: 'expired' }), { kind: 'expired' });
  assert.deepEqual(pinAnswer(502, { error: 'plex.tv did not answer; try again' }), {
    kind: 'error',
    text: 'plex.tv did not answer; try again',
  });
  assert.deepEqual(pinAnswer(503, null), { kind: 'error', text: 'stack-api answered 503' });
});
