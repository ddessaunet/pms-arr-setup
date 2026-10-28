// jobs/stack-api/requests.ts — the request doctor's facts and routes, behind
// the sign-in (app.ts):
//
//   GET  /api/requests               every open Seerr request, with its verdict
//   POST /api/requests/:id/analyse   search the indexers for it now (Radarr's
//                                    or Sonarr's /release), keep the summary
//                                    6 h, and answer its new verdict
//
// The verdicts are stack/lib/request-doctor.ts's; this file only reads. It
// never writes to Seerr, Radarr, Sonarr or Prowlarr. A release search is the
// costly part: it asks every indexer (the FlareSolverr ones run a headless
// Chromium), so it runs only when asked, one at a time, at most 10 an hour.
// Everything else is cheap local reads, kept for a minute.

import type { Hono } from 'hono';
import type { App } from '../../stack/lib/arr-policy.ts';
import { envGet, type Env as ProcessEnv } from '../../stack/lib/env.ts';
import { is2xx, jsonOf, type Http } from '../../stack/lib/http.ts';
import { readSeerrKey } from '../../stack/lib/keys.ts';
import type { Log } from '../../stack/lib/log.ts';
import { redact } from '../../stack/lib/redact.ts';
import {
  MEDIA_STATUS,
  REQUEST_STATUS,
  report,
  summariseReleases,
  type ArrTitle,
  type Episode,
  type Facts,
  type HistoryEvent,
  type QueueItem,
  type Release,
  type ReleaseSummary,
  type RequestsDoc,
  type SeerrRequest,
} from '../../stack/lib/request-doctor.ts';
import type { Env, RateLimit } from './app.ts';
import type { Store } from './store.ts';

const T_READ = 10_000; // ms per local read
const T_SEARCH = 150_000; // ms for a release search (nginx waits 180 s)
const LIST_TTL = 60_000; // ms the request list is reused
export const RELEASES_TTL = 6 * 3600_000; // ms a release search is shown

export interface RequestsDeps {
  http: Http;
  store: Store;
  now: () => number;
  log: Log;
  env: ProcessEnv;
  /** The install, for .env. */
  repo: string;
  appdata: string;
  analyses: RateLimit;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);

// ─── parsing (pure: API JSON in, the doctor's facts out) ─────────────────────

export function parseSeerrRequests(json: unknown): SeerrRequest[] {
  const results = isObj(json) ? arr(json.results) : [];
  return results.filter(isObj).map((r) => {
    const media = isObj(r.media) ? r.media : {};
    return {
      id: num(r.id),
      status: num(r.status),
      type: r.type === 'tv' || media.mediaType === 'tv' ? 'tv' : 'movie',
      createdAt: str(r.createdAt),
      requestedBy: str(isObj(r.requestedBy) ? r.requestedBy.displayName : undefined, '?'),
      mediaStatus: num(media.status),
      tmdbId: num(media.tmdbId),
      arrId: typeof media.externalServiceId === 'number' ? media.externalServiceId : null,
      seasons: arr(r.seasons)
        .filter(isObj)
        .map((s) => num(s.seasonNumber, -1))
        .filter((n) => n >= 0),
    };
  });
}

