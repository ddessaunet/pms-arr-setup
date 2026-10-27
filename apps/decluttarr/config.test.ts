// apps/decluttarr/config.test.ts — guards apps/decluttarr/config.yaml and its compose service.
//
// Offline, and changes nothing: reads the two files as text.
//
// Decluttarr turns a job ON as soon as its key is listed under `jobs:`, even with
// no value, and the jobs left out (remove_orphans, remove_unmonitored, ...) would
// remove torrents that are seeding or that arr-reclaim is meant to judge. So the
// enabled set is pinned here, exactly (trap 14). The behaviour — a listed job with
// no value enabled, three strikes then removal on the fourth check, the removal
// going through the arr queue as blocklist + downloadFailed + a new search, !ENV
// for secrets and test_run, remove_slow reading qBittorrent's dl_rate_limit, and
// the detect_deletions watcher starting even when unlisted — was checked against
// a throwaway Decluttarr v2.1.0 with a throwaway Radarr and qBittorrent 5.2. The
// remove_failed_imports patterns were checked the same way (2026-10-08, Sonarr
// 4.0.20, qBittorrent 5.2.4): exe-only torrents removed on the first pass, a
// folder of .exe + .nfo and a video beside an .exe left alone.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXCLUDED_EXTS } from '../qbittorrent/excluded.ts';

const CONF = readFileSync(resolve(import.meta.dir, 'config.yaml'), 'utf8').split('\n');
const COMPOSE = readFileSync(resolve(import.meta.dir, 'compose.yaml'), 'utf8').split('\n');

/** The lines of a top-level section, up to the next top-level key (comments don't end it). */
function section(name: string): string[] {
  const out: string[] = [];
  let on = false;
  for (const line of CONF) {
    if (/^[^ #]/.test(line)) {
      on = line.split(/\s+/)[0] === `${name}:`;
      continue;
    }
    if (on) out.push(line);
  }
  return out;
}

/** Keys directly under a top-level section. */
const sectionKeys = (name: string) =>
  section(name).flatMap((l) => (/^ {2}[a-z_]+:/.test(l) ? [l.trim().split(':')[0] ?? ''] : []));

/** The value of "  key: value" inside a top-level section (first match), trailing comment dropped. */
function sectionValue(name: string, key: string): string | undefined {
  for (const l of section(name)) {
    const words = l.trim().split(/\s+/);
    if (words[0] === `${key}:`)
      return words
        .slice(1)
        .join(' ')
        .replace(/ +#.*$/, '');
  }
  return undefined;
}

/** The lines of one job's block under jobs:. */
function job(name: string): string[] {
  const lines = section('jobs');
  const start = lines.findIndex((l) => l.startsWith(`  ${name}:`));
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}[a-z]/.test(l));
  return end < 0 ? rest : rest.slice(0, end);
}

