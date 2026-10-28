// Pure helpers for the requests page's client script (requests-client.ts), so
// `task site:test` runs them without Astro. The document is jobs/stack-api's
// GET /api/requests; its types are stack/lib/request-doctor.ts's, the module
// that writes the verdicts.

import type { ReleaseSummary, RequestReport, RequestsDoc } from '../../../stack/lib/request-doctor.ts';

export type { ReleaseSummary, RequestReport, RequestsDoc };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The document, if it has the shape the page reads; else null. */
export function parseRequests(v: unknown): RequestsDoc | null {
  if (!isObj(v) || typeof v.generatedAt !== 'string' || !Array.isArray(v.open) || !Array.isArray(v.errors)) return null;
  const ok = v.open.every(
    (r) =>
      isObj(r) &&
      typeof r.id === 'number' &&
      typeof r.title === 'string' &&
      isObj(r.verdict) &&
      typeof r.verdict.summary === 'string',
  );
  return ok ? (v as unknown as RequestsDoc) : null;
}

/** One request answered by an Analyse, if it is one. */
export const parseReport = (v: unknown): RequestReport | null =>
  parseRequests({ generatedAt: '', open: [v], errors: [] })?.open[0] ?? null;

/** "Hope (2026)" · "Dark Matter (2024), season 2". */
export function titleOf(r: Pick<RequestReport, 'title' | 'year' | 'type' | 'seasons'>): string {
  const year = r.year !== null && !r.title.includes(`(${r.year})`) ? ` (${r.year})` : '';
  const seasons =
    r.type === 'tv' && r.seasons.length > 0 ? `, season${r.seasons.length > 1 ? 's' : ''} ${r.seasons.join(', ')}` : '';
  return `${r.title}${year}${seasons}`;
}

const DAY = 86_400_000;
/** "requested by owner today" / "… 3 days ago". */
export function requestedLine(r: Pick<RequestReport, 'requestedBy' | 'requestedAt'>, nowMs: number): string {
  const t = Date.parse(r.requestedAt);
  const days = Number.isNaN(t) ? null : Math.floor((nowMs - t) / DAY);
  const when = days === null ? '' : days <= 0 ? ' today' : days === 1 ? ' yesterday' : ` ${days} days ago`;
  return `requested by ${r.requestedBy}${when}`;
}

/** The profile and app it is in: "Radarr · UHD Bluray + WEB". */
export const whereLine = (r: Pick<RequestReport, 'app' | 'profile'>) =>
  `${r.app === 'radarr' ? 'Radarr' : 'Sonarr'}${r.profile ? ` · ${r.profile}` : ''}`;

/** One line about the last search: "Last search: 128 results, 19 for it, none acceptable." */
export function searchLine(s: ReleaseSummary | null): string {
  if (!s) return '';
  const ok = s.approved === 0 ? 'none acceptable' : `${s.approved} acceptable`;
  return `Last search: ${s.total} result${s.total === 1 ? '' : 's'}, ${s.matched} for it, ${ok}.`;
}

/** The page's order: the ones that need something first (down, degraded, unknown), then waiting ones. */
const RANK: Record<string, number> = { down: 0, degraded: 1, unknown: 2, ok: 3 };
export const byAttention = (a: RequestReport, b: RequestReport) =>
  (RANK[a.verdict.level] ?? 2) - (RANK[b.verdict.level] ?? 2) || b.requestedAt.localeCompare(a.requestedAt);
