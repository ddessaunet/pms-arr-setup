// The control page's browser side. The read-only parts (Running, Jobs, Drift)
// come from /live/status.json every 30 s, like the dashboard's; every action
// goes through a ControlApi, which today is the mock (control-mock.ts): it
// changes nothing on the server. Everything from the files and the API is
// set with textContent, never innerHTML.

import { BusyError, type ControlApi, type ControlEvent, type RunRecord } from './control-api.ts';
import { MockControlApi } from './control-mock.ts';
import { driftRows, jobRows, runningRows } from './control-view.ts';
import {
  ageSeconds,
  clock,
  formatAgo,
  isStale,
  levelText,
  parseStatus,
  type Level,
  type StatusDoc,
} from './status-view.ts';

const STATUS_URL = '/live/status.json';
const POLL_MS = 30_000;
const TICK_MS = 5_000;

const PLEX_WARNING =
  'Plex serves the real library: restarting it interrupts every stream.\n\n(This page is a mock: nothing is restarted.)';

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

const api: ControlApi = new MockControlApi({ storage: sessionStore() });

let doc: StatusDoc | null = null;
let dateHeader: string | null = null;
let fetchedAt = 0;
let unavailable = false;

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const qa = <T extends Element = HTMLElement>(sel: string) => Array.from(document.querySelectorAll<T>(sel));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function badge(level: Level, stale: boolean): HTMLSpanElement {
  const b = el('span', 'lvl', levelText(level, stale));
  b.dataset.level = stale ? 'stale' : level;
  return b;
}

const labels: Record<string, string> = (() => {
  try {
    return JSON.parse(q('[data-ctl-running]')?.dataset.labels ?? '{}');
  } catch {
    return {};
  }
})();

function announce(text: string) {
  const a = q('[data-ctl-announce]');
  if (a) a.textContent = text;
}

function staleNow(): boolean {
  return doc
    ? isStale(ageSeconds(doc.generatedAtEpoch, dateHeader, fetchedAt, Date.now()), doc.staleAfterSeconds)
    : false;
}

// ── actions ──────────────────────────────────────────────────────────────────

/** Every action button follows the API's one lock; the running one says what it is doing. */
function syncButtons() {
  const running = api.busy();
  for (const b of qa<HTMLButtonElement>('[data-ctl-action]')) {
    b.disabled = running !== null;
    const mine = running && b.dataset.kind === running.kind && b.dataset.target === running.target;
    if (b.dataset.idle === undefined) b.dataset.idle = b.textContent ?? '';
    b.textContent = mine ? (b.dataset.busyText ?? 'Running…') : b.dataset.idle;
    if (mine) b.setAttribute('aria-busy', 'true');
    else b.removeAttribute('aria-busy');
  }
}

async function run(
  start: () => AsyncIterable<ControlEvent>,
  what: string,
  last: string | null,
  onEvent?: (e: ControlEvent) => void,
  onStart?: () => void,
) {
  let events: AsyncIterable<ControlEvent>;
  try {
    events = start();
  } catch (err) {
    announce(err instanceof BusyError ? 'Another action is still running.' : `Could not start ${what}.`);
    return;
  }
  onStart?.();
  syncButtons();
  announce(`${what}: started`);
  let result = '';
  let ok = false;
  try {
    for await (const e of events) {
      onEvent?.(e);
      if (e.type === 'done') {
        result = e.summary;
        ok = e.ok;
      }
    }
  } catch {
    result = `${what}: lost contact with the server`;
  }
  syncButtons();
  announce(`${what}: ${result}`);
  if (last) {
    const p = q(`[data-ctl-last="${last}"]`);
    if (p) {
      p.textContent = `${ok ? 'Done' : 'Failed'}: ${result}`;
      p.dataset.ok = String(ok);
      p.hidden = false;
    }
  }
  renderDeployed();
  renderHistory();
}

function resetSteps() {
  for (const li of qa('[data-ctl-steps] li')) setStep(li, 'pending');
}
const STEP_WORDS: Record<string, string> = {
  pending: 'waiting',
  running: 'running',
  ok: 'done',
  failed: 'failed',
  skipped: 'skipped',
};
function setStep(li: HTMLElement, state: string) {
  li.dataset.state = state;
  const s = li.querySelector('.ctl-step-state');
  if (s) s.textContent = STEP_WORDS[state] ?? state;
  if (state === 'running') li.setAttribute('aria-current', 'step');
  else li.removeAttribute('aria-current');
}

function appendLine(pre: HTMLElement, t: string, msg: string) {
  const line = `${clock(t).padEnd(8)} ${msg}\n`;
  pre.textContent = (pre.dataset.fresh ? '' : pre.textContent) + line;
  delete pre.dataset.fresh;
  pre.scrollTop = pre.scrollHeight;
}

