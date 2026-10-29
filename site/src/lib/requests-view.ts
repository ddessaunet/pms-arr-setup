// Pure helpers for the requests page's client script (requests-client.ts), so
// `task site:test` runs them without Astro. The document is jobs/stack-api's
// GET /api/requests; its types are stack/lib/request-doctor.ts's, the module
// that writes the verdicts.

import {
  ago,
  type Advice,
  type AdviseState,
  type AiInfo,
  type AiJob,
  type AiModel,
  type ReleaseSummary,
  type RequestReport,
  type RequestsDoc,
} from '../../../stack/lib/request-doctor.ts';

export type { Advice, AdviseState, AiInfo, AiJob, AiModel, ReleaseSummary, RequestReport, RequestsDoc };

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

/** One AI answer, if it has the shape the page reads; else null. */
export function parseAdvice(v: unknown): Advice | null {
  if (!isObj(v)) return null;
  const ok =
    typeof v.text === 'string' &&
    typeof v.provider === 'string' &&
    typeof v.model === 'string' &&
    typeof v.at === 'string' &&
    typeof v.seconds === 'number';
  return ok ? (v as unknown as Advice) : null;
}

const isJob = (v: unknown): v is AiJob =>
  isObj(v) && typeof v.id === 'number' && typeof v.model === 'string' && typeof v.startedAt === 'string';

/** GET/POST /api/requests/:id/advise's answer, if it is one. */
export function parseAdviseState(v: unknown): AdviseState | null {
  if (!isObj(v)) return null;
  if (v.state === 'running') return isJob(v.job) ? { state: 'running', job: v.job } : null;
  if (v.state === 'done') {
    const advice = parseAdvice(v.advice);
    return advice ? { state: 'done', advice } : null;
  }
  if (v.state === 'failed') return typeof v.error === 'string' ? { state: 'failed', error: v.error } : null;
  return v.state === 'idle' ? { state: 'idle' } : null;
}

/** How long an answer has been running: "0:42", "3:05". */
export function elapsed(startedAt: string, nowMs: number): string {
  const t = Date.parse(startedAt);
  const s = Number.isNaN(t) ? 0 : Math.max(0, Math.floor((nowMs - t) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
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

/** The page's two groups: what needs something (any level but ok), and what is on track; each in byAttention's order. */
export function splitByHealth(open: readonly RequestReport[]): { issues: RequestReport[]; ok: RequestReport[] } {
  const sorted = [...open].sort(byAttention);
  return { issues: sorted.filter((r) => r.verdict.level !== 'ok'), ok: sorted.filter((r) => r.verdict.level === 'ok') };
}

/** "AI · qwen2.5:3b · 2 min ago · took 38 s". */
export function adviceLine(a: Advice, nowMs: number): string {
  const t = Date.parse(a.at);
  const when = Number.isNaN(t) ? '' : ` · ${ago(t, nowMs)}`;
  return `AI · ${a.model}${when} · took ${Math.round(a.seconds)} s`;
}

const PARAGRAPHS_MAX = 8;
const PARAGRAPH_CHARS = 1200;
/** The answer's paragraphs: split on blank lines, trimmed, empty ones dropped, capped. */
export const adviceParagraphs = (text: string): string[] =>
  text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, PARAGRAPHS_MAX)
    .map((p) => (p.length > PARAGRAPH_CHARS ? `${p.slice(0, PARAGRAPH_CHARS)}…` : p));

/** A model as the picker names it: its own name, and the provider when there is more than one. */
export function modelLabel(m: AiModel, all: readonly AiModel[]): string {
  const providers = new Set(all.map((x) => x.provider));
  return providers.size > 1 ? `${m.model} (${m.provider})` : m.model;
}

/** The model to ask: the stored choice while it is still listed, else the default, else the first. */
export function pickModel(ai: AiInfo, stored: string | null): AiModel | null {
  return ai.models.find((m) => m.id === stored) ?? ai.models.find((m) => m.id === ai.default) ?? ai.models[0] ?? null;
}
