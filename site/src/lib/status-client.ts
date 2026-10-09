// The dashboard's browser side: links from the address the page was opened on,
// /live/status.json every 30 s, /live/logs.json while the logs are open.
// Everything from the files is untrusted (logs especially): it is only ever
// set with textContent, never innerHTML.

import {
  ageSeconds, clock, formatAgo, isStale, levelText, parseLogs, parseStatus, serviceUrl,
  type Item, type Level, type LogSource, type StatusDoc,
} from './status-view.ts';

const STATUS_URL = '/live/status.json';
const LOGS_URL = '/live/logs.json';
const POLL_MS = 30_000;
const TICK_MS = 5_000;
const LOGS_POLL_MS = 120_000;

let doc: StatusDoc | null = null;
let dateHeader: string | null = null;
let fetchedAt = 0;
let unavailable = false;
let announced = '';

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const qa = <T extends Element = HTMLElement>(sel: string) => Array.from(document.querySelectorAll<T>(sel));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function badge(level: Level, stale: boolean, big = false): HTMLSpanElement {
  const b = el('span', big ? 'lvl lvl-big' : 'lvl');
  setBadge(b, level, stale);
  return b;
}
function setBadge(b: HTMLElement, level: Level, stale: boolean) {
  b.dataset.level = stale ? 'stale' : level;
  b.textContent = levelText(level, stale);
}

function setLinks() {
  for (const a of qa<HTMLAnchorElement>('a[data-port]')) {
    const url = serviceUrl(location, Number(a.dataset.port), a.dataset.path ?? '/');
    a.href = url;
    const app = a.closest<HTMLElement>('[data-app]')?.dataset.app;
    const code = app ? q(`[data-url-for="${app}"]`) : null;
    if (code) code.textContent = new URL(url).host + (a.dataset.path === '/' ? '' : a.dataset.path);
  }
}

function reasonsList(ul: HTMLElement, item: Item) {
  ul.replaceChildren();
  const shown = item.reasons.filter((r) => r.level !== 'notice' || item.level === 'ok');
  for (const r of shown.slice(0, 4)) {
    const li = el('li', `reason reason-${r.level}`);
    li.append(el('span', 'reason-level', r.level === 'notice' ? 'Note' : r.level === 'down' ? 'Down' : 'Degraded'), ` ${r.text}`);
    ul.append(li);
  }
  ul.hidden = ul.childElementCount === 0;
}

function render() {
  const overall = q('[data-overall]');
  const ageEl = q('[data-age]');
  const staleEl = q('[data-stale]');
  if (!overall || !ageEl || !staleEl) return;

  if (!doc) {
    setBadge(overall, 'unknown', false);
    ageEl.textContent = unavailable
      ? 'Status unavailable: no data from the status job (/live/status.json). The links still work.'
      : 'Waiting for the status job…';
    const host = q('[data-host]');
    if (host && unavailable) host.replaceChildren(el('li', 'dash-empty', 'Unavailable: no data from the status job.'));
    return;
  }
  const age = ageSeconds(doc.generatedAtEpoch, dateHeader, fetchedAt, Date.now());
  const stale = isStale(age, doc.staleAfterSeconds);

  setBadge(overall, doc.overall, stale);
  ageEl.textContent = `Updated ${formatAgo(age)} ago.`;
  const lan = q('[data-lan]');
  if (lan) lan.textContent = doc.lan.length ? `On ${doc.lan.map((a) => `${a.addr} (${a.iface})`).join(', ')}.` : '';
  staleEl.hidden = !stale;
  staleEl.textContent = stale
    ? `This is ${formatAgo(age)} old: the status job is not running. Check it with systemctl list-timers stack-status.timer, or task stack-status:logs.`
    : '';

  // What makes the stack not OK, by name, so the bar answers "why" by itself.
  const attention = q('[data-attention]');
  if (attention) {
    const bad = [...doc.apps, ...doc.host].filter((i) => i.level === 'down' || i.level === 'degraded');
    attention.replaceChildren(
      ...bad.slice(0, 6).map((i) => {
        const li = el('li');
        const name = i.label ?? q(`[data-app="${i.id}"] h3`)?.textContent?.trim() ?? i.id;
        li.append(badge(i.level, stale), el('span', 'dash-attention-name', name), el('span', 'dash-attention-why', i.summary));
        return li;
      }),
      ...(bad.length > 6 ? [el('li', 'dash-empty', `and ${bad.length - 6} more below`)] : []),
    );
    attention.hidden = bad.length === 0;
  }

  const notes = q('[data-notes]');
  if (notes) {
    notes.replaceChildren(...doc.notes.map((n) => el('li', '', n)));
    notes.hidden = doc.notes.length === 0;
  }

  for (const item of doc.apps) {
    const b = q(`[data-level-for="${item.id}"]`);
    if (b) setBadge(b, item.level, stale);
    const s = q(`[data-summary-for="${item.id}"]`);
    if (s) s.textContent = item.summary;
    const ul = q(`[data-reasons-for="${item.id}"]`);
    if (ul) reasonsList(ul, item);
  }
  for (const card of qa('[data-app]')) {
    const id = card.dataset.app as string;
    if (!doc.apps.some((a) => a.id === id)) {
      const s = q(`[data-summary-for="${id}"]`);
      if (s) s.textContent = 'Not checked by the status job.';
    }
  }

  const host = q('[data-host]');
  if (host) {
    host.replaceChildren(
      ...doc.host.map((h) => {
        const li = el('li', 'dash-host-item');
        li.append(el('span', 'dash-host-label', h.label ?? h.id), badge(h.level, stale), el('span', 'dash-host-summary', h.summary));
        return li;
      }),
    );
  }

  const word = levelText(doc.overall, stale);
  if (word !== announced) {
    const a = q('[data-announce]');
    if (a && announced !== '') a.textContent = `Stack status: ${word}`;
    announced = word;
  }
}

