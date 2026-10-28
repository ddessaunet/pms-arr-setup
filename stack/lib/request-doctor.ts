// stack/lib/request-doctor.ts — why a Seerr request has not turned into a file
// yet, in a sentence and a next step. Pure: facts in, a verdict out, no I/O
// and no Bun APIs, so the docs site imports its types (the /requests/ page) as
// it imports arr-policy.ts.
//
// jobs/stack-api gathers the facts: the request from Seerr; the title, its
// queue entries and history from Radarr or Sonarr; failing indexers from
// Prowlarr; and, when asked (it searches every indexer), a release search,
// whose rejections are the "why" the apps only show in Interactive Search.
// The checks run in the order a person would: approved? in the app? monitored?
// out yet? downloading? failed? and only then, what the indexers offer and
// why the profile refused it.
//
// The advice names the profiles and caps from arr-policy.ts, so it says what
// this stack would actually do (CLAUDE.md trap 11).

import {
  DEFAULT_PROFILE,
  FALLBACK_PROFILES,
  SIZE_CAPS,
  VARIANT_PROFILE,
  type App,
  type SizeCap,
} from './arr-policy.ts';

export type Level = 'ok' | 'degraded' | 'down' | 'unknown';

/** Seerr's request status (1 pending approval, 2 approved, 3 declined, 4 failed, 5 completed). */
export const REQUEST_STATUS = { pending: 1, approved: 2, declined: 3, failed: 4, completed: 5 } as const;
/** Seerr's media status (5 available, 4 partly). */
export const MEDIA_STATUS = { unknown: 1, pending: 2, processing: 3, partial: 4, available: 5, deleted: 6 } as const;

export interface SeerrRequest {
  id: number;
  status: number;
  type: 'movie' | 'tv';
  createdAt: string;
  requestedBy: string;
  mediaStatus: number;
  tmdbId: number;
  /** The Radarr movie's or Sonarr series' id, once Seerr added it. */
  arrId: number | null;
  /** Requested seasons (series only). */
  seasons: number[];
}

export interface Episode {
  season: number;
  episode: number;
  airDate: string | null;
  hasFile: boolean;
  monitored: boolean;
}

export interface ArrTitle {
  app: App;
  id: number;
  title: string;
  year: number | null;
  monitored: boolean;
  /** Movies: whether the file is there. Series: see episodes. */
  hasFile: boolean;
  profile: string;
  /** Minutes (an episode's, for a series). */
  runtime: number;
  /** Movies: released by Radarr's minimum availability. */
  isAvailable: boolean;
  /** Radarr's status: announced, inCinemas, released. */
  status: string;
  /** Series: the requested seasons' episodes. */
  episodes: Episode[];
}

export interface QueueItem {
  title: string;
  status: string;
  trackedDownloadStatus: string;
  trackedDownloadState: string;
  messages: string[];
  errorMessage: string;
  size: number;
  sizeleft: number;
  timeleft: string | null;
}

export interface HistoryEvent {
  /** grabbed, downloadFailed, downloadFolderImported, importFailed, … */
  eventType: string;
  date: string;
  sourceTitle: string;
  message: string;
}

/** One result of a release search, narrowed. */
export interface Release {
  title: string;
  quality: string;
  resolution: number;
  size: number;
  seeders: number | null;
  indexer: string;
  /** For this title (not "Unknown Movie" or another one). */
  matched: boolean;
  approved: boolean;
  rejections: string[];
}

export type RejectionKind = 'size' | 'quality' | 'score' | 'seeders' | 'language' | 'blocklisted' | 'have' | 'other';

export interface ReasonCount {
  kind: RejectionKind;
  label: string;
  /** Releases refused for it (one release can count under several). */
  count: number;
  example: string;
}

export interface Oversize {
  title: string;
  quality: string;
  size: number;
  mbPerMin: number;
  cap: number;
}

export interface ReleaseSummary {
  searchedAt: number;
  total: number;
  matched: number;
  approved: number;
  /** Matched releases per resolution: { "1080": 18, "720": 1 }. */
  byResolution: Record<string, number>;
  reasons: ReasonCount[];
  /** The matched release the profile would like best if it could: highest resolution, then seeders. */
  best: Pick<Release, 'title' | 'quality' | 'size' | 'seeders' | 'indexer'> | null;
  /** The best-seeded release refused only for size, with the numbers. */
  oversize: Oversize | null;
}

