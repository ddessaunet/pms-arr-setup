// The requests page's script (components/RequestsList.astro): every open Seerr
// request with jobs/stack-api's verdict, and an Analyse button that runs a
// release search for one. Data is only ever set as textContent, never as HTML:
// titles and release names come from the indexers.

import { el, q } from './dom.ts';
import { signInIfSignedOut } from './session.ts';
import { LEVELS, type Level } from './status-view.ts';
import {
  byAttention,
  parseReport,
  parseRequests,
  requestedLine,
  searchLine,
  titleOf,
  whereLine,
  type RequestReport,
  type RequestsDoc,
} from './requests-view.ts';

const URL_ = '/api/requests';
const POLL_MS = 60_000;

let doc: RequestsDoc | null = null;
let busy: number | null = null;
const notes = new Map<number, string>();

function badge(level: Level) {
  const l = LEVELS[level] ?? LEVELS.unknown;
  const b = el('span', 'lvl', `${l.mark} ${l.word}`);
  b.dataset.level = level;
  return b;
}

function card(r: RequestReport): HTMLElement {
  const c = el('article', 'dash-card req-card');
  c.dataset.request = String(r.id);
  const head = el('header');
  head.append(el('h3', '', titleOf(r)), badge(r.verdict.level as Level));
  c.append(head, el('p', 'dash-where', `${whereLine(r)} · ${requestedLine(r, Date.now())}`));
  c.append(el('p', 'req-summary', r.verdict.summary));
  if (r.verdict.next) {
    const n = el('p', 'req-next');
    n.append(el('span', 'ctl-label', 'Next'), ` ${r.verdict.next}`);
    c.append(n);
  }
  const details = [searchLine(r.releases), ...r.verdict.details.filter((d) => !d.startsWith('Searched '))].filter(
    Boolean,
  );
  if (details.length) {
    const ul = el('ul', 'dash-reasons');
    for (const d of details) ul.append(el('li', 'reason', d));
    c.append(ul);
  }
  if (r.canAnalyse) {
    const row = el('p', 'req-actions');
    const b = el(
      'button',
      'ctl-btn ctl-btn-small',
      busy === r.id ? 'Searching…' : r.releases ? 'Analyse again' : 'Analyse',
    );
    b.type = 'button';
    b.disabled = busy !== null;
    if (busy === r.id) b.setAttribute('aria-busy', 'true');
    b.addEventListener('click', () => void analyse(r.id));
    row.append(
      b,
      el('span', 'ctl-meta', notes.get(r.id) ?? 'Searches every indexer now; takes up to a minute or two.'),
    );
    c.append(row);
  }
  return c;
}

function render() {
  const list = q('[data-requests]');
  const meta = q('[data-requests-meta]');
  const errs = q('[data-requests-errors]');
  if (!list || !meta || !errs) return;
  if (!doc) {
    meta.textContent = 'Loading…';
    return;
  }
  const open = [...doc.open].sort(byAttention);
  meta.textContent = `${open.length} open · ${doc.available} available in Seerr · checked ${new Date(doc.generatedAt).toLocaleTimeString()}`;
  errs.replaceChildren(...doc.errors.map((e) => el('li', 'reason reason-down', e)));
  list.replaceChildren(
    ...(open.length ? open.map(card) : [el('p', 'dash-empty', 'Nothing open: every request is available.')]),
  );
}

async function load() {
  try {
    const res = await fetch(URL_, { cache: 'no-store' });
    if (signInIfSignedOut(res)) return;
    const next = parseRequests(await res.json());
    if (!res.ok || !next) throw new Error(String(res.status));
    doc = next;
  } catch {
    const meta = q('[data-requests-meta]');
    if (meta) meta.textContent = 'stack-api did not answer; showing what it said last.';
    return;
  }
  render();
}

async function analyse(id: number) {
  if (busy !== null) return;
  busy = id;
  notes.delete(id);
  render();
  try {
    const res = await fetch(`${URL_}/${id}/analyse`, { method: 'POST' });
    if (signInIfSignedOut(res)) return;
    const body: unknown = await res.json().catch(() => null);
    const row = res.ok ? parseReport(body) : null;
    if (row && doc) doc = { ...doc, open: doc.open.map((r) => (r.id === id ? row : r)) };
    else {
      const error = (body as { error?: unknown } | null)?.error;
      notes.set(id, typeof error === 'string' ? error : `stack-api answered ${res.status}`);
    }
  } catch {
    notes.set(id, 'stack-api did not answer.');
  } finally {
    busy = null;
    render();
  }
}

render();
void load();
window.setInterval(() => {
  if (document.visibilityState === 'visible' && busy === null) void load();
}, POLL_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && busy === null) void load();
});
