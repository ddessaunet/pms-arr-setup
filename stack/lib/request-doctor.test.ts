// stack/lib/request-doctor.test.ts — one case per verdict, from hand-built
// facts. jobs/stack-api/stack-api.test.ts runs a real release search's answer
// (testdata/release-hope.json) through it end to end.

import { describe, expect, test } from 'bun:test';
import { DEFAULT_PROFILE, FALLBACK_PROFILES, VARIANT_PROFILE } from './arr-policy.ts';
import {
  ago,
  canAnalyse,
  diagnose,
  gb,
  mbPerMin,
  rejectionKind,
  report,
  summariseReleases,
  type ArrTitle,
  type Facts,
  type Release,
} from './request-doctor.ts';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const GiB = 1024 ** 3;

const movie = (over: Partial<ArrTitle> = {}): ArrTitle => ({
  app: 'radarr',
  id: 148,
  title: 'Hope',
  year: 2026,
  monitored: true,
  hasFile: false,
  profile: DEFAULT_PROFILE.radarr,
  runtime: 157,
  isAvailable: true,
  status: 'released',
  episodes: [],
  ...over,
});

const facts = (over: Partial<Facts> = {}): Facts => ({
  request: {
    id: 37,
    status: 2,
    type: 'movie',
    createdAt: '2026-10-27T23:19:20.000Z',
    requestedBy: 'owner',
    mediaStatus: 3,
    tmdbId: 1058424,
    arrId: 148,
    seasons: [],
  },
  arr: movie(),
  arrError: null,
  queue: [],
  history: [],
  releases: null,
  indexersFailing: [],
  ...over,
});

const rel = (over: Partial<Release> = {}): Release => ({
  title: 'Hope.2026.2160p.WEB-DL',
  quality: 'WEBDL-2160p',
  resolution: 2160,
  size: 20 * GiB,
  seeders: 100,
  indexer: 'Knaben',
  matched: true,
  approved: false,
  rejections: [],
  ...over,
});

const code = (f: Facts) => diagnose(f, NOW).code;

describe('helpers', () => {
  test('sizes as Radarr prints them, and MB/min', () => {
    expect(gb(7.5 * GiB)).toBe('7.5 GB');
    expect(Math.round(mbPerMin(6.1 * GiB, 157))).toBe(40);
    expect(mbPerMin(1, 0)).toBe(0);
  });
  test('ago', () => {
    expect(ago(NOW - 30_000, NOW)).toBe('30 s ago');
    expect(ago(NOW - 2 * 3600_000, NOW)).toBe('2 h ago');
    expect(ago(NOW - 3 * 86400_000, NOW)).toBe('3 days ago');
  });
  test('rejection kinds, from the apps’ own words', () => {
    expect(rejectionKind('7.5 GB is larger than maximum allowed 6.1 GB (for Hope)')).toBe('size');
    expect(rejectionKind('WEBDL-1080p is not wanted in profile')).toBe('quality');
    expect(rejectionKind("Custom Formats x265 (no HDR/DV) have score -8250 below Movie's profile minimum 0")).toBe(
      'score',
    );
    expect(rejectionKind('Not enough seeders: 2. Minimum seeders: 5')).toBe('seeders');
    expect(rejectionKind('Original Language (Korean) is wanted, but found French')).toBe('language');
    expect(rejectionKind('Release is blocklisted')).toBe('blocklisted');
    expect(rejectionKind('Existing file on disk is of equal or higher preference: WEBDL-1080p v1')).toBe('have');
    expect(rejectionKind('Something new')).toBe('other');
  });
});

describe('before any search', () => {
  test('waiting for approval', () =>
    expect(code(facts({ request: { ...facts().request, status: 1 } }))).toBe('waiting-approval'));
  test('declined', () => expect(code(facts({ request: { ...facts().request, status: 3 } }))).toBe('declined'));
  test('available', () => expect(code(facts({ request: { ...facts().request, mediaStatus: 5 } }))).toBe('available'));
  test('the app away', () => {
    const v = diagnose(facts({ arr: null, arrError: 'not answering on :7878' }), NOW);
    expect([v.code, v.level, v.summary]).toEqual([
      'app-unreachable',
      'unknown',
      'Radarr did not answer: not answering on :7878',
    ]);
  });
  test('not in Radarr', () => expect(code(facts({ arr: null }))).toBe('not-in-app'));
  test('Radarr has the file before Seerr noticed', () =>
    expect(code(facts({ arr: movie({ hasFile: true }) }))).toBe('imported'));
  test('unmonitored', () => expect(code(facts({ arr: movie({ monitored: false }) }))).toBe('unmonitored'));
  test('not released yet', () => {
    const v = diagnose(facts({ arr: movie({ isAvailable: false, status: 'inCinemas' }) }), NOW);
    expect([v.code, v.level]).toEqual(['not-released', 'ok']);
    expect(v.summary).toContain('inCinemas');
  });
});

