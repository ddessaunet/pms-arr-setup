// jobs/arr-fallback-search/arr-fallback-search.test.ts — unit fixtures for arr-fallback-search.ts,
// the one name it shares with recyclarr.yml and arr-configure.sh, and main
// against a fake Radarr.
//
// Offline, and changes nothing. The movie fields (qualityProfileId, monitored,
// isAvailable, movieFile.quality.quality.resolution) are Radarr 6's /api/v3/movie.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { HttpRequest, HttpResponse } from '../../stack/lib/http.ts';
import {
  FALLBACK_PROFILE,
  fallbackIds,
  fallbackTitles,
  main,
  profileIdOf,
  type Movie,
  type QualityProfile,
} from './arr-fallback-search.ts';

const ROOT = resolve(import.meta.dir, '../..');

// ─── which movies get searched ────────────────────────────────────────────────
const M: Movie[] = [
  {
    id: 1,
    title: 'Inception',
    year: 2010,
    qualityProfileId: 8,
    monitored: true,
    isAvailable: true,
    movieFile: { quality: { quality: { name: 'WEBDL-1080p', resolution: 1080 } } },
  },
  {
    id: 2,
    title: 'Dune',
    year: 2021,
    qualityProfileId: 8,
    monitored: true,
    isAvailable: true,
    movieFile: { quality: { quality: { name: 'WEBDL-2160p', resolution: 2160 } } },
  },
  {
    id: 3,
    title: 'Air',
    year: 2023,
    qualityProfileId: 7,
    monitored: true,
    isAvailable: true,
    movieFile: { quality: { quality: { name: 'WEBDL-1080p', resolution: 1080 } } },
  },
  {
    id: 4,
    title: 'Heat',
    year: 1995,
    qualityProfileId: 8,
    monitored: false,
    isAvailable: true,
    movieFile: { quality: { quality: { name: 'Bluray-1080p', resolution: 1080 } } },
  },
  { id: 5, title: 'Brick', year: 2005, qualityProfileId: 8, monitored: true, isAvailable: true },
  { id: 6, title: 'Soon', year: 2027, qualityProfileId: 8, monitored: true, isAvailable: false },
];

describe('fallback_ids / fallback_titles', () => {
  test('1080p and no-file movies on the profile, nothing else', () => expect(fallbackIds(M, 8)).toEqual([1, 5]));
  test('a 4K file is left to RSS', () => expect(fallbackIds(M, 8)).not.toContain(2));
  test('another profile is never touched', () => expect(fallbackIds(M, 8)).not.toContain(3));
  test('unmonitored is never searched', () => expect(fallbackIds(M, 8)).not.toContain(4));
  test('not released yet is not searched', () => expect(fallbackIds(M, 8)).not.toContain(6));
  test('empty library → empty list', () => expect(fallbackIds([], 8)).toEqual([]));
  test('titles for the log', () =>
    expect(fallbackTitles(M, [1, 5])).toEqual(['Inception (2010) — WEBDL-1080p', 'Brick (2005) — no file']));
});

describe('profile_id_of', () => {
  const P: QualityProfile[] = [
    { id: 7, name: 'UHD Bluray + WEB' },
    { id: 8, name: '4K HDR or 1080p' },
  ];
  test('found by exact name', () => expect(profileIdOf(P, FALLBACK_PROFILE)).toBe(8));
  test('missing → empty', () =>
    expect(profileIdOf([{ id: 7, name: 'UHD Bluray + WEB' }], FALLBACK_PROFILE)).toBe(undefined));
});

// ─── one name, three owners ───────────────────────────────────────────────────
// Recyclarr creates the profile, arr-configure.sh keeps its upgrades on, and this
// script finds it — all by name. A rename in one place must fail here (trap 11).
describe('the profile name across files', () => {
  test('recyclarr.yml creates it', () => {
    const yml = readFileSync(resolve(ROOT, 'apps/recyclarr/recyclarr.yml'), 'utf8');
    expect(yml.split('\n').filter((l) => l === `        name: ${FALLBACK_PROFILE}`)).toHaveLength(1);
  });
  test('arr-configure.sh lets it upgrade', () => {
    const r = Bun.spawnSync(['bash', '-c', '. ./stack/lib/arr-configure.sh && upgrade_profiles radarr'], {
      cwd: ROOT,
      env: { ...process.env, ARR_CONFIGURE_LIB: '1' },
    });
    expect(r.stdout.toString().split('\n')).toContain(FALLBACK_PROFILE);
  });
  test('the timer runs this script', () => {
    const unit = readFileSync(resolve(ROOT, 'jobs/arr-fallback-search/arr-fallback-search.service'), 'utf8');
    const execStart = unit.split('\n').flatMap((l) => (l.startsWith('ExecStart=') ? [l.slice(10)] : []));
    expect(execStart).toEqual(['@PMS_HOME@/jobs/arr-fallback-search/arr-fallback-search.sh']);
  });
});

// ─── main, against a fake Radarr ──────────────────────────────────────────────
type Route = (req: HttpRequest) => { status: number; json?: unknown };

const PROFILES: QualityProfile[] = [
  { id: 7, name: 'UHD Bluray + WEB' },
  { id: 8, name: FALLBACK_PROFILE },
];