/** Seerr's open requests: not available, not declined, newest first. */
export const openRequests = (all: readonly SeerrRequest[]) =>
  all
    .filter(
      (r) =>
        r.status !== REQUEST_STATUS.declined &&
        r.status !== REQUEST_STATUS.completed &&
        r.mediaStatus !== MEDIA_STATUS.available,
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export const profileNames = (json: unknown): Map<number, string> =>
  new Map(
    arr(json)
      .filter(isObj)
      .map((p) => [num(p.id), str(p.name)]),
  );

export function parseMovie(json: unknown, profiles: Map<number, string>): ArrTitle | null {
  if (!isObj(json) || typeof json.id !== 'number') return null;
  return {
    app: 'radarr',
    id: json.id,
    title: str(json.title),
    year: typeof json.year === 'number' ? json.year : null,
    monitored: json.monitored === true,
    hasFile: json.hasFile === true,
    profile: profiles.get(num(json.qualityProfileId)) ?? `profile ${num(json.qualityProfileId)}`,
    runtime: num(json.runtime),
    isAvailable: json.isAvailable !== false,
    status: str(json.status),
    episodes: [],
  };
}

export function parseSeries(json: unknown, episodes: unknown, profiles: Map<number, string>): ArrTitle | null {
  if (!isObj(json) || typeof json.id !== 'number') return null;
  return {
    app: 'sonarr',
    id: json.id,
    title: str(json.title),
    year: typeof json.year === 'number' ? json.year : null,
    monitored: json.monitored === true,
    hasFile: false,
    profile: profiles.get(num(json.qualityProfileId)) ?? `profile ${num(json.qualityProfileId)}`,
    runtime: num(json.runtime),
    isAvailable: true,
    status: str(json.status),
    episodes: arr(episodes)
      .filter(isObj)
      .filter((e) => num(e.seasonNumber) > 0)
      .map((e): Episode => ({
        season: num(e.seasonNumber),
        episode: num(e.episodeNumber),
        airDate: typeof e.airDateUtc === 'string' ? e.airDateUtc : null,
        hasFile: e.hasFile === true,
        monitored: e.monitored === true,
      })),
  };
}

export function parseQueue(json: unknown): QueueItem[] {
  return arr(isObj(json) ? json.records : json)
    .filter(isObj)
    .map((q) => ({
      title: str(q.title),
      status: str(q.status),
      trackedDownloadStatus: str(q.trackedDownloadStatus),
      trackedDownloadState: str(q.trackedDownloadState),
      messages: arr(q.statusMessages)
        .filter(isObj)
        .flatMap((m) => [str(m.title), ...arr(m.messages).map((x) => str(x))])
        .filter(Boolean),
      errorMessage: str(q.errorMessage),
      size: num(q.size),
      sizeleft: num(q.sizeleft),
      timeleft: typeof q.timeleft === 'string' ? q.timeleft : null,
    }));
}

export function parseHistory(json: unknown): HistoryEvent[] {
  return arr(isObj(json) ? json.records : json)
    .filter(isObj)
    .map((h) => {
      const data = isObj(h.data) ? h.data : {};
      return {
        eventType: str(h.eventType),
        date: str(h.date),
        sourceTitle: str(h.sourceTitle),
        message: str(data.message) || str(data.reason),
      };
    });
}

/** A release search's results; matched means Radarr/Sonarr mapped it to this title. */
export function parseReleases(json: unknown, app: App, arrId: number): Release[] {
  return arr(json)
    .filter(isObj)
    .map((r) => {
      const q = isObj(r.quality) && isObj(r.quality.quality) ? r.quality.quality : {};
      const mapped = app === 'radarr' ? r.mappedMovieId : r.mappedSeriesId;
      const rejections = arr(r.rejections).map((x) => str(x));
      return {
        title: str(r.title),
        quality: str(q.name),
        resolution: num(q.resolution),
        size: num(r.size),
        seeders: typeof r.seeders === 'number' ? r.seeders : null,
        indexer: str(r.indexer),
        matched: mapped === arrId && !rejections.some((t) => /^(Unknown|Wrong) (Movie|Series|Episode)/i.test(t)),
        approved: r.approved === true,
        rejections,
      };
    });
}

/** Prowlarr's health checks about indexers: what is failing, in its words. */
export const failingIndexers = (json: unknown): string[] =>
  arr(json)
    .filter(isObj)
    .filter((h) => /indexer/i.test(str(h.source)) && h.type !== 'notice')
    .map((h) => str(h.message))
    .filter(Boolean);

// ─── reading the apps ─────────────────────────────────────────────────────────

const PORT: Record<App | 'prowlarr' | 'seerr', number> = { radarr: 7878, sonarr: 8989, prowlarr: 9696, seerr: 5055 };

function makeReader(d: RequestsDeps) {
  const key = (k: string) => envGet(k, { repo: d.repo, env: d.env });
  const keys = {
    radarr: () => key('RADARR_API_KEY'),
    sonarr: () => key('SONARR_API_KEY'),
    prowlarr: () => key('PROWLARR_API_KEY'),
    seerr: () => readSeerrKey(`${d.appdata}/seerr/settings.json`),
  };
  /** The JSON of a GET, or an error message (never with the key in it). */
  return async (
    app: keyof typeof PORT,
    path: string,
    timeoutMs = T_READ,
  ): Promise<{ json: unknown; status: number; error: string | null }> => {
    const ver = app === 'seerr' || app === 'prowlarr' ? 'v1' : 'v3';
    const r = await d.http(`http://127.0.0.1:${PORT[app]}/api/${ver}${path}`, {
      headers: { 'X-Api-Key': keys[app](), Accept: 'application/json' },
      timeoutMs,
    });
    if (r.status === 0)
      return { json: null, status: 0, error: `not answering on :${PORT[app]} (${r.error ?? 'no answer'})` };
    if (!is2xx(r.status)) return { json: jsonOf(r), status: r.status, error: `answered ${r.status}` };
    return { json: jsonOf(r), status: r.status, error: null };
  };
}

type Reader = ReturnType<typeof makeReader>;

async function factsFor(
  read: Reader,
  q: SeerrRequest,
  ctx: { profiles: Record<App, Map<number, string>>; failing: string[]; cached: ReleaseSummary | null },
): Promise<Facts> {
  const base: Facts = {
    request: q,
    arr: null,
    arrError: null,
    queue: [],
    history: [],
    releases: ctx.cached,
    indexersFailing: ctx.failing,
  };
  if (q.arrId === null) return base;
  if (q.type === 'movie') {
    const [movie, queue, history] = await Promise.all([
      read('radarr', `/movie/${q.arrId}`),
      read('radarr', `/queue?movieIds=${q.arrId}&pageSize=50`),
      read('radarr', `/history/movie?movieId=${q.arrId}`),
    ]);
    if (movie.status === 404) return base;
    if (movie.error) return { ...base, arrError: movie.error };
    return {
      ...base,
      arr: parseMovie(movie.json, ctx.profiles.radarr),
      queue: parseQueue(queue.json),
      history: parseHistory(history.json),
    };
  }
  const [series, episodes, queue, history] = await Promise.all([
    read('sonarr', `/series/${q.arrId}`),
    read('sonarr', `/episode?seriesId=${q.arrId}`),
    read('sonarr', `/queue?seriesIds=${q.arrId}&pageSize=50`),
    read('sonarr', `/history/series?seriesId=${q.arrId}`),
  ]);
  if (series.status === 404) return base;
  if (series.error) return { ...base, arrError: series.error };
  return {
    ...base,
    arr: parseSeries(series.json, episodes.json, ctx.profiles.sonarr),
    queue: parseQueue(queue.json),
    history: parseHistory(history.json),
  };
}

const releasesKey = (q: SeerrRequest) => `${q.type === 'movie' ? 'radarr' : 'sonarr'}:${q.arrId}`;

/** The season a series search covers: the first requested one with an aired episode missing. */
export function seasonToSearch(title: ArrTitle, q: SeerrRequest, now: number): number | null {
  const missing = title.episodes.filter(
    (e) =>
      (q.seasons.length === 0 || q.seasons.includes(e.season)) &&
      !e.hasFile &&
      e.airDate !== null &&
      Date.parse(e.airDate) <= now,
  );
  return missing.length ? Math.min(...missing.map((e) => e.season)) : null;
}

// ─── the routes ───────────────────────────────────────────────────────────────

export function addRequestRoutes(app: Hono<Env>, d: RequestsDeps): void {
  const read = makeReader(d);
  let listCache: { at: number; doc: RequestsDoc; facts: Map<number, Facts> } | null = null;
  let searching = false;

  async function build(): Promise<{ doc: RequestsDoc; facts: Map<number, Facts> }> {
    const now = d.now();
    const errors: string[] = [];
    const [reqs, rp, sp, health] = await Promise.all([
      read('seerr', '/request?take=200&skip=0&filter=all&sort=added'),
      read('radarr', '/qualityprofile'),
      read('sonarr', '/qualityprofile'),
      read('prowlarr', '/health'),
    ]);
    if (reqs.error) errors.push(`Seerr ${reqs.error}`);
    const all = parseSeerrRequests(reqs.json);
    const open = openRequests(all);
    const ctxBase = {
      profiles: { radarr: profileNames(rp.json), sonarr: profileNames(sp.json) },
      failing: health.error ? [] : failingIndexers(health.json),
    };
    if (health.error) errors.push(`Prowlarr ${health.error}`);
    const facts = new Map<number, Facts>();
    for (const f of await Promise.all(
      open.map((q) =>
        factsFor(read, q, {
          ...ctxBase,
          cached: q.arrId === null ? null : d.store.releases(releasesKey(q), now - RELEASES_TTL),
        }),
      ),
    ))
      facts.set(f.request.id, f);
    for (const f of facts.values())
      if (f.arrError) errors.push(`${f.request.type === 'movie' ? 'Radarr' : 'Sonarr'} ${f.arrError}`);
    const doc: RequestsDoc = {
      generatedAt: new Date(now).toISOString(),
      open: [...facts.values()].map((f) => report(f, now)),
      available: all.filter((r) => r.mediaStatus === MEDIA_STATUS.available || r.status === REQUEST_STATUS.completed)
        .length,
      errors: [...new Set(errors)],
    };
    return { doc, facts };
  }

  async function current(fresh = false) {
    if (!fresh && listCache && d.now() - listCache.at < LIST_TTL) return listCache;
    const b = await build();
    listCache = { at: d.now(), ...b };
    return listCache;
  }

  // An app's error text can carry a URL; the answers go through the same masking as /live/.
  const secrets = () =>
    [
      envGet('RADARR_API_KEY', { repo: d.repo, env: d.env }),
      envGet('SONARR_API_KEY', { repo: d.repo, env: d.env }),
      envGet('PROWLARR_API_KEY', { repo: d.repo, env: d.env }),
      readSeerrKey(`${d.appdata}/seerr/settings.json`),
    ].filter((s) => s.length >= 4);

  app.get('/api/requests', async (c) => c.json(redact((await current()).doc, secrets())));

  app.post('/api/requests/:id/analyse', async (c) => {
    const id = Number(c.req.param('id'));
    const { facts } = await current();
    const f = facts.get(id);
    if (!f) return c.json({ error: 'no open request with that id' }, 404);
    if (!f.arr || f.request.arrId === null)
      return c.json({ error: 'it is not in Radarr/Sonarr: nothing to search' }, 409);
    if (searching) return c.json({ error: 'another search is running; try again in a minute' }, 409);
    if (!d.analyses.allow('analyse', d.now()))
      return c.json({ error: 'at most 10 searches an hour; try again later' }, 429);

    const now = d.now();
    let path: string;
    if (f.arr.app === 'radarr') path = `/release?movieId=${f.arr.id}`;
    else {
      const season = seasonToSearch(f.arr, f.request, now);
      if (season === null) return c.json({ error: 'no aired episode is missing: nothing to search' }, 409);
      path = `/release?seriesId=${f.arr.id}&seasonNumber=${season}`;
    }
    searching = true;
    try {
      d.log(`analyse: request ${id} (${f.arr.title}): searching ${f.arr.app}`);
      const r = await read(f.arr.app, path, T_SEARCH);
      if (r.error) {
        d.log(`analyse: request ${id}: ${f.arr.app} ${r.error}`);
        return c.json({ error: `${f.arr.app === 'radarr' ? 'Radarr' : 'Sonarr'} ${r.error}` }, 502);
      }
      const summary = summariseReleases(parseReleases(r.json, f.arr.app, f.arr.id), f.arr.app, f.arr.runtime, d.now());
      d.store.putReleases(releasesKey(f.request), summary);
      d.log(
        `analyse: request ${id}: ${summary.total} result(s), ${summary.matched} for it, ${summary.approved} acceptable`,
      );
    } finally {
      searching = false;
    }
    const next = await current(true);
    const row = next.doc.open.find((x) => x.id === id);
    return row ? c.json(redact(row, secrets())) : c.json({ error: 'it is no longer open' }, 404);
  });
}