describe('series', () => {
  const series = (episodes: ArrTitle['episodes']): Facts =>
    facts({
      request: { ...facts().request, type: 'tv', seasons: [2], mediaStatus: 4 },
      arr: movie({ app: 'sonarr', title: 'Dark Matter', profile: DEFAULT_PROFILE.sonarr, runtime: 50, episodes }),
    });
  const e = (episode: number, airDate: string, hasFile: boolean, monitored = true, season = 2) => ({
    season,
    episode,
    airDate,
    hasFile,
    monitored,
  });
  test('every aired episode in, the rest still to air', () => {
    const v = diagnose(series([e(9, '2026-10-23T04:00:00Z', true), e(10, '2026-10-30T04:00:00Z', false)]), NOW);
    expect([v.code, v.summary]).toEqual([
      'waiting-air',
      'Every aired episode is in; 1 episode still to air, next S02E10 on Fri 30 Oct.',
    ]);
  });
  test('only requested seasons count', () =>
    expect(code(series([e(1, '2026-01-01T00:00:00Z', false, true, 1), e(1, '2026-10-01T00:00:00Z', true)]))).toBe(
      'imported',
    ));
  test('missing aired episodes, unmonitored', () =>
    expect(code(series([e(3, '2026-10-01T00:00:00Z', false, false)]))).toBe('unmonitored'));
  test('missing aired episodes: analyse', () => {
    const v = diagnose(series([e(3, '2026-10-01T00:00:00Z', false), e(4, '2026-10-08T00:00:00Z', false)]), NOW);
    expect([v.code, v.summary]).toEqual(['not-analysed', '2 aired episodes missing, nothing grabbed.']);
  });
});

describe('queue and history', () => {
  const q = {
    title: 'Hope.2026.2160p',
    status: 'downloading',
    trackedDownloadStatus: 'ok',
    trackedDownloadState: 'downloading',
    messages: [],
    errorMessage: '',
    size: 20 * GiB,
    sizeleft: 15 * GiB,
    timeleft: '01:10:00',
  };
  test('downloading, with progress', () => {
    const v = diagnose(facts({ queue: [q] }), NOW);
    expect([v.code, v.level, v.summary]).toEqual([
      'downloading',
      'ok',
      'Downloading: 25% of 20.0 GB, about 01:10:00 left',
    ]);
  });
  test('downloaded, not imported', () => {
    const v = diagnose(
      facts({
        queue: [
          {
            ...q,
            sizeleft: 0,
            trackedDownloadState: 'importBlocked',
            trackedDownloadStatus: 'warning',
            messages: ['No files found are eligible for import'],
          },
        ],
      }),
      NOW,
    );
    expect([v.code, v.summary]).toEqual([
      'queue-stuck',
      'Downloaded, but not imported: No files found are eligible for import',
    ]);
  });
  test('stalled', () => {
    const v = diagnose(
      facts({
        queue: [{ ...q, trackedDownloadStatus: 'warning', messages: ['The download is stalled with no connections'] }],
      }),
      NOW,
    );
    expect(v.summary).toBe('Stuck in the queue: The download is stalled with no connections');
    expect(v.next).toContain('Decluttarr');
  });
  test('the last download failed', () => {
    const h = [
      { eventType: 'grabbed', date: '2026-10-27T10:00:00Z', sourceTitle: 'Bliss.2160p', message: '' },
      {
        eventType: 'downloadFailed',
        date: '2026-10-27T12:00:00Z',
        sourceTitle: 'Bliss.2160p',
        message: 'Manually marked as failed',
      },
    ];
    const v = diagnose(facts({ history: h }), NOW);
    expect([v.code, v.level, v.summary]).toEqual([
      'failed',
      'down',
      'The last download failed: Manually marked as failed',
    ]);
  });
  test('grabbed, then gone', () =>
    expect(
      code(facts({ history: [{ eventType: 'grabbed', date: '2026-10-27T10:00:00Z', sourceTitle: 'x', message: '' }] })),
    ).toBe('grab-gone'));
});

