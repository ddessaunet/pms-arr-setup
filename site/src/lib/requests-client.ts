// The requests page's script (components/RequestsList.astro): every open Seerr
// request with jobs/stack-api's verdict, an Analyse button that runs a release
// search for one, and Ask AI, which has a model put the same facts into words.
// Both run only when clicked: a page load or a poll never searches or asks a
// model. An answer is written in the background (minutes, on this box's CPU),
// so the page polls for it, and finds it again after a reload. Data is only ever set as textContent, never as HTML: titles and
// release names come from the indexers, and the model's answer can repeat them.

import { el, q } from './dom.ts';
import { signInIfSignedOut } from './session.ts';
import { LEVELS, type Level } from './status-view.ts';
import {
  adviceLine,
  adviceParagraphs,
  byAttention,
  elapsed,
  modelLabel,
  parseAdviseState,
  parseReport,
  parseRequests,
  requestedLine,
  searchLine,
  titleOf,
  pickModel,
  whereLine,
  type AiInfo,
  type AiJob,
  type Advice,
  type RequestReport,
  type RequestsDoc,
} from './requests-view.ts';

const URL_ = '/api/requests';
const POLL_MS = 60_000;
const ADVISE_POLL_MS = 5_000; // while an answer is being written (minutes, on this box's CPU)
const MODEL_KEY = 'pms.requests.aiModel';

let doc: RequestsDoc | null = null;
/** The request whose release search is out (one at a time). */
let busy: number | null = null;
/** The AI answer being written (one at a time, stack-api's), and whether this page is watching it. */
let advising: AiJob | null = null;
let watching = false;
const notes = new Map<number, string>();
const aiNotes = new Map<number, string>();
let pickerFor = '';

// The picked model is a per-browser convenience: without storage, the default.
function storedModel(): string | null {
  try {
    return window.localStorage.getItem(MODEL_KEY);
  } catch {
    return null;
  }
}
function storeModel(id: string) {
  try {
    window.localStorage.setItem(MODEL_KEY, id);
  } catch {
    // the choice lasts until the page reloads
  }
}
let chosen = storedModel();

/** AI is off only when stack-api says so; one without the route says nothing (and a click says why). */
const aiOn = () => doc !== null && doc.ai !== null;
const aiModel = () => (doc?.ai ? pickModel(doc.ai, chosen) : null);

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
  if (r.advice) c.append(advicePanel(r.advice));
  const foot = el('div', 'req-foot');
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
    foot.append(row);
  }
  if (aiOn()) {
    const row = el('p', 'req-actions');
    const b = el('button', 'ctl-btn ctl-btn-small req-ai-btn');
    // The sparkle stands for "AI" on screen; a screen reader still hears "Ask AI".
    if (advising?.id === r.id) b.append(sparkle(), `Asking… ${elapsed(advising.startedAt, Date.now())}`);
    else b.append(sparkle(), 'Ask', el('span', 'sr-only', ' AI'), r.advice ? ' again' : '');
    b.type = 'button';
    // One answer at a time; and not while this card's search runs, so the answer sees it.
    b.disabled = advising !== null || busy === r.id;
    if (advising?.id === r.id) b.setAttribute('aria-busy', 'true');
    b.addEventListener('click', () => void advise(r.id));
    const m = aiModel();
    row.append(
      b,
      el(
        'span',
        'ctl-meta',
        aiNotes.get(r.id) ??
          (advising?.id === r.id
            ? `${advising.model} is writing; it can take a few minutes, and the page can be left.`
            : `Asks ${m ? m.model : 'the model'} about the facts above; on this box's CPU, a few minutes.`),
      ),
    );
    foot.append(row);
  }
  if (foot.childElementCount) c.append(foot);
  return c;
}

/** The AI mark (pacman.css draws it), for sighted readers only. */
function sparkle(): HTMLElement {
  const s = el('span', 'req-ai-icon');
  s.setAttribute('aria-hidden', 'true');
  return s;
}