async function poll() {
  try {
    const res = await fetch(STATUS_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const next = parseStatus(await res.json());
    if (!next) throw new Error('unreadable');
    doc = next;
    dateHeader = res.headers.get('Date');
    fetchedAt = Date.now();
    unavailable = false;
  } catch {
    unavailable = true; // keep the last good document: it turns stale on its own
  }
  render();
}

function logLines(lines: { t: string | null; msg: string }[]): string {
  return lines.length ? lines.map((l) => `${clock(l.t).padEnd(8)} ${l.msg}`).join('\n') : '(none)';
}

function sourceBlock(s: LogSource): HTMLDetailsElement {
  const d = el('details', 'dash-src');
  const sum = el('summary');
  sum.append(
    el('span', 'dash-src-label', s.label),
    el('span', 'dash-src-kind', s.kind === 'journal' ? 'job' : 'container'),
    el('span', s.problemCount ? 'dash-src-count dash-src-warn' : 'dash-src-count',
      s.problemCount ? `${s.problemCount} warning/error line${s.problemCount === 1 ? '' : 's'}` : 'no warnings'),
  );
  d.append(sum);
  if (s.error) d.append(el('p', 'dash-src-error', `Could not read it: ${s.error}`));
  for (const [title, lines] of [[`Warnings and errors (last ${s.problems.length})`, s.problems], [`Last ${s.tail.length} lines`, s.tail]] as const) {
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
    if (meta) meta.textContent = `(${logs.sources.length} sources, ${formatAgo(Math.max(0, Math.round(Date.now() / 1000 - logs.generatedAtEpoch)))} old)`;
  } catch {
    box.replaceChildren(el('p', 'dash-empty', 'Logs unavailable: no data from the status job (/live/logs.json).'));
  }
}

function start() {
  setLinks();
  render();
  void poll();
  let timer = window.setInterval(poll, POLL_MS);
  window.setInterval(render, TICK_MS);
  document.addEventListener('visibilitychange', () => {
    window.clearInterval(timer);
    if (!document.hidden) {
      void poll();
      timer = window.setInterval(poll, POLL_MS);
    }
  });

  const logs = q<HTMLDetailsElement>('[data-logs]');
  let logsTimer = 0;
  logs?.addEventListener('toggle', () => {
    window.clearInterval(logsTimer);
    if (logs.open) {
      void loadLogs();
      logsTimer = window.setInterval(loadLogs, LOGS_POLL_MS);
    }
  });
}

start();
