// stack/lib/arr-policy.ts — what Radarr and Sonarr are held to: the default
// profile per app, which profiles may upgrade, which stay free of Remux, and
// the size caps. Pure data, no imports and no Bun APIs.
//
// stack/lib/arr-configure.ts applies it. The docs site's quality-profiles map
// imports it at build time (site/src/lib/profiles.ts) and fails when
// site/src/data/profiles.yml or apps/recyclarr/recyclarr.yml disagree (trap
// 17). apps/seerr/configure.ts points requests at the same defaults, and
// jobs/arr-fallback-search searches VARIANT_PROFILE's movies (trap 11).

export type App = 'radarr' | 'sonarr';
export const APPS: readonly App[] = ['radarr', 'sonarr'];

/**
 * The opt-in variant for films with no 4K HDR release: 1080p first, then 4K
 * HDR. Created by Recyclarr (apps/recyclarr/recyclarr.yml), which must use
 * this exact name.
 */
export const VARIANT_PROFILE = '4K HDR or 1080p';

/**
 * The default profile for new adds, created by Recyclarr. Movies are 4K HDR;
 * series stay 1080p.
 */
export const DEFAULT_PROFILE: Readonly<Record<App, string>> = { radarr: 'UHD Bluray + WEB', sonarr: 'WEB-1080p' };

/**
 * The profiles allowed to upgrade — every other profile is kept at
 * no-upgrade. An upgrade replaces a library file, so everything else stays
 * single-grab.
 */
export const UPGRADE_PROFILES: Readonly<Record<App, readonly string[]>> = {
  radarr: [DEFAULT_PROFILE.radarr, VARIANT_PROFILE],
  sonarr: [],
};

/** The hand-picked 4K fallback (recyclarr.yml), which never upgrades. */
export const FALLBACK_PROFILES: Readonly<Record<App, readonly string[]>> = { radarr: ['UHD Fallback'], sonarr: [] };

/**
 * The profiles kept free of Remux: the default, every upgrading one, and the
 * fallback. Remux-1080p is a 15-40 GB rip of the disc: never on this disk.
 */
export const remuxFreeProfiles = (app: App): string[] => [
  ...new Set([DEFAULT_PROFILE[app], ...UPGRADE_PROFILES[app], ...FALLBACK_PROFILES[app]]),
];

/** MB per minute of runtime (the unit both apps use); max null is no max. */
export interface SizeCap {
  quality: string;
  max: number | null;
  preferred: number;
}

/**
 * Size caps. /mnt/data runs near full: the defaults let Radarr take
 * Bluray-1080p and Remux-1080p at ANY size (the 10 GB Night of the Living Dead
 * grab) and offered a 31.5 GB Iron Man 2 pack.
 *
 *   radarr 1080p  40 / 25   ~4.8 GB max, ~3 GB preferred for a 2-hour film
 *   radarr WEBDL-1080p 80 / 25  ~9.6 GB max: a WEB-DL is the service's own
 *                           stream, not an encode that picks its size, and
 *                           Amazon/iTunes 1080p runs 8-10 Mbit/s (60-75 MB/min).
 *                           At 40 the only good release of Taking Chance (2009),
 *                           a 5.2 GB AMZN WEB-DL for 77 minutes, was rejected.
 *   radarr 2160p 200 / 100  ~24 GB max, ~12 GB preferred for a 2-hour film: the
 *                           tiered iTunes DV/HDR WEB-DLs and the good UHD Bluray
 *                           encodes run 170-190 MB/min, and at 150 they were the
 *                           ones refused (Coyote vs. Acme, Seven Snipers, Wicked:
 *                           For Good, 2026-10-21); not 30-60 GB Bluray remuxes.
 *                           Raised with the disk at 94%: docs/phases.md, Phase 6.
 *   sonarr 1080p none / 25  episodes are short against their real size: a
 *                           half-hour show's 1080p WEB-DL runs 1-1.6 GB on a
 *                           22-minute runtime, and 40 MB/min (880 MB) rejected
 *                           every valid Scrubs S02 release. Series stay 1080p
 *                           and single-grab, so the max is the profile's job.
 *                           25 preferred only breaks ties (after quality, score
 *                           and seeders), toward the smaller file.
 *
 * Sizes are owned here, not by Recyclarr (its quality_definition is omitted).
 */
export const SIZE_CAPS: Readonly<Record<App, readonly SizeCap[]>> = {
  radarr: [
    { quality: 'HDTV-1080p', max: 40, preferred: 25 },
    { quality: 'WEBDL-1080p', max: 80, preferred: 25 },
    { quality: 'WEBRip-1080p', max: 40, preferred: 25 },
    { quality: 'Bluray-1080p', max: 40, preferred: 25 },
    { quality: 'HDTV-2160p', max: 200, preferred: 100 },
    { quality: 'WEBDL-2160p', max: 200, preferred: 100 },
    { quality: 'WEBRip-2160p', max: 200, preferred: 100 },
    { quality: 'Bluray-2160p', max: 200, preferred: 100 },
  ],
  sonarr: [
    { quality: 'HDTV-1080p', max: null, preferred: 25 },
    { quality: 'WEBRip-1080p', max: null, preferred: 25 },
    { quality: 'WEBDL-1080p', max: null, preferred: 25 },
    { quality: 'Bluray-1080p', max: null, preferred: 25 },
  ],
};

/** The resolution a quality name ends in: "WEBDL-1080p" → "1080p". */
export const resolutionOf = (quality: string): string => quality.replace(/.*-/, '');