describe('after a search', () => {
  const searched = (releases: Release[], over: Partial<ArrTitle> = {}) => {
    const arr = movie(over);
    return facts({ arr, releases: summariseReleases(releases, 'radarr', arr.runtime, NOW - 3600_000) });
  };
  test('nothing on the indexers', () => {
    const v = diagnose(searched([rel({ matched: false, rejections: ['Unknown Movie'] })]), NOW);
    expect([v.code, v.details[0]]).toEqual(['no-releases', 'Searched 60 min ago: 1 result, 0 for this title.']);
  });
  test('nothing on the indexers, and Prowlarr says why', () => {
    const f = { ...searched([]), indexersFailing: ['Indexers unavailable due to failures: 1337x'] };
    expect(diagnose(f, NOW).next).toBe('Fix the failing indexers in Prowlarr first.');
  });
  test('an acceptable release nobody grabbed', () =>
    expect(code(searched([rel({ approved: true })]))).toBe('grabbable'));
  test('no 4K at all under the default profile: switch to the variant', () => {
    const v = diagnose(
      searched([
        rel({
          quality: 'WEBDL-1080p',
          resolution: 1080,
          size: 9 * GiB,
          seeders: 1015,
          rejections: ['WEBDL-1080p is not wanted in profile'],
        }),
        rel({ quality: 'WEBRip-720p', resolution: 720, rejections: ['WEBRip-720p is not wanted in profile'] }),
      ]),
      NOW,
    );
    expect(v.code).toBe('no-4k');
    expect(v.summary).toBe(
      `No 4K release yet: all 2 are 1080p or 720p, and “${DEFAULT_PROFILE.radarr}” takes 4K only.`,
    );
    expect(v.next).toContain(VARIANT_PROFILE);
  });
  test('the size cap, with the numbers', () => {
    // 25.3 GB for 137 minutes is ~189 MB/min: refused at the old 150, as Wicked: For Good was.
    const big = rel({ size: 25.3 * GiB, rejections: ['25.3 GB is larger than maximum allowed 20.1 GB (for Wicked)'] });
    const v = diagnose(
      searched([big, rel({ seeders: 3, rejections: ['Not enough seeders: 3'] })], { runtime: 137 }),
      NOW,
    );
    expect(v.code).toBe('size-cap');
    expect(v.summary).toBe(
      'The best release is over the size cap: 25.3 GB is 189 MB/min for a 137-minute runtime, and WEBDL-2160p is capped at 200.',
    );
    expect(v.next).toContain('stack/lib/arr-policy.ts');
  });
  test('4K without HDR: the hand-picked fallback', () => {
    const v = diagnose(
      searched([rel({ rejections: ["Custom Formats SDR have score -10000 below Movie's profile minimum 0"] })]),
      NOW,
    );
    expect(v.code).toBe('no-hdr');
    expect(v.next).toContain(FALLBACK_PROFILES.radarr[0] ?? '');
  });
  test('anything else: the commonest reason', () => {
    const v = diagnose(searched([rel({ rejections: ['Not enough seeders: 1'] })], { profile: VARIANT_PROFILE }), NOW);
    expect([v.code, v.summary]).toEqual(['all-rejected', 'Every release was refused: mostly too few seeders.']);
    expect(v.next).toContain('MIN_SEEDERS');
  });
});

describe('summariseReleases', () => {
  test('counts each reason once per release, matched releases only', () => {
    const s = summariseReleases(
      [
        rel({ rejections: ['WEBDL-2160p is not wanted in profile', 'WEBDL-1080p is not wanted in profile'] }),
        rel({ rejections: ['Not enough seeders: 1', 'WEBDL-2160p is not wanted in profile'] }),
        rel({ matched: false, rejections: ['Wrong movie'] }),
      ],
      'radarr',
      100,
      NOW,
    );
    expect([s.total, s.matched, s.approved]).toEqual([3, 2, 0]);
    expect(s.reasons.map((r) => [r.kind, r.count])).toEqual([
      ['quality', 2],
      ['seeders', 1],
    ]);
    expect(s.byResolution).toEqual({ 2160: 2 });
  });
  test('oversize only for a release refused for size alone, and only where there is a cap', () => {
    const sonarr = summariseReleases(
      [rel({ quality: 'WEBDL-1080p', rejections: ['2 GB is larger than maximum allowed 1 GB'] })],
      'sonarr',
      22,
      NOW,
    );
    expect(sonarr.oversize).toBeNull();
    const mixed = summariseReleases(
      [rel({ rejections: ['x is larger than maximum allowed y', 'Not enough seeders'] })],
      'radarr',
      100,
      NOW,
    );
    expect(mixed.oversize).toBeNull();
  });
});

describe('report and canAnalyse', () => {
  test('a row for the page', () => {
    const r = report(facts(), NOW);
    expect([r.id, r.app, r.title, r.year, r.profile, r.verdict.code, r.canAnalyse]).toEqual([
      37,
      'radarr',
      'Hope',
      2026,
      DEFAULT_PROFILE.radarr,
      'not-analysed',
      true,
    ]);
  });
  test('nothing to search: waiting, done, or not in the app', () => {
    for (const f of [
      facts({ arr: null }),
      facts({ arr: movie({ isAvailable: false }) }),
      facts({ arr: movie({ hasFile: true }) }),
    ])
      expect(canAnalyse(f, diagnose(f, NOW))).toBe(false);
  });
  test('a title Seerr knows only by its TMDB id', () =>
    expect(report(facts({ arr: null }), NOW).title).toBe('TMDB 1058424'));
});
