// Unit tests for services-core.ts: `task site:test` (node --test, no build).
// The real files first, then each way they can disagree, which must throw.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { buildServices, published } from './services-core.ts';

const repo = new URL('../../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, repo), 'utf8');
const SERVICES = read('site/src/data/services.yml');
const COMPOSE = Object.fromEntries(
  readdirSync(new URL('apps/', repo)).map((id) => [id, read(`apps/${id}/compose.yaml`)]),
);

test('the repo as it is: every app, with its port', () => {
  const by = Object.fromEntries(buildServices(COMPOSE, SERVICES).map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(by).sort(), Object.keys(COMPOSE).sort());
  assert.deepEqual([by.plex.port, by.plex.path], [32400, '/web']);
  assert.equal(by.qbittorrent.port, 8081, 'the WebUI, not the peer port 13762');
  assert.equal(by.docs.port, 8088, 'the host side, not nginx-unprivileged’s 8080');
  for (const id of ['radarr', 'sonarr', 'prowlarr', 'seerr', 'bazarr']) assert.ok(by[id].port, id);
  for (const id of ['flaresolverr', 'recyclarr', 'decluttarr']) assert.equal(by[id].port, null, id);
});

test('services.yml order is the page order', () => {
  assert.equal(buildServices(COMPOSE, SERVICES)[0].id, 'plex');
});

const one = (ports: string) => `services:\n  x:\n    image: y\n    ports:\n${ports}`;

test('published(): host side of the first TCP mapping', () => {
  assert.equal(published('x', one('      - "13762:13762/udp"\n      - "8081:8081"\n')).port, 8081);
  assert.equal(published('x', one('      - "0.0.0.0:9000:80/tcp"\n')).port, 9000);
  assert.equal(published('x', one('      - "80"\n')).port, null, 'a random host port is no link');
  assert.equal(published('x', 'services:\n  x:\n    network_mode: host\n').hostNetwork, true);
});

test('an app without an entry throws', () => {
  assert.throws(() => buildServices({ ...COMPOSE, newapp: one('      - "1:1"\n').replace('  x:', '  newapp:') }, SERVICES), /no entry for apps\/newapp/);
});

test('an entry without an app throws', () => {
  const { docs: _gone, ...rest } = COMPOSE;
  assert.throws(() => buildServices(rest, SERVICES), /lists docs, which has no apps/);
});

test('a port with two owners throws', () => {
  const both = SERVICES.replace('{ label: Docs,', '{ label: Docs, port: 9999,');
  assert.throws(() => buildServices(COMPOSE, both), /both compose.yaml \(8088\) and services.yml \(9999\)/);
});

test('a host-network app without a port throws', () => {
  const none = SERVICES.replace(', port: 32400', '');
  assert.throws(() => buildServices(COMPOSE, none), /plex runs on the host network/);
});

test('a port bound to 127.0.0.1 throws', () => {
  const lo = { ...COMPOSE, docs: COMPOSE.docs.replace('"8088:8080"', '"127.0.0.1:8088:8080"') };
  assert.throws(() => buildServices(lo, SERVICES), /binds its port to 127.0.0.1/);
});

test('a compose file without its own service throws', () => {
  assert.throws(() => published('docs', COMPOSE.radarr), /has no service named "docs"/);
});
