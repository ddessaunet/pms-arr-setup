// The logs page's browser side: /live/logs.json on load and every 2 minutes
// while the tab is visible. Everything from the file is untrusted: it is only
// ever set with textContent, never innerHTML.

import { el, q, qa } from './dom.ts';
import { signInIfSignedOut } from './session.ts';
import { clock, formatAgo, parseLogs, type LogSource } from './status-view.ts';

const LOGS_URL = '/live/logs.json';
const LOGS_POLL_MS = 120_000;

function logLines(lines: { t: string | null; msg: string }[]): string {
  return lines.length ? lines.map((l) => `${clock(l.t).padEnd(8)} ${l.msg}`).join('\n') : '(none)';
}

function sourceBlock(s: LogSource): HTMLDetailsElement {
  const d = el('details', 'dash-src');
  const sum = el('summary');
  sum.append(
    el('span', 'dash-src-label', s.label),
    el('span', 'dash-src-kind', s.kind === 'journal' ? 'job' : 'container'),
    el(
      'span',
      s.problemCount ? 'dash-src-count dash-src-warn' : 'dash-src-count',
      s.problemCount ? `${s.problemCount} warning/error line${s.problemCount === 1 ? '' : 's'}` : 'no warnings',
    ),
  );
  d.append(sum);
  if (s.error) d.append(el('p', 'dash-src-error', `Could not read it: ${s.error}`));
  for (const [title, lines] of [
    [`Warnings and errors (last ${s.problems.length})`, s.problems],
    [`Last ${s.tail.length} lines`, s.tail],
  ] as const) {
    const inner = el('details', 'dash-src-view');
    inner.append(el('summary', '', title));
    const pre = el('pre', '', logLines(lines));
    pre.tabIndex = 0;
    inner.append(pre);
    d.append(inner);
  }
  return d;
}

async function loadLogs() {
  const box = q('[data-log-sources]');
  const meta = q('[data-logs-meta]');
  if (!box) return;
  try {
    const res = await fetch(LOGS_URL, { cache: 'no-store' });
    if (signInIfSignedOut(res)) return;
    if (!res.ok) throw new Error(String(res.status));
    const logs = parseLogs(await res.json());
    if (!logs) throw new Error('unreadable');
    // Keep what the viewer has open across refreshes.
    const open = new Set(qa<HTMLDetailsElement>('.dash-src[open]').map((d) => d.dataset.id));
    const openViews = new Set(qa<HTMLDetailsElement>('.dash-src-view[open]').map((d) => d.dataset.key));
    box.replaceChildren(
      ...logs.sources.map((s) => {
        const b = sourceBlock(s);
        b.dataset.id = s.id;
        b.open = open.has(s.id);
        b.querySelectorAll<HTMLDetailsElement>('.dash-src-view').forEach((v, i) => {
          v.dataset.key = `${s.id}#${i}`;
          v.open = openViews.has(v.dataset.key);
        });
        return b;
      }),
    );
    if (meta)
      meta.textContent = `${logs.sources.length} sources, ${formatAgo(Math.max(0, Math.round(Date.now() / 1000 - logs.generatedAtEpoch)))} old.`;
  } catch {
    box.replaceChildren(el('p', 'dash-empty', 'Logs unavailable: no data from the status job (/live/logs.json).'));
    if (meta) meta.textContent = '';
  }
}

function start() {
  void loadLogs();
  let timer = window.setInterval(loadLogs, LOGS_POLL_MS);
  document.addEventListener('visibilitychange', () => {
    window.clearInterval(timer);
    if (!document.hidden) {
      void loadLogs();
      timer = window.setInterval(loadLogs, LOGS_POLL_MS);
    }
  });
}

start();