/** The decluttarr service block of apps/decluttarr/compose.yaml. */
function composeBlock(): string[] {
  const start = COMPOSE.findIndex((l) => l.startsWith('  decluttarr:'));
  if (start < 0) return [];
  const rest = COMPOSE.slice(start + 1);
  const end = rest.findIndex((l) => /^[^ #]/.test(l));
  return [COMPOSE[start] ?? '', ...(end < 0 ? rest : rest.slice(0, end))];
}

// ─── jobs ─────────────────────────────────────────────────────────────────────
describe('jobs', () => {
  test('exactly stalled, slow, missing metadata and executables — nothing else', () =>
    expect(sectionKeys('jobs').sort()).toEqual([
      'remove_failed_imports',
      'remove_metadata_missing',
      'remove_slow',
      'remove_stalled',
    ]));
  for (const j of [
    'remove_orphans',
    'remove_unmonitored',
    'remove_missing_files',
    'remove_failed_downloads',
    'remove_bad_files',
    'remove_done_seeding',
    'search_missing',
    'search_unmet_cutoff',
    'detect_deletions',
  ]) {
    test(`${j} is not listed (listed = on)`, () =>
      expect(CONF.filter((l) => new RegExp(`^\\s+${j}:`).test(l))).toEqual([]));
  }
  test('slow means under 500 KB/s', () =>
    expect(
      job('remove_slow').flatMap((l) => (l.trim().startsWith('min_speed:') ? [l.trim().split(/\s+/)[1]] : [])),
    ).toEqual(['500']));
  test('three strikes before a removal', () => expect(sectionValue('job_defaults', 'max_strikes')).toBe('3'));
});

// remove_failed_imports with no message_patterns defaults to "*": it would then
// remove (with its data) and blocklist every download stuck for any reason. So
// the patterns are pinned: the executable warning, plus one "No files found …
// in *.<ext>" per name qBittorrent excludes, and nothing that matches anything.
describe('remove_failed_imports patterns', () => {
  const block = job('remove_failed_imports');
  const pats = block.flatMap((l) => {
    const m = /^ {6}- "(.*)"$/.exec(l);
    return m ? [m[1] ?? ''] : [];
  });
  test('message_patterns is set', () => expect(block.filter((l) => l.includes('message_patterns:'))).toHaveLength(1));
  test('no catch-all pattern', () =>
    expect(pats.filter((p) => ['*', '**', 'No files found are eligible for import in *'].includes(p))).toEqual([]));
  test("the app's executable warning", () =>
    expect(pats.filter((p) => p === 'Caution: Found executable file*')).toHaveLength(1));
  // Each pattern for a name qBittorrent skips, in either case: *.[eE][xX][eE].
  const want = EXCLUDED_EXTS.map(
    (e) =>
      `No files found are eligible for import in *.${[...e].map((c) => `[${c.toLowerCase()}${c.toUpperCase()}]`).join('')}`,
  );
  test('one pattern per qBittorrent excluded name, nothing else', () =>
    expect(pats.filter((p) => p.startsWith('No files found'))).toEqual(want));
  test('and no other kind of pattern', () =>
    expect(
      pats.filter(
        (p) =>
          !/^(Caution: Found executable file\*|No files found are eligible for import in \*\.(\[[a-z][A-Z]\])+)$/.test(
            p,
          ),
      ),
    ).toEqual([]));
});

// ─── general ──────────────────────────────────────────────────────────────────
describe('general', () => {
  test('test mode comes from the environment', () =>
    expect(sectionValue('general', 'test_run')).toBe('!ENV DECLUTTARR_TEST_RUN'));
  test('a check every 10 minutes', () => expect(sectionValue('general', 'timer')).toBe('10'));
});

// ─── instances and secrets ────────────────────────────────────────────────────
describe('instances', () => {
  const text = CONF.join('\n');
  test('radarr and sonarr, by service name', () =>
    expect([...text.matchAll(/base_url: "(http:\/\/(?:radarr|sonarr):\d+)"/g)].map((m) => m[1])).toEqual([
      'http://radarr:7878',
      'http://sonarr:8989',
    ]));
  test('the :8081 qBittorrent, by its allowlisted name', () =>
    expect(CONF.filter((l) => l.includes('base_url: "http://qbittorrent:8081"'))).toHaveLength(1));
  test('named as the arrs know it', () =>
    expect(CONF.filter((l) => l.includes('name: "qBittorrent"'))).toHaveLength(1));
  test('every secret is !ENV, none inline', () => {
    const secrets = CONF.filter((l) => /(api_key|username|password):/.test(l));
    expect([
      secrets.filter((l) => /(api_key|username|password): !ENV [A-Z_]+$/.test(l)).length,
      secrets.filter((l) => !l.includes('!ENV')).length,
    ]).toEqual([4, 0]);
  });
});

// ─── compose ──────────────────────────────────────────────────────────────────
describe('compose service', () => {
  const B = composeBlock();
  test('service exists', () => expect(B.filter((l) => l.startsWith('  decluttarr:'))).toHaveLength(1));
  test('pinned to a v2 release, not latest', () =>
    expect(B.filter((l) => /image: ghcr\.io\/manimatter\/decluttarr:v2\.\d+\.\d+$/.test(l))).toHaveLength(1));
  test('config mounted read-only', () =>
    expect(B.filter((l) => l.includes('./config.yaml:/app/config/config.yaml:ro'))).toHaveLength(1));
  // detect_deletions runs whether listed or not; without the library mounted it
  // has nothing to watch.
  test('no /mnt/data mount', () => expect(B.filter((l) => l.includes('/mnt/data'))).toEqual([]));
  test('test mode off unless asked', () =>
    expect(B.filter((l) => l.includes('DECLUTTARR_TEST_RUN: ${DECLUTTARR_TEST_RUN:-false}'))).toHaveLength(1));
});
