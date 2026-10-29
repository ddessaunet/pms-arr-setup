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
// folder of .exe + .nfo and a video beside an .exe left alone. The archive
// patterns follow the live Sonarr's message for a single-.7z fake (2026-10-23)
// and the same text in Radarr's and Sonarr's import code (ProcessFile).

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXCLUDED_EXTS } from '../qbittorrent/excluded.ts';

/** Archive types whose single-file downloads remove_failed_imports clears. */
const ARCHIVE_EXTS = ['7z', 'zip', 'rar'];

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

/** Python's fnmatch.fnmatchcase: * any run, ? one character, [..] a set ([!..] negated). */
function fnmatch(text: string, pattern: string): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] ?? '';
    const close = c === '[' ? pattern.indexOf(']', i + 2) : -1;
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (close > 0) {
      const set = pattern.slice(i + 1, close).replace(/\\/g, '\\\\');
      re += set.startsWith('!') ? `[^${set.slice(1)}]` : `[${set}]`;
      i = close;
    } else re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 's').test(text);
}

// ─── jobs ─────────────────────────────────────────────────────────────────────
describe('jobs', () => {
  test('exactly stalled, slow, missing metadata and fakes — nothing else', () =>
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
// the patterns are pinned: the executable warning, one "No files found … in
// *.<ext>" per name qBittorrent excludes, one "unsupported extension" per
// archive type, and nothing that matches anything.
describe('remove_failed_imports patterns', () => {
  const block = job('remove_failed_imports');
  const pats = block.flatMap((l) => {
    const m = /^ {6}- "(.*)"$/.exec(l);
    return m ? [m[1] ?? ''] : [];
  });
  /** Either case, letter by letter: exe → [eE][xX][eE], 7z → 7[zZ]. */
  const anyCase = (e: string) => [...e].map((c) => (/[a-z]/.test(c) ? `[${c}${c.toUpperCase()}]` : c)).join('');
  test('message_patterns is set', () => expect(block.filter((l) => l.includes('message_patterns:'))).toHaveLength(1));
  test('no catch-all pattern', () =>
    expect(
      pats.filter((p) =>
        [
          '*',
          '**',
          'No files found are eligible for import in *',
          "Invalid video file, unsupported extension: '*'",
          'Invalid video file, unsupported extension: *',
        ].includes(p),
      ),
    ).toEqual([]));
  test("the app's executable warning", () =>
    expect(pats.filter((p) => p === 'Caution: Found executable file*')).toHaveLength(1));
  test('one pattern per qBittorrent excluded name, nothing else', () =>
    expect(pats.filter((p) => p.startsWith('No files found'))).toEqual(
      EXCLUDED_EXTS.map((e) => `No files found are eligible for import in *.${anyCase(e)}`),
    ));
  // Radarr/Sonarr say this for a download that is one file without a video
  // extension. Archives only: nothing unpacks them, so none could be imported.
  test('one pattern per archive type, nothing else', () =>
    expect(pats.filter((p) => p.startsWith('Invalid video file'))).toEqual(
      ARCHIVE_EXTS.map((e) => `Invalid video file, unsupported extension: '.${anyCase(e)}'`),
    ));
  test('and no other kind of pattern', () =>
    expect(
      pats.filter(
        (p) =>
          !/^(Caution: Found executable file\*|No files found are eligible for import in \*\.(\[[a-z][A-Z]\])+|Invalid video file, unsupported extension: '\.(\[[a-z][A-Z]\]|[0-9])+')$/.test(
            p,
          ),
      ),
    ).toEqual([]));

  // What they match, through Python's fnmatch as Decluttarr calls it (case-sensitive
  // on Linux): the live fakes' messages go, anything else stays.
  const removed = (msg: string) => pats.some((p) => fnmatch(msg, p));
  for (const msg of [
    "Invalid video file, unsupported extension: '.7z'",
    "Invalid video file, unsupported extension: '.7Z'",
    "Invalid video file, unsupported extension: '.zip'",
    "Invalid video file, unsupported extension: '.RAR'",
    'No files found are eligible for import in /mnt/data/torrents/tv/Scrubs.2026.S02E04.1080p.WEB.H264-CAKES.exe',
    "Caution: Found executable file with extension: '.exe'",
  ]) {
    test(`removes: ${msg}`, () => expect(removed(msg)).toBe(true));
  }
  for (const msg of [
    "Invalid video file, unsupported extension: '.mkv'",
    "Invalid video file, unsupported extension: '.nfo'",
    "Invalid video file, unsupported extension: '.001'",
    "Invalid video file, unsupported extension: '.7z.001'",
    "Invalid video file, unsupported extension: ''",
    'No files found are eligible for import in /mnt/data/torrents/tv/Scrubs.2026.S02E06.1080p.WEB.H264-EZTV',
    'No files found are eligible for import in /mnt/data/torrents/tv/Show.S01E01.7z',
    'Episode file already imported at 2026-10-23 05:00:00',
    'Not an upgrade for existing episode file(s)',
  ]) {
    test(`keeps: ${msg}`, () => expect(removed(msg)).toBe(false));
  }
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