function deploy() {
  const pre = q('[data-ctl-log]');
  const result = q('[data-ctl-result]');
  const scenario = q<HTMLSelectElement>('[data-ctl-scenario]')?.value === 'fail-test' ? 'fail-test' : 'success';
  void run(
    () => api.deploy({ scenario }),
    'Deploy',
    null,
    (e) => {
      if (e.type === 'step') {
        const li = q(`[data-ctl-steps] li[data-step="${e.step}"]`);
        if (li) setStep(li, e.state);
      } else if (e.type === 'line' && pre) {
        appendLine(pre, e.t, e.msg);
      } else if (e.type === 'done' && result) {
        result.textContent = e.summary;
        result.dataset.ok = String(e.ok);
        result.hidden = false;
      }
    },
    () => {
      resetSteps();
      if (pre) pre.dataset.fresh = '1';
      if (result) result.hidden = true;
    },
  );
}

function restart(target: string, name: string) {
  if (target === 'plex' && !window.confirm(PLEX_WARNING)) return;
  void run(() => api.restart(target), `Restart ${name}`, 'running');
}

function runJob(id: string, name: string) {
  void run(() => api.runJob(id), `Run ${name}`, 'jobs');
}

function checkDrift() {
  const pre = q('[data-ctl-drift-log]');
  void run(
    () => api.checkDrift(),
    'Settings check',
    'drift',
    (e) => {
      if (e.type === 'line' && pre) appendLine(pre, e.t, e.msg);
    },
    () => {
      if (!pre) return;
      pre.dataset.fresh = '1';
      pre.hidden = false;
    },
  );
}

function actionButton(text: string, busyText: string, kind: string, target: string, label: string): HTMLButtonElement {
  const b = el('button', 'ctl-btn ctl-btn-small', text);
  b.type = 'button';
  b.dataset.ctlAction = '';
  b.dataset.kind = kind;
  b.dataset.target = target;
  b.dataset.busyText = busyText;
  b.dataset.key = `${kind}:${target}`;
  b.setAttribute('aria-label', label);
  return b;
}

// ── the live parts ───────────────────────────────────────────────────────────

/** Rebuilding a table loses focus; give it back to the same button. */
function keepFocus(rebuild: () => void) {
  const key = (document.activeElement as HTMLElement | null)?.dataset?.key;
  rebuild();
  if (key) q<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus();
}

function emptyRow(tbody: HTMLElement, cols: number, text: string) {
  const td = el('td', 'dash-empty', text);
  td.colSpan = cols;
  const tr = el('tr');
  tr.append(td);
  tbody.replaceChildren(tr);
}

function renderRunning(stale: boolean) {
  const tbody = q('[data-ctl-running] tbody');
  if (!tbody) return;
  if (!doc) {
    if (unavailable) emptyRow(tbody, 7, 'Unavailable: no data from the status job (/live/status.json).');
    return;
  }
  const rows = runningRows(doc, labels, Date.now());
  keepFocus(() =>
    tbody.replaceChildren(
      ...rows.map((r) => {
        const tr = el('tr');
        const name = el('th', 'ctl-name', r.name);
        name.scope = 'row';
        const kind = el('span', 'ctl-kind', r.kind === 'service' ? 'watcher' : 'container');
        name.append(kind);
        const b = actionButton('Restart', 'Restarting…', 'restart', r.target, `Restart ${r.name}`);
        b.addEventListener('click', () => restart(r.target, r.name));
        const action = el('td');
        action.append(b);
        const status = el('td');
        status.append(badge(r.level, stale));
        tr.append(
          name,
          status,
          el('td', '', r.state),
          el('td', 'ctl-num', r.uptime),
          el('td', 'ctl-num', r.restarts),
          el('td', 'ctl-num', r.version),
          action,
        );
        return tr;
      }),
    ),
  );
}

function renderJobs(stale: boolean) {
  const tbody = q('[data-ctl-jobs] tbody');
  if (!tbody) return;
  if (!doc) {
    if (unavailable) emptyRow(tbody, 6, 'Unavailable: no data from the status job (/live/status.json).');
    return;
  }
  const rows = jobRows(doc, Date.now());
  keepFocus(() =>
    tbody.replaceChildren(
      ...rows.map((r) => {
        const tr = el('tr');
        const name = el('th', 'ctl-name', r.name);
        name.scope = 'row';
        if (r.running) name.append(el('span', 'ctl-kind', 'running now'));
        const status = el('td');
        status.append(badge(r.level, stale));
        const b = actionButton('Run now', 'Running…', 'job', r.id, `Run ${r.name} now`);
        b.addEventListener('click', () => runJob(r.id, r.name));
        const action = el('td');
        action.append(b);
        tr.append(
          name,
          status,
          el('td', 'ctl-num', r.last),
          el('td', '', r.result),
          el('td', 'ctl-num', r.next),
          action,
        );
        return tr;
      }),
    ),
  );
}

