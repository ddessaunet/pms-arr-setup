// Unit tests for profiles-core.ts: `task site:test` (vp test, no build).
// The real files first, then each way they can disagree, which must throw.

import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as arrPolicy from '../../../stack/lib/arr-policy.ts';
import { buildProfiles, profileSlug, sizeCapsOf, type ArrPolicy } from './profiles-core.ts';

const repo = new URL('../../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, repo), 'utf8');
const RECYCLARR = read('apps/recyclarr/recyclarr.yml');
const POLICY = read('site/src/data/profiles.yml');
const ARR: ArrPolicy = arrPolicy;

test('the repo as it is: four profiles, in recyclarr.yml order', () => {
  const { profiles } = buildProfiles(RECYCLARR, POLICY, ARR);
  assert.deepEqual(
    profiles.map((p) => `${p.app}:${p.name}`),
    ['radarr:UHD Bluray + WEB', 'radarr:4K HDR or 1080p', 'radarr:UHD Fallback', 'sonarr:WEB-1080p'],
  );
});

test('facts come from recyclarr.yml', () => {
  const by = Object.fromEntries(buildProfiles(RECYCLARR, POLICY, ARR).profiles.map((p) => [p.name, p]));
  assert.deepEqual(
    by['4K HDR or 1080p'].groups.map((g) => g.name),
    ['UHD 2160p', 'HD 1080p'],
  );
  assert.deepEqual(by['UHD Bluray + WEB'].upgrade, { allowed: true, until: 'UHD 2160p' });
  assert.equal(by['UHD Fallback'].upgrade.allowed, false);
  assert.equal(by['UHD Fallback'].trashId, null);
  assert.equal(by['UHD Fallback'].formats.kind, 'hand-picked');
  assert.ok(by['UHD Fallback'].formats.kind === 'hand-picked' && by['UHD Fallback'].formats.count > 20);
  assert.equal(by['UHD Bluray + WEB'].minFormatScore, null);
  assert.ok(Object.values(by).every((p) => !p.remux));
});

test('a profile named only by trash_id takes its name and qualities from the guide', () => {
  const sonarr = buildProfiles(RECYCLARR, POLICY, ARR).profiles.find((p) => p.app === 'sonarr')!;
  assert.equal(sonarr.name, 'WEB-1080p');
  assert.equal(sonarr.guideQualities, true);
  assert.deepEqual(sonarr.groups[0].qualities, ['WEBRip-1080p', 'WEBDL-1080p']);
});

test('!env_var parses, and only its name is kept', () => {
  assert.doesNotThrow(() => buildProfiles(RECYCLARR, POLICY, ARR));
  assert.ok(RECYCLARR.includes('!env_var RADARR_API_KEY'));
});

test('size caps come from arr-policy.ts', () => {
  const caps = sizeCapsOf(ARR);
  assert.deepEqual(caps.radarr, [
    { resolution: '1080p', qualities: ['HDTV-1080p', 'WEBRip-1080p', 'Bluray-1080p'], max: 40, preferred: 25 },
    { resolution: '1080p', qualities: ['WEBDL-1080p'], max: 80, preferred: 25 },
    {
      resolution: '2160p',
      qualities: ['HDTV-2160p', 'WEBDL-2160p', 'WEBRip-2160p', 'Bluray-2160p'],
      max: 200,
      preferred: 100,
    },
  ]);
  assert.deepEqual(caps.sonarr, [
    {
      resolution: '1080p',
      qualities: ['HDTV-1080p', 'WEBRip-1080p', 'WEBDL-1080p', 'Bluray-1080p'],
      max: null,
      preferred: 25,
    },
  ]);
});

test('a profile renamed in one file only fails, naming both sides', () => {
  const renamed = POLICY.replace('  UHD Fallback:\n', '  UHD Fallback 2:\n');
  assert.throws(
    () => buildProfiles(RECYCLARR, renamed, ARR),
    /only in recyclarr\.yml.*"UHD Fallback"[\s\S]*only in profiles\.yml.*"UHD Fallback 2"/,
  );
});

test('a guide profile with no name and no guide entry fails', () => {
  const noGuide = POLICY.replace(/^guide:[\s\S]*?^profiles:/m, 'profiles:');
  assert.throws(() => buildProfiles(RECYCLARR, noGuide, ARR), /trash_id 72dae194fc92bf828f32cde7744e51a1 and no name/);
});

test('a different default than arr-policy.ts fails', () => {
  const swapped = POLICY.replace(/(UHD Fallback:\n    app: radarr\n    role:) by-hand/, '$1 default');
  assert.throws(() => buildProfiles(RECYCLARR, swapped, ARR), /default profile/);
});

test('an upgrade list different from arr-policy.ts fails', () => {
  const noUpgrade = { ...ARR, UPGRADE_PROFILES: { ...ARR.UPGRADE_PROFILES, radarr: ['UHD Bluray + WEB'] } };
  assert.throws(() => buildProfiles(RECYCLARR, POLICY, noUpgrade), /UPGRADE_PROFILES/);
});

test('a default different from profiles.yml fails', () => {
  const other = { ...ARR, DEFAULT_PROFILE: { ...ARR.DEFAULT_PROFILE, sonarr: 'HD-1080p' } };
  assert.throws(() => buildProfiles(RECYCLARR, POLICY, other), /DEFAULT_PROFILE/);
});

test('a quality capped apart from its resolution gets its own cap', () => {
  const split = {
    ...ARR,
    SIZE_CAPS: {
      ...ARR.SIZE_CAPS,
      radarr: ARR.SIZE_CAPS.radarr.map((c) => (c.quality === 'WEBDL-2160p' ? { ...c, max: 120 } : c)),
    },
  };
  const uhd = sizeCapsOf(split).radarr.filter((c) => c.resolution === '2160p');
  assert.deepEqual(
    uhd.map((c) => [c.qualities, c.max]),
    [
      [['HDTV-2160p', 'WEBRip-2160p', 'Bluray-2160p'], 200],
      [['WEBDL-2160p'], 120],
    ],
  );
});

test('slugs are stable anchors', () => {
  assert.equal(profileSlug('UHD Bluray + WEB'), 'profile-uhd-bluray-web');
  assert.equal(profileSlug('4K HDR or 1080p'), 'profile-4k-hdr-or-1080p');
});