/** A fake Radarr routed by "METHOD /path"; a missing route is a 404. */
function run(argv: string[], routes: Record<string, Route>, env: Record<string, string> = { RADARR_API_KEY: 'k' }) {
  const calls: (HttpRequest & { url: string })[] = [];
  const lines: string[] = [];
  let clock = 0;
  const code = main(argv, {
    http: async (url, req): Promise<HttpResponse> => {
      calls.push({ url, ...req });
      const path = url.replace(/^http:\/\/[^/]+\/api\/v3/, '');
      const route = routes[`${req.method ?? 'GET'} ${path}`];
      const r = route ? route(req) : { status: 404 };
      const text = r.json === undefined ? '' : JSON.stringify(r.json);
      return { status: r.status, text, headers: new Headers() };
    },
    log: (l) => void lines.push(l),
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    env,
    repo: '/nonexistent',
  });
  return { code, calls, lines };
}

const up: Record<string, Route> = {
  'GET /system/status': () => ({ status: 200, json: { version: '6.0.4' } }),
  'GET /qualityprofile': () => ({ status: 200, json: PROFILES }),
  'GET /movie': () => ({ status: 200, json: M }),
};

describe('main', () => {
  test('--dry-run lists the movies and sends nothing', async () => {
    const { code, calls, lines } = run(['--dry-run'], up);
    expect(await code).toBe(0);
    expect(lines).toEqual([
      "2 '4K HDR or 1080p' movie(s) without a 4K file:",
      '  Inception (2010) — WEBDL-1080p',
      '  Brick (2005) — no file',
      'Dry run: nothing searched.',
    ]);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  test('queues one MoviesSearch for those ids', async () => {
    const { code, calls, lines } = run([], { ...up, 'POST /command': () => ({ status: 201, json: { id: 42 } }) });
    expect(await code).toBe(0);
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('http://127.0.0.1:7878/api/v3/command');
    expect(JSON.parse(String(post?.body))).toEqual({ name: 'MoviesSearch', movieIds: [1, 5] });
    expect(post?.headers?.['X-Api-Key']).toBe('k');
    expect(lines.at(-1)).toBe("Search queued (Radarr command 42); grabs show in Radarr's queue.");
  });

  test('a refused search is 1, with the error', async () => {
    const { code, lines } = run([], {
      ...up,
      'POST /command': () => ({ status: 400, json: [{ errorMessage: 'nope' }] }),
    });
    expect(await code).toBe(1);
    expect(lines.at(-1)).toBe('FAIL  queue the search (HTTP 400): nope');
  });

  test('nothing to search is 0', async () => {
    const { code, lines } = run([], { ...up, 'GET /movie': () => ({ status: 200, json: [M[1]] }) });
    expect(await code).toBe(0);
    expect(lines).toEqual(["Nothing to search: no monitored '4K HDR or 1080p' movie is without a 4K file."]);
  });

  test('no such profile is 1', async () => {
    const { code, lines } = run([], { ...up, 'GET /qualityprofile': () => ({ status: 200, json: [PROFILES[0]] }) });
    expect(await code).toBe(1);
    expect(lines).toEqual(["No '4K HDR or 1080p' profile in Radarr — task recyclarr:sync"]);
  });

  test('a failed read is 1', async () => {
    const { code, lines } = run([], { ...up, 'GET /movie': () => ({ status: 500 }) });
    expect(await code).toBe(1);
    expect(lines).toEqual(['FAIL  read movies (HTTP 500)']);
  });

  test('no API key is 3', async () => {
    const { code, calls, lines } = run([], up, {});
    expect(await code).toBe(3);
    expect(lines).toEqual(['RADARR_API_KEY is not set in /nonexistent/.env']);
    expect(calls).toEqual([]);
  });

  test('a wrong key is 3 at once, with its status', async () => {
    const { code, calls, lines } = run([], { 'GET /system/status': () => ({ status: 401 }) });
    expect(await code).toBe(3);
    expect(calls).toHaveLength(1);
    expect(lines).toEqual(['Radarr at http://127.0.0.1:7878 is not answering with RADARR_API_KEY (HTTP 401)']);
  });

  test('unreachable is 3 after ARR_WAIT, as HTTP 000', async () => {
    const { code, calls, lines } = run(
      [],
      { 'GET /system/status': () => ({ status: 0 }) },
      { RADARR_API_KEY: 'k', RADARR_URL: 'http://radarr:7878', ARR_WAIT: '9' },
    );
    expect(await code).toBe(3);
    expect(calls).toHaveLength(4); // at 0, 3, 6 and 9 seconds
    expect(lines).toEqual(['Radarr at http://radarr:7878 is not answering with RADARR_API_KEY (HTTP 000)']);
  });

  test('ARR_TIMEOUT is per request, in seconds', async () => {
    const { code, calls } = run(['--dry-run'], up, { RADARR_API_KEY: 'k', ARR_TIMEOUT: '5' });
    expect(await code).toBe(0);
    expect(calls.every((c) => c.timeoutMs === 5000)).toBe(true);
  });

  test('a word it does not know is a usage error', async () => {
    await expect(run(['--now'], up).code).rejects.toThrow('usage: arr-fallback-search.sh [--dry-run]');
  });

  test('-h prints the header, and the header documents the exit codes', async () => {
    const { code, lines } = run(['-h'], up);
    expect(await code).toBe(0);
    expect(lines[0]).toStartWith('jobs/arr-fallback-search/arr-fallback-search.ts — ask Radarr');
    expect(lines[0]).toContain('Exit: 0 searched, or nothing to search · 1 the profile is missing');
  });
});