export interface Verdict {
  code: string;
  level: Level;
  summary: string;
  details: string[];
  next: string | null;
}

export interface Facts {
  request: SeerrRequest;
  arr: ArrTitle | null;
  /** Why the app could not be read; then arr is null and means "unknown". */
  arrError: string | null;
  queue: QueueItem[];
  history: HistoryEvent[];
  releases: ReleaseSummary | null;
  indexersFailing: string[];
}

/** One request on the page. */
export interface RequestReport {
  id: number;
  type: 'movie' | 'tv';
  app: App;
  title: string;
  year: number | null;
  requestedBy: string;
  requestedAt: string;
  profile: string | null;
  seasons: number[];
  verdict: Verdict;
  releases: ReleaseSummary | null;
  /** Whether a release search can run for it (it is in the app and still missing something). */
  canAnalyse: boolean;
}

export interface RequestsDoc {
  generatedAt: string;
  open: RequestReport[];
  /** Requests Seerr already counts as available. */
  available: number;
  /** What could not be read (an app away). */
  errors: string[];
}

// ─── formatting ───────────────────────────────────────────────────────────────

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** Bytes as Radarr prints them: "7.5 GB" (binary units, one decimal). */
export const gb = (bytes: number) => `${(bytes / GIB).toFixed(1)} GB`;

/** MB per minute of runtime, the unit of the size caps. */
export const mbPerMin = (bytes: number, runtimeMin: number) => (runtimeMin > 0 ? bytes / MIB / runtimeMin : 0);

export function ago(thenMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ep = (e: Episode) => `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}`;
const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

// ─── releases ─────────────────────────────────────────────────────────────────

const KINDS: readonly [RejectionKind, RegExp, string][] = [
  ['size', /is (larger than maximum|smaller than minimum) allowed/i, 'over the size cap'],
  ['quality', /is not wanted in profile/i, 'a quality the profile does not take'],
  ['score', /custom formats? .*score .* below/i, 'custom-format score below the minimum'],
  ['seeders', /seeders/i, 'too few seeders'],
  ['language', /language/i, 'wrong language'],
  ['blocklisted', /blocklist/i, 'blocklisted'],
  ['have', /existing file|meets cutoff|not an upgrade|upgrades? .*not allowed/i, 'not better than the file it has'],
  ['other', /./, 'other'],
];

export function rejectionKind(text: string): RejectionKind {
  return KINDS.find(([, re]) => re.test(text))?.[0] ?? 'other';
}

const labelOf = (k: RejectionKind) => KINDS.find(([kind]) => kind === k)?.[2] ?? k;

/** The cap a quality has in this app, from arr-policy.ts. */
export const capOf = (app: App, quality: string): SizeCap | undefined =>
  SIZE_CAPS[app].find((c) => c.quality === quality);

export function summariseReleases(
  releases: readonly Release[],
  app: App,
  runtimeMin: number,
  now: number,
): ReleaseSummary {
  const matched = releases.filter((r) => r.matched);
  const byResolution: Record<string, number> = {};
  for (const r of matched) byResolution[String(r.resolution)] = (byResolution[String(r.resolution)] ?? 0) + 1;

  const counts = new Map<RejectionKind, ReasonCount>();
  for (const r of matched) {
    if (r.approved) continue;
    const seen = new Set<RejectionKind>();
    for (const text of r.rejections) {
      const kind = rejectionKind(text);
      if (seen.has(kind)) continue;
      seen.add(kind);
      const c = counts.get(kind) ?? { kind, label: labelOf(kind), count: 0, example: text };
      c.count++;
      counts.set(kind, c);
    }
  }
  const reasons = [...counts.values()].sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));

  const rank = (a: Release, b: Release) => b.resolution - a.resolution || (b.seeders ?? 0) - (a.seeders ?? 0);
  const bestRelease = [...matched].sort(rank)[0];
  const best = bestRelease
    ? {
        title: bestRelease.title,
        quality: bestRelease.quality,
        size: bestRelease.size,
        seeders: bestRelease.seeders,
        indexer: bestRelease.indexer,
      }
    : null;

  // The release the cap cost us: refused for size alone, best seeded.
  const onlySize = matched
    .filter((r) => !r.approved && r.rejections.length > 0 && r.rejections.every((t) => rejectionKind(t) === 'size'))
    .sort(rank)[0];
  const cap = onlySize ? capOf(app, onlySize.quality)?.max : undefined;
  const oversize =
    onlySize && typeof cap === 'number'
      ? {
          title: onlySize.title,
          quality: onlySize.quality,
          size: onlySize.size,
          mbPerMin: Math.round(mbPerMin(onlySize.size, runtimeMin)),
          cap,
        }
      : null;

  return {
    searchedAt: now,
    total: releases.length,
    matched: matched.length,
    approved: matched.filter((r) => r.approved).length,
    byResolution,
    reasons,
    best,
    oversize,
  };
}

