// Pure helpers for the dashboard's client script (status-client.ts), so
// `task site:test` can run them under plain node. They read the documents
// jobs/stack-status/stack-status.sh writes to /live/; its golden status.json
// is the shape (status-schema.ts checks it).

export type Level = 'ok' | 'degraded' | 'down' | 'unknown' | 'n/a';

/** Every level is a word and a mark: colour only reinforces it. */
export const LEVELS: Record<Level, { word: string; mark: string }> = {
  ok: { word: 'OK', mark: '●' },
  degraded: { word: 'Degraded', mark: '◐' },
  down: { word: 'Down', mark: '✕' },
  unknown: { word: 'Unknown', mark: '?' },
  'n/a': { word: 'N/A', mark: '–' },
};

export interface Reason { level: 'down' | 'degraded' | 'notice'; text: string }
export interface Item { id: string; level: Level; summary: string; reasons: Reason[]; label?: string; kind?: string }
export interface StatusDoc {
  schema: 1;
  generatedAt: string;
  generatedAtEpoch: number;
  staleAfterSeconds: number;
  overall: Level;
  notes: string[];
  lan: { iface: string; addr: string }[];
  apps: Item[];
  host: Item[];
}
export interface LogLine { t: string | null; msg: string }
export interface LogSource {
  id: string; kind: 'journal' | 'docker'; label: string;
  tail: LogLine[]; problems: LogLine[]; problemCount: number; error: string | null;
}
export interface LogsDoc { schema: 1; generatedAtEpoch: number; sources: LogSource[] }

const isLevel = (x: unknown): x is Level => typeof x === 'string' && x in LEVELS;

/** The status document, or null for a missing, garbled or newer one. */
export function parseStatus(x: unknown): StatusDoc | null {
  if (!x || typeof x !== 'object') return null;
  const d = x as Record<string, unknown>;
  if (d.schema !== 1 || typeof d.generatedAtEpoch !== 'number' || !isLevel(d.overall)) return null;
  if (!Array.isArray(d.apps) || !Array.isArray(d.host)) return null;
  if (typeof d.staleAfterSeconds !== 'number') return null;
  return d as unknown as StatusDoc;
}

export function parseLogs(x: unknown): LogsDoc | null {
  if (!x || typeof x !== 'object') return null;
  const d = x as Record<string, unknown>;
  return d.schema === 1 && Array.isArray(d.sources) ? (d as unknown as LogsDoc) : null;
}

/**
 * A service's link on the host the page was opened from, so it follows the
 * box when DHCP moves it. Keeps the scheme and IPv6 brackets right.
 */
export function serviceUrl(loc: { protocol: string; hostname: string }, port: number, path: string): string {
  const u = new URL(`${loc.protocol}//${loc.hostname}`);
  u.port = String(port);
  u.pathname = path;
  return u.toString();
}

/**
 * Seconds since the job wrote the document, by the server's clock: nginx's
 * Date header at fetch time, plus the time since the fetch. A phone whose clock
 * is wrong still sees the right age. Without the header, the browser's clock.
 */
export function ageSeconds(generatedEpoch: number, serverDate: string | null, fetchedAtMs: number, nowMs: number): number {
  const server = serverDate ? Date.parse(serverDate) : NaN;
  const atFetch = Number.isNaN(server) ? fetchedAtMs : server;
  return Math.max(0, Math.round((atFetch - generatedEpoch * 1000 + (nowMs - fetchedAtMs)) / 1000));
}

/** Past staleAfterSeconds (three missed runs) the job is not running. */
export const isStale = (age: number, staleAfterSeconds: number): boolean => age > staleAfterSeconds;

export function formatAgo(s: number): string {
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.floor(s / 60)} min`;
  if (s < 172800) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

/** The badge text: "● OK", or "Stale (was ● OK)" once the data is old. */
export function levelText(level: Level, stale = false): string {
  const l = LEVELS[level] ?? LEVELS.unknown;
  return stale ? `Stale (was ${l.mark} ${l.word})` : `${l.mark} ${l.word}`;
}

/** "HH:MM:SS" in the viewer's time zone, or "" for a line with no time. */
export function clock(t: string | null): string {
  if (!t) return '';
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour12: false });
}
