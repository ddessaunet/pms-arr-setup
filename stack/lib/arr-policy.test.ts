// stack/lib/arr-policy.test.ts — the policy's facts, with the releases that set
// them. stack/lib/arr-configure.test.ts tests how it is applied; the docs site's
// profiles-core.test.ts, that the map agrees with it.

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PROFILE,
  remuxFreeProfiles,
  resolutionOf,
  SIZE_CAPS,
  UPGRADE_PROFILES,
  VARIANT_PROFILE,
  type App,
} from './arr-policy.ts';

const cap = (app: App, quality: string) => SIZE_CAPS[app].find((c) => c.quality === quality);
const max = (app: App, quality: string) => cap(app, quality)?.max ?? Number.NaN;

describe('default_profile / upgrade_profiles / remux_free_profiles', () => {
  test('movies default to 4K HDR', () => expect(DEFAULT_PROFILE.radarr).toBe('UHD Bluray + WEB'));
  test('series default to 1080p', () => expect(DEFAULT_PROFILE.sonarr).toBe('WEB-1080p'));
  test('only the two 4K movie profiles upgrade', () =>
    expect(UPGRADE_PROFILES.radarr).toEqual(['UHD Bluray + WEB', '4K HDR or 1080p']));
  test('no series profile upgrades', () => expect(UPGRADE_PROFILES.sonarr).toEqual([]));
  test('radarr: no Remux on the default, the variant or UHD Fallback', () =>
    expect(remuxFreeProfiles('radarr')).toEqual(['UHD Bluray + WEB', '4K HDR or 1080p', 'UHD Fallback']));
  test('sonarr: no Remux on the default', () => expect(remuxFreeProfiles('sonarr')).toEqual(['WEB-1080p']));
  test('the variant is named once, for arr-fallback-search and Recyclarr', () =>
    expect(VARIANT_PROFILE).toBe('4K HDR or 1080p'));
});

describe('size caps', () => {
  test('1080p 40 MB/min is ~4.8 GB for a 2-hour film', () => expect(max('radarr', 'Bluray-1080p') * 120).toBe(4800));
  test('WEBRip and HDTV 1080p stay at 40', () =>
    expect([max('radarr', 'WEBRip-1080p'), max('radarr', 'HDTV-1080p')]).toEqual([40, 40]));
  // Taking Chance (2009): 77 minutes, its one good release a 5336 MB AMZN WEB-DL.
  test('a 5.2 GB WEB-DL fits a 77-minute film', () =>
    expect(5336).toBeLessThanOrEqual(max('radarr', 'WEBDL-1080p') * 77));
  test('2160p 200 MB/min is ~24 GB for a 2-hour film', () => expect(max('radarr', 'WEBDL-2160p') * 120).toBe(24000));
  // Coyote vs. Acme (2026): 103 minutes, its best release a 18406 MB iT WEB-DL (BYNDR).
  test('a 19.3 GB 4K WEB-DL fits a 103-minute film', () =>
    expect(18406).toBeLessThanOrEqual(max('radarr', 'WEBDL-2160p') * 103));
  test('Remux is never capped into eligibility', () =>
    expect(Object.values(SIZE_CAPS).flatMap((caps) => caps.filter((c) => c.quality.includes('Remux')))).toEqual([]));
  test('sonarr has no 2160p caps (series stay 1080p)', () =>
    expect(SIZE_CAPS.sonarr.filter((c) => resolutionOf(c.quality) === '2160p')).toEqual([]));
  test('a 22-minute episode at 1 GB is not capped', () => expect(cap('sonarr', 'WEBDL-1080p')?.max).toBeNull());
  test('each quality once per app', () => {
    for (const caps of Object.values(SIZE_CAPS)) expect(new Set(caps.map((c) => c.quality)).size).toBe(caps.length);
  });
});