// ─── the verdict ──────────────────────────────────────────────────────────────

const ANALYSE = 'Analyse: search the indexers now and see why each release was refused.';
const appName = (app: App) => (app === 'radarr' ? 'Radarr' : 'Sonarr');
const v = (
  code: string,
  level: Level,
  summary: string,
  next: string | null = null,
  details: string[] = [],
): Verdict => ({
  code,
  level,
  summary,
  details,
  next,
});

/** Grabbed, failed and imported events, newest first. */
const newestFirst = (h: readonly HistoryEvent[]) => [...h].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));

function queueVerdict(app: App, q: readonly QueueItem[]): Verdict | null {
  if (q.length === 0) return null;
  const stuck = q.find(
    (i) =>
      ['importPending', 'importBlocked', 'importFailed', 'failedPending'].includes(i.trackedDownloadState) ||
      ['warning', 'error'].includes(i.trackedDownloadStatus) ||
      i.errorMessage !== '',
  );
  if (stuck) {
    const why = stuck.errorMessage || stuck.messages[0] || stuck.trackedDownloadState || stuck.status;
    const downloaded = stuck.sizeleft === 0 || stuck.trackedDownloadState.startsWith('import');
    return v(
      'queue-stuck',
      'degraded',
      downloaded ? `Downloaded, but not imported: ${why}` : `Stuck in the queue: ${why}`,
      downloaded
        ? `${appName(app)} → Activity → Queue shows the message; fix it there, or remove the download to search again.`
        : 'Decluttarr removes a stalled or crawling download after 3 strikes, and the app searches again.',
      [`${stuck.title}`, ...stuck.messages.slice(1, 4)],
    );
  }
  const d = q[0] as QueueItem;
  const pct = d.size > 0 ? Math.floor(((d.size - d.sizeleft) / d.size) * 100) : 0;
  return v(
    'downloading',
    'ok',
    `Downloading: ${pct}% of ${gb(d.size)}${d.timeleft ? `, about ${d.timeleft} left` : ''}`,
    null,
    [d.title],
  );
}