function advicePanel(a: Advice): HTMLElement {
  const s = el('section', 'req-advice');
  s.setAttribute('aria-label', 'AI advice');
  const head = el('p', 'ctl-label');
  head.append(sparkle(), adviceLine(a, Date.now()));
  s.append(head);
  for (const p of adviceParagraphs(a.text)) s.append(el('p', '', p));
  s.append(el('p', 'req-advice-note', 'Written by a model from the facts above; check before acting.'));
  return s;
}

/** The model picker: a select with two or more, a line with one, nothing when AI is off. */
function renderPicker(ai: AiInfo | null | undefined) {
  const box = q('[data-requests-ai]');
  if (!box) return;
  const key = ai ? JSON.stringify(ai) : String(ai);
  if (key === pickerFor) return; // rebuilding it would drop an open select
  pickerFor = key;
  const m = ai ? pickModel(ai, chosen) : null;
  if (!ai || !m) {
    box.replaceChildren();
    box.hidden = true;
    return;
  }
  box.hidden = false;
  if (ai.models.length === 1) {
    box.replaceChildren(el('span', 'ctl-meta', `AI model: ${modelLabel(m, ai.models)}`));
    return;
  }
  const label = el('label', 'ctl-field', 'AI model');
  const sel = el('select');
  for (const x of ai.models) {
    const o = el('option', '', modelLabel(x, ai.models));
    o.value = x.id;
    o.selected = x.id === m.id;
    sel.append(o);
  }
  sel.addEventListener('change', () => {
    chosen = sel.value;
    storeModel(chosen);
    render();
  });
  label.append(sel);
  box.replaceChildren(label);
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
  renderPicker(doc.ai);
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
    // An answer started elsewhere (another tab, before a reload) shows here too.
    if (next.advising && !watching) {
      advising = next.advising;
      void watch(next.advising.id);
    }
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

async function advise(id: number) {
  if (advising !== null) return;
  aiNotes.delete(id);
  try {
    const m = aiModel();
    const res = await fetch(`${URL_}/${id}/advise`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(m ? { model: m.id } : {}),
    });
    if (signInIfSignedOut(res)) return;
    const body: unknown = await res.json().catch(() => null);
    const state = res.status === 202 ? parseAdviseState(body) : null;
    if (state?.state === 'running') {
      advising = state.job;
      void watch(id);
    } else {
      const error = (body as { error?: unknown } | null)?.error;
      // stack-api's catch-all 404: this one has no advice route.
      if (res.status === 404 && error === 'not found')
        aiNotes.set(id, 'AI advice is not set up on this stack-api yet.');
      else aiNotes.set(id, typeof error === 'string' ? error : `stack-api answered ${res.status}`);
    }
  } catch {
    aiNotes.set(id, 'stack-api did not answer.');
  }
  render();
}

/** Ask stack-api how the answer stands until it is in, failed, or gone. */
async function watch(id: number) {
  if (watching) return;
  watching = true;
  try {
    while (advising?.id === id) {
      render();
      await new Promise((done) => window.setTimeout(done, ADVISE_POLL_MS));
      let state;
      try {
        const res = await fetch(`${URL_}/${id}/advise`, { cache: 'no-store' });
        if (signInIfSignedOut(res)) return;
        state = res.ok ? parseAdviseState(await res.json()) : null;
      } catch {
        state = null;
      }
      if (!state) {
        aiNotes.set(id, 'stack-api did not answer; still waiting.');
        continue;
      }
      aiNotes.delete(id);
      if (state.state === 'running') advising = state.job;
      else {
        advising = null;
        if (state.state === 'done' && doc) {
          const advice = state.advice;
          doc = { ...doc, open: doc.open.map((r) => (r.id === id ? { ...r, advice } : r)) };
        } else if (state.state === 'failed') aiNotes.set(id, state.error);
        else aiNotes.set(id, 'Its facts changed while it was written; ask again.');
      }
    }
  } finally {
    watching = false;
    render();
  }
}

// The list keeps loading while an answer is written (that takes minutes); not while a search runs.
const idle = () => busy === null;

render();
void load();
window.setInterval(() => {
  if (document.visibilityState === 'visible' && idle()) void load();
}, POLL_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && idle()) void load();
});
