// Pure helpers for the control page (control-client.ts): the rows of its
// Running, Jobs and Drift sections, read from the facts in /live/status.json
// (jobs/stack-status). Kept apart from the DOM so `task site:test` runs them.

import { formatAgo, type Level, type StatusDoc } from './status-view.ts';

/** Something that runs all the time: a container, or the arr-reclaim watcher. */
export interface RunningRow {
  id: string;
  name: string;
  kind: 'container' | 'service';
  level: Level;
  state: string;
  uptime: string;
  restarts: string;
  version: string;
  /** What Restart acts on: the container's name, or the unit's. */
  target: string;
}

export interface JobRow {
  id: string;
  name: string;
  level: Level;
  armed: boolean;
  running: boolean;
  last: string;
  next: string;
  result: string;
}

export interface DriftRow {
  id: string;
  name: string;
  level: Level;
  result: string;
  lines: string[];
}

interface ContainerFacts {
  state?: string;
  running?: boolean;
  restartCount?: number;
  startedAt?: string | null;
  health?: string | null;
}

const DASH = '—';
const obj = (x: unknown): Record<string, unknown> | null =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
const secondsSince = (epochMs: number, nowMs: number) => Math.max(0, Math.round((nowMs - epochMs) / 1000));

/** Containers first, in the job's order, then the watcher. One-shot apps (recyclarr) have no container facts. */
export function runningRows(doc: StatusDoc, labels: Record<string, string>, nowMs: number): RunningRow[] {
  const rows: RunningRow[] = [];
  for (const app of doc.apps) {
    const c = obj(app.facts?.container) as ContainerFacts | null;
    if (!c) continue;
    const started = c.startedAt ? Date.parse(c.startedAt) : NaN;
    rows.push({
      id: app.id,
      name: labels[app.id] ?? app.id,
      kind: 'container',
      level: app.level,
      state: [c.state ?? 'unknown', c.health ? `(${c.health})` : ''].filter(Boolean).join(' '),
      uptime: c.running && !Number.isNaN(started) ? formatAgo(secondsSince(started, nowMs)) : DASH,
      restarts: typeof c.restartCount === 'number' ? String(c.restartCount) : DASH,
      version: typeof app.facts?.version === 'string' ? app.facts.version : DASH,
      target: app.id,
    });
  }
  for (const h of doc.host) {
    if (h.kind !== 'service') continue;
    const name = h.label ?? h.id.replace(/^service:/, '');
    const since = h.facts?.since;
    rows.push({
      id: h.id,
      name,
      kind: 'service',
      level: h.level,
      state: h.facts?.active ? 'active' : 'inactive',
      uptime: h.facts?.active && typeof since === 'number' ? formatAgo(secondsSince(since * 1000, nowMs)) : DASH,
      restarts: DASH,
      version: DASH,
      target: name,
    });
  }
  return rows;
}

/** Every timer the job checks, plus Recyclarr's sync, which runs on demand only. */
export function jobRows(doc: StatusDoc, nowMs: number): JobRow[] {
  const rows: JobRow[] = doc.host
    .filter((h) => h.kind === 'timer')
    .map((h) => {
      const f = h.facts ?? {};
      const last = typeof f.lastRun === 'number' ? `${formatAgo(secondsSince(f.lastRun * 1000, nowMs))} ago` : 'never';
      const next =
        typeof f.nextRun === 'number'
          ? `in ${formatAgo(secondsSince(nowMs, f.nextRun * 1000))}`
          : f.armed
            ? DASH
            : 'not armed';
      return {
        id: h.label ?? h.id.replace(/^timer:/, ''),
        name: h.label ?? h.id.replace(/^timer:/, ''),
        level: h.level,
        armed: f.armed === true,
        running: f.running === true,
        last,
        next,
        result: typeof f.lastResult === 'string' ? f.lastResult : DASH,
      };
    });
  rows.push({
    id: 'recyclarr',
    name: 'recyclarr sync',
    level: 'n/a',
    armed: false,
    running: false,
    last: DASH,
    next: 'on demand',
    result: DASH,
  });
  return rows;
}

/** The hourly check's result word, as a level: a warning is not drift. */
export function driftLevel(result: string): Level {
  if (result === 'ok') return 'ok';
  if (result === 'warn' || result === 'drift') return 'degraded';
  if (result === 'failed') return 'down';
  return 'unknown';
}

/** The apps the hourly check covers, then the deploy itself. */
export function driftRows(doc: StatusDoc, labels: Record<string, string>): DriftRow[] {
  const rows: DriftRow[] = [];
  for (const app of doc.apps) {
    const d = obj(app.facts?.drift);
    if (!d || typeof d.result !== 'string') continue;
    rows.push({
      id: app.id,
      name: labels[app.id] ?? app.id,
      level: driftLevel(d.result),
      result: d.result,
      lines: Array.isArray(d.lines) ? d.lines.map(String) : [],
    });
  }
  const host = doc.host.find((h) => h.kind === 'drift');
  const deploy = obj(host?.facts?.deploy);
  if (deploy && typeof deploy.result === 'string') {
    rows.push({
      id: 'deploy',
      name: 'deploy',
      level: driftLevel(deploy.result),
      result: deploy.result,
      lines: Array.isArray(deploy.lines) ? deploy.lines.map(String) : [],
    });
  }
  return rows;
}