function releasesVerdict(f: Facts, arr: ArrTitle, r: ReleaseSummary, now: number): Verdict {
  const when = `Searched ${ago(r.searchedAt, now)}: ${plural(r.total, 'result')}, ${r.matched} for this title.`;
  const failing = f.indexersFailing.length ? [`Failing in Prowlarr: ${f.indexersFailing.join('; ')}`] : [];
  if (r.matched === 0)
    return v(
      'no-releases',
      'degraded',
      'No indexer has a release of it yet.',
      failing.length
        ? 'Fix the failing indexers in Prowlarr first.'
        : `Wait: ${appName(arr.app)} checks the indexers' new releases every 15 minutes and grabs one that fits.`,
      [when, ...failing],
    );
  if (r.approved > 0)
    return v(
      'grabbable',
      'degraded',
      `${plural(r.approved, 'release passes', 'releases pass')} the profile, but none was grabbed yet.`,
      `Search for it in ${appName(arr.app)} (Search Monitored), or wait for its next check.`,
      [when, ...(r.best ? [`Best: ${r.best.title}`] : [])],
    );

  const details = [
    when,
    ...r.reasons.slice(0, 4).map((x) => `${x.count} × ${x.label} (e.g. “${x.example}”)`),
    ...failing,
  ];
  const top = r.reasons[0]?.kind;
  const has4k = (r.byResolution['2160'] ?? 0) > 0;
  const defaultMovie = arr.app === 'radarr' && arr.profile === DEFAULT_PROFILE.radarr;
  const fallback = FALLBACK_PROFILES.radarr[0];

  if (defaultMovie && !has4k)
    return v(
      'no-4k',
      'degraded',
      `No 4K release yet: all ${r.matched} are ${Object.keys(r.byResolution)
        .sort((a, b) => Number(b) - Number(a))
        .map((x) => `${x}p`)
        .join(' or ')}, and “${DEFAULT_PROFILE.radarr}” takes 4K only.`,
      `Switch it to “${VARIANT_PROFILE}” in Radarr (Edit → Quality Profile): it takes 1080p now and is searched again daily for 4K.`,
      [
        ...details,
        ...(r.best ? [`Best 1080p: ${r.best.title} (${gb(r.best.size)}, ${r.best.seeders ?? '?'} seeders)`] : []),
      ],
    );
  if (r.oversize && (top === 'size' || r.reasons.some((x) => x.kind === 'size')))
    return v(
      'size-cap',
      'degraded',
      `The best release is over the size cap: ${gb(r.oversize.size)} is ${r.oversize.mbPerMin} MB/min for a ${arr.runtime}-minute runtime, and ${r.oversize.quality} is capped at ${r.oversize.cap}.`,
      `Raise ${r.oversize.quality}'s cap in stack/lib/arr-policy.ts (SIZE_CAPS), then task arr:configure; or wait for a smaller release.`,
      [...details, `Refused for size: ${r.oversize.title}`],
    );
  if (defaultMovie && has4k && top === 'score' && fallback)
    return v(
      'no-hdr',
      'degraded',
      '4K releases exist, but none has the HDR the profile requires (custom-format score below its minimum).',
      `Switch it to “${fallback}” in Radarr: 4K without HDR, no upgrades.`,
      details,
    );
  const nextOf: Partial<Record<RejectionKind, string>> = {
    quality: `Switch it to a profile that takes ${Object.keys(r.byResolution)
      .map((x) => `${x}p`)
      .join('/')}${arr.app === 'radarr' ? ` (“${VARIANT_PROFILE}”)` : ''}.`,
    seeders: 'Wait for seeders: Prowlarr skips releases under its minimum (MIN_SEEDERS in apps/prowlarr/configure.ts).',
    language: `Its releases are dubbed: wait for one in the original language, or pick one by hand in ${appName(arr.app)} (Interactive Search).`,
    score: `Pick one by hand in ${appName(arr.app)} (Interactive Search), or switch the profile.`,
    blocklisted: `The ones left were blocklisted after failing; ${appName(arr.app)} → Activity → Blocklist lists them.`,
  };
  return v(
    'all-rejected',
    'degraded',
    `Every release was refused: mostly ${r.reasons[0]?.label ?? 'other reasons'}.`,
    (top && nextOf[top]) ?? `See the refusals in ${appName(arr.app)}'s Interactive Search.`,
    details,
  );
}

