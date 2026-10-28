// jobs/arr-fallback-search/arr-fallback-search.ts — ask Radarr to search again for the movies on the
// "4K HDR or 1080p" profile that have no 4K file yet.
//
//   jobs/arr-fallback-search/arr-fallback-search.sh              queue one search for them
//   jobs/arr-fallback-search/arr-fallback-search.sh --dry-run    list them; changes nothing
//
// Normally run as `task arr-fallback-search:run` / `:dry`, or by the
// daily arr-fallback-search.timer beside it.
//
// Radarr searches a movie in full only when it is added; after that it sees new
// releases through RSS alone, every 30 minutes. A 4K HDR release that was turned
// away at the time (too few seeders), was posted while the box was down, or sits
// on an indexer with a poor feed is never found. This closes that gap for the
// fallback profile only: monitored, released movies with a 1080p file, or none.
// Movies already in 4K are left to RSS, as on the default profile.
//
// Exit: 0 searched, or nothing to search · 1 the profile is missing, or the
// search was refused · 2 usage · 3 unreachable/not configured.

import { resolve } from 'node:path';
import { headerHelp, parseCli } from '../../stack/lib/cli.ts';
import { runMain } from '../../stack/lib/exit.ts';
import { envGet, envSeconds, type Env } from '../../stack/lib/env.ts';
import { httpCode, makeHttp, type Http } from '../../stack/lib/http.ts';
import { out, type Log } from '../../stack/lib/log.ts';
import { apiError, servarr } from '../../stack/lib/servarr.ts';
import { VARIANT_PROFILE } from '../../stack/lib/arr-policy.ts';
import type { components as RadarrApi } from '../../stack/lib/api/radarr.d.ts';

// Created by Recyclarr (apps/recyclarr/recyclarr.yml); arr-configure keeps its
// upgrades on (UPGRADE_PROFILES in stack/lib/arr-policy.ts).
export const FALLBACK_PROFILE = VARIANT_PROFILE;

// Radarr's /api/v3/qualityprofile and /movie, generated from its OpenAPI spec
// (stack/lib/api/radarr.d.ts). Every field is optional there; movieFile is
// absent when the movie has no file.
export type QualityProfile = RadarrApi['schemas']['QualityProfileResource'];
export type Movie = RadarrApi['schemas']['MovieResource'];

// ─── pure helpers (jobs/arr-fallback-search/arr-fallback-search.test.ts) ──────

/** The id of a quality profile by name, from a /qualityprofile list. */
export function profileIdOf(profiles: readonly QualityProfile[], name: string): number | undefined {
  return profiles.find((p) => p.name === name)?.id;
}

/**
 * Ids of the monitored, released movies on the profile without a 2160p file. A
 * movie with no file at all counts: it is the case "always get something" is for.
 */
export function fallbackIds(movies: readonly Movie[], profileId: number): number[] {
  return movies
    .filter((m) => m.qualityProfileId === profileId && m.monitored && m.isAvailable)
    .filter((m) => (m.movieFile?.quality?.quality?.resolution ?? 0) < 2160)
    .flatMap((m) => (m.id === undefined ? [] : [m.id]));
}

/** "Title (Year) — 1080p" lines for the log, for the ids given, in the library's order. */
export function fallbackTitles(movies: readonly Movie[], ids: readonly number[]): string[] {
  return movies
    .filter((m) => m.id !== undefined && ids.includes(m.id))
    .map((m) => `${m.title} (${m.year}) — ${m.movieFile?.quality?.quality?.name ?? 'no file'}`);
}

// ─── main ─────────────────────────────────────────────────────────────────────

export interface Deps {
  http: Http;
  log: Log;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  env: Env;
  /** The tree whose .env holds RADARR_API_KEY: the install, from the unit. */
  repo: string;
}

export async function main(argv: readonly string[], deps: Deps): Promise<number> {
  const { env, log } = deps;
  const cli = parseCli(argv, { flags: ['--dry-run'], usage: 'usage: arr-fallback-search.sh [--dry-run]' });
  if (cli.help) {
    log(headerHelp(await Bun.file(import.meta.path).text()));
    return 0;
  }

  const url = env.RADARR_URL || 'http://127.0.0.1:7878';
  const key = envGet('RADARR_API_KEY', { repo: deps.repo, env });
  if (!key) {
    log(`RADARR_API_KEY is not set in ${deps.repo}/.env`);
    return 3;
  }
  // The last answer's status, as bash's $HTTP: the one waitReady gave up on.
  let last = 0;
  const http: Http = async (u, req) => {
    const r = await deps.http(u, req);
    last = r.status;
    return r;
  };
  const radarr = servarr(
    {
      name: 'radarr',
      url,
      key,
      api: 'v3',
      // No login and no host config here: only the API key is used.
      user: '',
      pass: '',
      timeoutMs: envSeconds(env, 'ARR_TIMEOUT', 60),
      waitMs: envSeconds(env, 'ARR_WAIT', 90),
    },
    // No LAN addresses either, so stack/lib/net.ts stays out: the unit allows no AF_NETLINK.
    { http, log, sleep: deps.sleep, now: deps.now, hostname: () => '', lanIps: () => [] },
  );

  if (!(await radarr.waitReady())) {
    log(`Radarr at ${url} is not answering with RADARR_API_KEY (HTTP ${httpCode(last)})`);
    return 3;
  }

  const profiles = await radarr.get('/qualityprofile');
  if (!profiles.ok || !Array.isArray(profiles.json)) {
    log(`FAIL  read quality profiles (HTTP ${httpCode(profiles.status)})`);
    return 1;
  }
  const pid = profileIdOf(profiles.json as QualityProfile[], FALLBACK_PROFILE);
  if (pid === undefined) {
    log(`No '${FALLBACK_PROFILE}' profile in Radarr — task recyclarr:sync`);
    return 1;
  }

  const movieList = await radarr.get('/movie');
  if (!movieList.ok || !Array.isArray(movieList.json)) {
    log(`FAIL  read movies (HTTP ${httpCode(movieList.status)})`);
    return 1;
  }
  const movies = movieList.json as Movie[];
  const ids = fallbackIds(movies, pid);
  if (ids.length === 0) {
    log(`Nothing to search: no monitored '${FALLBACK_PROFILE}' movie is without a 4K file.`);
    return 0;
  }

  log(`${ids.length} '${FALLBACK_PROFILE}' movie(s) without a 4K file:`);
  for (const line of fallbackTitles(movies, ids)) log(`  ${line}`);
  if (cli.flags['--dry-run']) {
    log('Dry run: nothing searched.');
    return 0;
  }

  const cmd = await radarr.api('POST', '/command', { name: 'MoviesSearch', movieIds: ids });
  if (!cmd.ok) {
    log(`FAIL  queue the search (HTTP ${httpCode(cmd.status)}): ${apiError(cmd.text)}`);
    return 1;
  }
  const id = (cmd.json as { id?: unknown } | null)?.id ?? null;
  log(`Search queued (Radarr command ${String(id)}); grabs show in Radarr's queue.`);
  return 0;
}

if (import.meta.main) {
  await runMain(() =>
    main(Bun.argv.slice(2), {
      http: makeHttp(),
      log: out,
      sleep: (ms) => Bun.sleep(ms),
      now: () => Date.now(),
      env: process.env,
      repo: resolve(import.meta.dir, '../..'),
    }),
  );
}