function renderDrift(stale: boolean) {
  const list = q('[data-ctl-drift-list]');
  const age = q('[data-ctl-drift-age]');
  if (!list || !age) return;
  if (!doc) {
    if (unavailable) list.replaceChildren(el('li', 'dash-empty', 'Unavailable: no data from the status job.'));
    return;
  }
  const host = doc.host.find((h) => h.kind === 'drift');
  age.textContent = host ? `Hourly check: ${host.summary}.` : 'The hourly check has not run yet.';
  const rows = driftRows(doc, labels);
  list.replaceChildren(
    ...(rows.length
      ? rows.map((r) => {
          const li = el('li', 'dash-host-item');
          li.append(
            el('span', 'dash-host-label', r.name),
            badge(r.level, stale),
            el('span', 'dash-host-summary', r.lines.length ? r.lines.join('; ') : 'matches the repo'),
          );
          return li;
        })
      : [el('li', 'dash-empty', 'No app has been checked yet.')]),
  );
}

function render() {
  const ageEl = q('[data-ctl-age]');
  const stale = staleNow();
  if (ageEl) {
    if (doc) {
      const age = ageSeconds(doc.generatedAtEpoch, dateHeader, fetchedAt, Date.now());
      ageEl.textContent = stale
        ? `This is ${formatAgo(age)} old: the status job is not running.`
        : `Updated ${formatAgo(age)} ago.`;
    } else {
      ageEl.textContent = unavailable
        ? 'Status unavailable: no data from the status job (/live/status.json).'
        : 'Waiting for the status job…';
    }
  }
  renderRunning(stale);
  renderJobs(stale);
  renderDrift(stale);
  syncButtons();
}

/** Only the age line changes between polls: the tables stay put, and so does focus. */
function tick() {
  const ageEl = q('[data-ctl-age]');
  if (ageEl && doc) {
    const age = ageSeconds(doc.generatedAtEpoch, dateHeader, fetchedAt, Date.now());
    if (!isStale(age, doc.staleAfterSeconds)) ageEl.textContent = `Updated ${formatAgo(age)} ago.`;
    else render();
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

// ── deployed commit and history (the API's, not the status job's) ────────────

function renderDeployed() {
  const d = api.deployed();
  const sha = q('[data-ctl-deployed]');
  const subject = q('[data-ctl-deployed-subject]');
  const at = q('[data-ctl-deployed-at]');
  if (!sha || !subject || !at) return;
  sha.textContent = d ? d.commit.sha : 'nothing yet';
  subject.textContent = d ? d.commit.subject : '';
  at.textContent = d ? `${formatAgo(Math.max(0, Math.round((Date.now() - Date.parse(d.at)) / 1000)))} ago` : '';
}

const KIND_WORDS: Record<RunRecord['kind'], string> = {
  deploy: 'Deploy',
  restart: 'Restart',
  job: 'Run',
  drift: 'Check',
};

function renderHistory() {
  const ul = q('[data-ctl-history]');
  if (!ul) return;
  const runs = api.history();
  if (!runs.length) {
    ul.replaceChildren(el('li', 'dash-empty', 'Nothing has run from this page yet.'));
    return;
  }
  const open = new Set(qa<HTMLDetailsElement>('.ctl-run[open]').map((d) => d.dataset.id));
  ul.replaceChildren(
    ...runs.map((r) => {
      const li = el('li');
      const d = el('details', 'ctl-run');
      d.dataset.id = r.id;
      d.open = open.has(r.id);
      const sum = el('summary');
      const result = el('span', 'lvl', r.ok ? '● Done' : '✕ Failed');
      result.dataset.level = r.ok ? 'ok' : 'down';
      const when = new Date(r.startedAt);
      sum.append(
        result,
        el(
          'span',
          'ctl-run-what',
          `${KIND_WORDS[r.kind]} ${r.kind === 'deploy' ? (r.commit?.sha ?? r.target) : r.target}`,
        ),
        el('span', 'ctl-run-summary', r.summary),
        el(
          'span',
          'ctl-run-when',
          `${Number.isNaN(when.getTime()) ? '' : when.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · ${r.seconds} s`,
        ),
      );
      const pre = el('pre', 'ctl-log', r.log.join('\n') || '(no output)');
      pre.tabIndex = 0;
      d.append(sum, pre);
      li.append(d);
      return li;
    }),
  );
}

function start() {
  q('[data-ctl-deploy]')?.addEventListener('click', deploy);
  const drift = q('[data-ctl-drift]');
  if (drift) {
    drift.dataset.kind = 'drift';
    drift.dataset.target = 'all';
    drift.dataset.busyText = 'Checking…';
    drift.addEventListener('click', checkDrift);
  }
  const deployBtn = q('[data-ctl-deploy]');
  if (deployBtn) {
    deployBtn.dataset.kind = 'deploy';
    deployBtn.dataset.target = 'main';
    deployBtn.dataset.busyText = 'Deploying…';
  }
  renderDeployed();
  renderHistory();
  render();
  void poll();
  let timer = window.setInterval(poll, POLL_MS);
  window.setInterval(tick, TICK_MS);
  document.addEventListener('visibilitychange', () => {
    window.clearInterval(timer);
    if (!document.hidden) {
      void poll();
      timer = window.setInterval(poll, POLL_MS);
    }
  });
}

start();