export function diagnose(f: Facts, now: number): Verdict {
  const { request: q, arr } = f;
  const app: App = q.type === 'movie' ? 'radarr' : 'sonarr';
  if (q.status === REQUEST_STATUS.pending)
    return v('waiting-approval', 'degraded', 'Waiting for approval in Seerr.', 'Approve it in Seerr → Requests.');
  if (q.status === REQUEST_STATUS.declined) return v('declined', 'down', 'Declined in Seerr.');
  if (q.mediaStatus === MEDIA_STATUS.available || q.status === REQUEST_STATUS.completed)
    return v('available', 'ok', 'Available.');
  if (f.arrError) return v('app-unreachable', 'unknown', `${appName(app)} did not answer: ${f.arrError}`);
  if (!arr)
    return v(
      'not-in-app',
      'down',
      `Not in ${appName(app)}: Seerr's add failed, or it was removed there since.`,
      `Check Seerr's log (task seerr:logs), then request it again.`,
    );

  if (app === 'radarr') {
    if (arr.hasFile) return v('imported', 'ok', 'Radarr has the file; Seerr marks it available after its next scan.');
    if (!arr.monitored)
      return v('unmonitored', 'degraded', 'Unmonitored in Radarr: it is never searched.', 'Monitor it in Radarr.');
    if (!arr.isAvailable)
      return v('not-released', 'ok', `Not out yet (Radarr says ${arr.status}); it is searched once it is released.`);
  } else {
    const requested = arr.episodes.filter((e) => q.seasons.length === 0 || q.seasons.includes(e.season));
    const aired = (e: Episode) => e.airDate !== null && Date.parse(e.airDate) <= now;
    const missing = requested.filter((e) => !e.hasFile && aired(e));
    const upcoming = requested
      .filter((e) => !e.hasFile && !aired(e))
      .sort((a, b) => (a.airDate ?? '').localeCompare(b.airDate ?? ''));
    if (missing.length === 0) {
      const nextEp = upcoming[0];
      if (nextEp)
        return v(
          'waiting-air',
          'ok',
          `Every aired episode is in; ${plural(upcoming.length, 'episode')} still to air, next ${ep(nextEp)}${nextEp.airDate ? ` on ${day(nextEp.airDate)}` : ''}.`,
        );
      return v('imported', 'ok', 'Sonarr has every requested episode; Seerr catches up after its next scan.');
    }
    if (missing.every((e) => !e.monitored))
      return v(
        'unmonitored',
        'degraded',
        `${plural(missing.length, 'missing episode is', 'missing episodes are')} unmonitored in Sonarr: never searched.`,
        'Monitor them in Sonarr.',
        missing.slice(0, 6).map(ep),
      );
  }

  const queued = queueVerdict(app, f.queue);
  if (queued) return queued;

  const last = newestFirst(f.history)[0];
  if (last && (last.eventType === 'downloadFailed' || last.eventType === 'importFailed'))
    return v(
      'failed',
      'down',
      `The last download ${last.eventType === 'importFailed' ? 'could not be imported' : 'failed'}: ${last.message || last.sourceTitle}`,
      `${appName(app)} blocklists a failed release and searches again; Analyse to see what is left.`,
      [`${last.sourceTitle}, ${ago(Date.parse(last.date), now)}`],
    );
  if (last && last.eventType === 'grabbed')
    return v(
      'grab-gone',
      'degraded',
      `Grabbed ${ago(Date.parse(last.date), now)}, but no longer in the queue and not imported.`,
      `${appName(app)} → Activity → History says what happened to it; Analyse to see what else there is.`,
      [last.sourceTitle],
    );

  if (!f.releases) {
    const missingWhat =
      app === 'sonarr'
        ? `${plural(
            arr.episodes.filter((e) => !e.hasFile && e.airDate !== null && Date.parse(e.airDate) <= now).length,
            'aired episode',
          )} missing, nothing grabbed.`
        : 'Searched when it was added, and nothing was grabbed.';
    return v(
      'not-analysed',
      'unknown',
      missingWhat,
      ANALYSE,
      f.indexersFailing.map((x) => `Failing in Prowlarr: ${x}`),
    );
  }
  return releasesVerdict(f, arr, f.releases, now);
}

/** The verdicts a release search cannot change: done, waiting on something else, or not searchable. */
const NOTHING_TO_SEARCH = new Set([
  'waiting-approval',
  'declined',
  'available',
  'app-unreachable',
  'not-in-app',
  'imported',
  'unmonitored',
  'not-released',
  'waiting-air',
  'downloading',
]);

/** Whether a release search can tell anything more about it. */
export const canAnalyse = (f: Facts, verdict: Verdict): boolean =>
  f.arr !== null && !NOTHING_TO_SEARCH.has(verdict.code);

/** The page's row for one request. */
export function report(f: Facts, now: number): RequestReport {
  const app: App = f.request.type === 'movie' ? 'radarr' : 'sonarr';
  const verdict = diagnose(f, now);
  return {
    id: f.request.id,
    type: f.request.type,
    app,
    title: f.arr?.title ?? `TMDB ${f.request.tmdbId}`,
    year: f.arr?.year ?? null,
    requestedBy: f.request.requestedBy,
    requestedAt: f.request.createdAt,
    profile: f.arr?.profile ?? null,
    seasons: f.request.seasons,
    verdict,
    releases: f.releases,
    canAnalyse: canAnalyse(f, verdict),
  };
}
