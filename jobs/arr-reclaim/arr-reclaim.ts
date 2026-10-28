// jobs/arr-reclaim/arr-reclaim.ts — when media Radarr or Sonarr imported is deleted (in Plex,
// or in Radarr/Sonarr with its files), remove its torrent (with its data) from the :8081 qBittorrent, so the space
// comes back right away instead of after the seeding limit. And tell Radarr/Sonarr: a movie
// whose file was deleted is removed from Radarr, an episode's series is rescanned in Sonarr.
//
//   jobs/arr-reclaim/arr-reclaim.sh watch      watch the library, reclaim after each burst
//                                              of deletions, record imports while idle
//                                              (run by arr-reclaim.service)
//   jobs/arr-reclaim/arr-reclaim.sh watch --dry-run
//                                              the same, but only says what it would do:
//                                              no removal, no word to Radarr/Sonarr, no
//                                              ledger written, no lock taken
//   jobs/arr-reclaim/arr-reclaim.sh run        reclaim once, now
//   jobs/arr-reclaim/arr-reclaim.sh --audit    report what `run` would do; changes nothing
//
// Ported from pms-local's plex-watch.sh / plex-reconcile.sh, which did this for
// the native qBittorrent until Phase 7a retired both (pms-local itself is left
// exactly as it is). What differs is how a
// torrent is known to be ours and deleted, because here Radarr and Sonarr
// record it:
//
//   imported   the torrent's hash is, or was, in Radarr's or Sonarr's import
//              history (eventType 3, downloadFolderImported). Proof, not
//              inference — so there is no untagged gap, and a download that
//              finished but is not imported yet is never touched.
//   deleted    every library path those imports wrote is gone, AND every media
//              file of the torrent is down to one link. The second half is
//              what keeps a file that was moved or renamed (still linked
//              somewhere) from reading as deleted.
//
// "Or was": deleting a movie in Radarr (a series in Sonarr) deletes its
// history too, before any run can read it. So the imports seen are kept in a
// ledger ($APPDATA/.arr-reclaim.imports), recorded every RECLAIM_RECORD_EVERY
// seconds and on every run. A row the app has forgotten is dropped once
// qBittorrent no longer has its torrent either. A delete within that interval of the import is not in it, and is
// kept like any not-imported torrent.
//
// Some but not all of a torrent's imports gone (one episode of a season pack)
// is `partial`: reported, kept — the same call plex-reconcile makes.
//
// Radarr and Sonarr only notice a file deleted outside them on their daily
// rescan, and until then a deleted movie still wanting an upgrade can be grabbed
// again. So after a burst, `watch` tells them (see forget): a movie whose file
// was deleted is removed from Radarr (nothing on disk is touched), and the
// series of a deleted episode is rescanned, which unmonitors the episode
// (Unmonitor Deleted Episodes) and keeps the series. Only deletions count; a
// file moved or renamed is still in the library.
//
// Exit: 0 fine (including nothing to do) · 2 usage · 3 preflight/config ·
// 4 a login or API key was refused · 5 qBittorrent or an app is unreachable.

import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { headerHelp, parseCli } from '../../stack/lib/cli.ts';
import { envGet, envSeconds, type Env } from '../../stack/lib/env.ts';
import { runMain, UsageError } from '../../stack/lib/exit.ts';
import { httpCode, is2xx, jsonOf, makeHttp, type Http } from '../../stack/lib/http.ts';
import { waitLock, tryLock, type Lock } from '../../stack/lib/lock.ts';
import { err, out, stamped, type Log } from '../../stack/lib/log.ts';
import { qbtLogin, type QbtSession } from '../../stack/lib/qbittorrent.ts';
import { lines, TIMEOUT, type LineSource, type Lines } from '../../stack/lib/run.ts';

// Must agree with plex-watch's list: only a media file going away is worth a run.
export const MEDIA_EXTS = ['mkv', 'mp4', 'avi', 'mov', 'wmv', 'm4v', 'ts', 'flac', 'mp3', 'm4a', 'ogg', 'opus'];
const MEDIA = new RegExp(`\\.(${MEDIA_EXTS.join('|')})$`);

// The category each app's download client uses, and where its settings come from.
export const APPS = [
  { name: 'radarr', category: 'radarr', urlVar: 'RADARR_URL', keyVar: 'RADARR_API_KEY', url: 'http://127.0.0.1:7878' },
  { name: 'sonarr', category: 'sonarr', urlVar: 'SONARR_URL', keyVar: 'SONARR_API_KEY', url: 'http://127.0.0.1:8989' },
] as const;

// ─── pure helpers (jobs/arr-reclaim/arr-reclaim.test.ts) ──────────────────────

export const isMedia = (path: string): boolean => MEDIA.test(path.toLowerCase());

export type Decision = 'not-imported' | 'in-library' | 'partial' | 'moved' | 'deleted' | 'upgraded';

/**
 * What to do with one torrent.
 *   not-imported  keep: not in any import history — not ours to judge
 *   in-library    keep: every imported file is still there
 *   partial       keep: some imports gone, some not (report)
 *   moved         keep: imports gone from where they were written, but the data
 *                 is still linked somewhere — a rename or a move, not a delete
 *   deleted       REMOVE: imports gone and nothing links to the data any more
 *   upgraded      REMOVE: every path it imported has since been imported again
 *                 by ANOTHER download (an upgrade lands on the same path) and
 *                 nothing links to its data any more. Checked before in-library,
 *                 which the unchanged path would otherwise report.
 */
export function decide(imp: number, present: number, media: number, single: number, superseded = false): Decision {
  if (imp === 0) return 'not-imported';
  if (superseded && media > 0 && single === media) return 'upgraded';
  if (present === imp) return 'in-library';
  if (present > 0) return 'partial';
  if (media > 0 && single === media) return 'deleted';
  return 'moved';
}

/** One import: a file the app wrote into the library from a download. */
export interface Import {
  /** ISO date, or "0" when the record has none. */
  date: string;
  /** The torrent's hash, lowercased (the apps store qBittorrent's uppercase). */
  hash: string;
  path: string;
}

/**
 * A history page's imports, and how many records it had (250 means another
 * page). A record without a downloadId (a manual import) is nobody's torrent.
 * Undefined when it is not a history page at all.
 */
export function historyImports(page: unknown): { imports: Import[]; records: number } | undefined {
  const records = (page as { records?: unknown } | null)?.records;
  if (!Array.isArray(records)) return undefined;
  const imports: Import[] = [];
  for (const r of records as { date?: unknown; downloadId?: unknown; data?: { importedPath?: unknown } | null }[]) {
    const id = r?.downloadId;
    const path = r?.data?.importedPath;
    if (id === null || id === undefined || path === null || path === undefined) continue;
    imports.push({
      date: r.date === null || r.date === undefined || r.date === false ? '0' : String(r.date),
      hash: String(id).replace(/[A-Z]/g, (c) => c.toLowerCase()), // jq's ascii_downcase
      path: String(path),
    });
  }
  return { imports, records: records.length };
}

// The ledger and the merge keep jq's @tsv escaping, so a ledger the bash script
// wrote reads back and writes out byte for byte.
const TSV_ESC: Record<string, string> = { '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' };
const TSV_UNESC: Record<string, string> = { '\\\\': '\\', '\\t': '\t', '\\n': '\n', '\\r': '\r' };
export const tsvField = (s: string): string => s.replace(/[\\\t\n\r]/g, (c) => TSV_ESC[c] ?? c);
export const untsvField = (s: string): string => s.replace(/\\[\\tnr]/g, (c) => TSV_UNESC[c] ?? c);

/** "date<TAB>hash<TAB>path", as the bash script's lines. */
export const importLine = (i: Import): string => `${tsvField(i.date)}\t${tsvField(i.hash)}\t${tsvField(i.path)}`;

/** C-locale order: byte order of the UTF-8, as LC_ALL=C sort. */
export const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/**
 * Imports deduplicated, newest first: the lines reverse-sorted in byte order, as
 * `LC_ALL=C sort -ru`. The ISO date leads, so the first import of a path is the
 * download it holds now.
 */
export function mergeImports(imports: readonly Import[]): Import[] {
  const byLine = new Map<string, Import>();
  for (const i of imports) byLine.set(importLine(i), i);
  return [...byLine.keys()].sort((a, b) => byteOrder(b, a)).map((l) => byLine.get(l)!);
}

/** One app's imports in the ledger text ("app<TAB>date<TAB>hash<TAB>path" lines), in its order. */
export function ledgerRows(ledger: string, app: string): Import[] {
  const rows: Import[] = [];
  for (const line of ledger.split('\n')) {
    const f = line.split('\t');
    if (f[0] !== app) continue;
    rows.push({ date: untsvField(f[1] ?? ''), hash: untsvField(f[2] ?? ''), path: untsvField(f[3] ?? '') });
  }
  return rows;
}

export const ledgerLine = (app: string, i: Import): string => `${app}\t${importLine(i)}`;

/** The movie whose file is at path, as its id and "Title (Year)"; undefined when none. */
export function movieWithFile(movies: readonly unknown[], path: string): { id: number; title: string } | undefined {
  const m = (movies as { id: number; title: string; year: number; movieFile?: { path?: string } | null }[]).find(
    (x) => x?.movieFile?.path === path,
  );
  return m && { id: m.id, title: `${m.title} (${m.year})` };
}

/** The series whose folder holds path, as its id and title; undefined when none. */
export function seriesHolding(series: readonly unknown[], path: string): { id: number; title: string } | undefined {
  const s = (series as { id: number; title: string; path?: string }[]).find(
    (x) => typeof x?.path === 'string' && path.startsWith(`${x.path}/`),
  );
  return s && { id: s.id, title: s.title };
}

/** An inotifywait line, "EVENT<TAB>path", read as bash's `IFS=$'\t' read -r ev path`. */
export function parseEvent(line: string): { ev: string; path: string } {
  const trimmed = line.replace(/^\t+|\t+$/g, '');
  const i = trimmed.indexOf('\t');
  if (i < 0) return { ev: trimmed, path: '' };
  return { ev: trimmed.slice(0, i), path: trimmed.slice(i).replace(/^\t+/, '') };
}

// ─── the run's settings and seams ─────────────────────────────────────────────

export interface Deps {
  http: Http;
  /** Stamped lines: "[%F %T] reclaim: …". */
  log: Log;
  /** Unstamped: the help text. */
  stdout: Log;
  /** Preflight and usage, as the bash script printed them. */
  stderr: Log;
  sleep: (ms: number) => Promise<void>;
  /** Starts inotifywait. */
  lines: Lines;
  /** The command's path, or null when it is not installed. */
  which: (cmd: string) => string | null;
  env: Env;
  /** The tree whose .env is read: the install, from the unit. */
  repo: string;
}

interface App {
  name: string;
  category: string;
  url: string;
  key: string;
  keyVar: string;
}

interface Config {
  library: string;
  qbt: { url: string; user: string; pass: string };
  apps: App[];
  timeoutMs: number;
  /** As written in the environment, for log lines ("debounce 60s"). */
  debounce: string;
  debounceMs: number;
  cooldown: string;
  cooldownMs: number;
  maxRemovals: number;
  maxForgets: number;
  lock: string;
  lockWaitMs: number;
  ledger: string;
  recordEvery: string;
  recordEveryMs: number;
  inotifywait: string;
}

function config(deps: Deps): Config {
  const { env, repo } = deps;
  const get = (key: string) => envGet(key, { repo, env });
  const appdata = get('APPDATA') || '/opt/appdata';
  const raw = (key: string, fallback: string) => env[key] || fallback;
  const count = (key: string, fallback: number) => {
    const v = raw(key, String(fallback));
    if (!/^\d+$/.test(v)) throw new Error(`${key} is not a whole number: ${v}`);
    return Number(v);
  };
  return {
    library: raw('LIBRARY', '/mnt/data/streaming'),
    qbt: { url: raw('QBT_ARR_URL', 'http://127.0.0.1:8081'), user: get('QBT_ARR_USER'), pass: get('QBT_ARR_PASS') },
    apps: APPS.map((a) => ({
      name: a.name,
      category: a.category,
      url: raw(a.urlVar, a.url),
      key: get(a.keyVar),
      keyVar: a.keyVar,
    })),
    timeoutMs: envSeconds(env, 'RECLAIM_TIMEOUT', 20),
    // Same defaults and reasons as plex-watch / plex-reconcile.
    debounce: raw('RECLAIM_DEBOUNCE', '60'), // a deleted season is one event per episode
    debounceMs: envSeconds(env, 'RECLAIM_DEBOUNCE', 60),
    cooldown: raw('RECLAIM_FAIL_COOLDOWN', '300'),
    cooldownMs: envSeconds(env, 'RECLAIM_FAIL_COOLDOWN', 300),
    maxRemovals: count('RECLAIM_MAX_REMOVALS', 3), // a bug costs a puzzled look, not the seedbox
    maxForgets: count('RECLAIM_MAX_FORGETS', 10), // movies removed from Radarr per run; data is never touched
    lock: raw('RECLAIM_LOCK', `${appdata}/.arr-reclaim.lock`),
    lockWaitMs: envSeconds(env, 'RECLAIM_LOCK_WAIT', 60), // test seam, env-only
    ledger: raw('RECLAIM_LEDGER', `${appdata}/.arr-reclaim.imports`),
    recordEvery: raw('RECLAIM_RECORD_EVERY', '60'), // the window a delete in Radarr/Sonarr can slip through
    recordEveryMs: envSeconds(env, 'RECLAIM_RECORD_EVERY', 60),
    inotifywait: raw('INOTIFYWAIT', 'inotifywait'), // test seam, env-only
  };
}

// ─── the ledger ───────────────────────────────────────────────────────────────
// "app<TAB>date<TAB>hash<TAB>path" lines: the import history as last seen,
// which outlives a movie or series deleted in its app.

export interface Ledger {
  read(): string;
  /** Replaces it with these lines; false (and a WARN) when it cannot. */
  write(lines: readonly string[]): boolean;
}

/** The ledger file. A write goes beside it and is renamed in; untouched when nothing changed. */
export function fileLedger(path: string, log: Log): Ledger {
  return {
    read() {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return '';
      }
    },
    write(rows) {
      const text = rows
        .filter((l) => l !== '')
        .map((l) => `${l}\n`)
        .join('');
      try {
        if (readFileSync(path, 'utf8') === text) return true;
      } catch {
        // none yet: write it
      }
      // 0600, as mktemp made it.
      const tmp = `${path}.${Math.random().toString(36).slice(2, 8)}`;
      try {
        writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
        renameSync(tmp, path);
        return true;
      } catch {
        try {
          unlinkSync(tmp);
        } catch {
          // never created
        }
        log(`WARN: cannot write ${path}`);
        return false;
      }
    },
  };
}

/** A dry run's ledger: starts as the file, and is written to memory only. */
export function memoryLedger(initial: string): Ledger {
  let text = initial;
  return {
    read: () => text,
    write(rows) {
      text = rows
        .filter((l) => l !== '')
        .map((l) => `${l}\n`)
        .join('');
      return true;
    },
  };
}

// ─── a run ────────────────────────────────────────────────────────────────────

interface Ctx {
  deps: Deps;
  cfg: Config;
  log: Log;
  ledger: Ledger;
  /** watch --dry-run: say, never do. */
  dry: boolean;
}

/** All pages of an app's import history; undefined when it cannot be read. */
async function appImports(ctx: Ctx, app: App): Promise<Import[] | undefined> {
  // The name "downloadFolderImported" is refused (400); only the number is accepted.
  const all: Import[] = [];
  for (let page = 1; ; page++) {
    const r = await ctx.deps.http(
      `${app.url}/api/v3/history?eventType=3&page=${page}&pageSize=250&sortKey=date&sortDirection=descending`,
      { headers: { 'X-Api-Key': app.key }, timeoutMs: ctx.cfg.timeoutMs },
    );
    const got = is2xx(r.status) ? historyImports(jsonOf(r)) : undefined;
    if (!got) return undefined;
    all.push(...got.imports);
    if (got.records !== 250) return all;
  }
}

/** A Radarr/Sonarr call: the parsed answer, or undefined when it failed. */
async function arrApi(ctx: Ctx, method: string, app: App, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'X-Api-Key': app.key };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await ctx.deps.http(`${app.url}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs: ctx.cfg.timeoutMs,
  });
  return is2xx(r.status) ? { json: jsonOf(r) } : undefined;
}

/**
 * Adds each app's live import history to the ledger. No qBittorrent, no
 * decisions: this is what runs every RECLAIM_RECORD_EVERY seconds. Quiet when
 * an app is away; the next reclaim run says so.
 */
export async function record(ctx: Ctx): Promise<number> {
  let rc = 0;
  const ledger = ctx.ledger.read();
  const rows: string[] = [];
  for (const app of ctx.cfg.apps) {
    const old = ledgerRows(ledger, app.name);
    let now = old;
    if (app.key) {
      const live = await appImports(ctx, app);
      if (live) {
        now = mergeImports([...live, ...old]);
        const added = now.length - old.length;
        if (added > 0) ctx.log(`Recorded ${added} import(s) of ${app.name}.`);
      } else {
        rc = 5;
      }
    }
    rows.push(...now.map((i) => ledgerLine(app.name, i)));
  }
  if (!ctx.ledger.write(rows)) rc = 3;
  return rc;
}

/** Hard links to a path, as stat -c %h (the link itself, not what it points to); 0 when unreadable. */
function linksOf(path: string): number {
  try {
    return lstatSync(path).nlink;
  } catch {
    return 0;
  }
}

/** One reclaim: decide every finished torrent of each app's category. */
export async function reclaim(ctx: Ctx, mode: 'run' | 'audit'): Promise<number> {
  const { cfg, log } = ctx;
  const login = await qbtLogin(ctx.deps.http, { ...cfg.qbt, timeoutMs: cfg.timeoutMs });
  if (login.kind === 'unreachable') {
    log(`ERROR: cannot reach qBittorrent at ${cfg.qbt.url}`);
    return 5;
  }
  if (login.kind === 'refused') {
    log(`ERROR: qBittorrent refused the login for '${cfg.qbt.user}' (HTTP ${httpCode(login.status)})`);
    return 4;
  }
  const qbt: QbtSession = login.session;
  const getJson = async (path: string) => {
    const r = await qbt.get(path);
    return is2xx(r.status) ? jsonOf(r) : undefined;
  };

  let rc = 0;
  let removed = 0;
  const ledger = ctx.ledger.read();
  const kept: string[] = [];
  // Across both apps, as the bash script's arrays were.
  const importsOf = new Map<string, string[]>();
  const latest = new Map<string, string>();
  const count = new Map<string, number>();
  const bump = (k: string) => count.set(k, (count.get(k) ?? 0) + 1);

  for (const app of cfg.apps) {
    // An app skipped this run keeps its ledger rows as they are.
    if (!app.key) {
      log(`${app.name}: no ${app.keyVar} — its torrents are left alone`);
      kept.push(...ledgerRows(ledger, app.name).map((i) => ledgerLine(app.name, i)));
      continue;
    }
    const live = await appImports(ctx, app);
    if (!live) {
      // Never guess ownership: without the history, keep everything of this app.
      log(`WARN: cannot read ${app.name}'s import history at ${app.url} — its torrents are left alone this run`);
      kept.push(...ledgerRows(ledger, app.name).map((i) => ledgerLine(app.name, i)));
      rc = 5;
      continue;
    }
    const liveHashes = new Set(live.map((i) => i.hash));
    // The live history plus what the ledger remembers of history since deleted.
    const imports = mergeImports([...live, ...ledgerRows(ledger, app.name)]);
    // Newest first, so the first hash seen for a path is the download that
    // path holds now; any other hash for it was superseded.
    for (const i of imports) {
      importsOf.set(i.hash, [...(importsOf.get(i.hash) ?? []), i.path]);
      if (!latest.has(i.path)) latest.set(i.path, i.hash);
    }

    const torrents = await getJson(`/api/v2/torrents/info?category=${app.category}`);
    if (!Array.isArray(torrents)) {
      log(`ERROR: cannot list ${app.category} torrents`);
      return 5;
    }
    const held = new Set<string>();
    for (const t of torrents as { hash?: string; name?: string; save_path?: string; progress?: number }[]) {
      const hash = t?.hash ?? '';
      if (hash === '') continue;
      const name = t.name ?? '';
      held.add(hash);
      if (!((t.progress ?? 0) >= 1)) {
        bump('incomplete');
        continue;
      }

      const paths = importsOf.get(hash) ?? [];
      const imp = paths.length;
      const present = paths.filter((p) => existsSync(p)).length;
      const superseded = imp > 0 && !paths.some((p) => latest.get(p) === hash);

      const files = await getJson(`/api/v2/torrents/files?hash=${hash}`);
      if (!Array.isArray(files)) {
        log(`WARN: cannot list the files of '${name}' — left alone`);
        continue;
      }
      let media = 0;
      let single = 0;
      const save = (t.save_path ?? '').replace(/\/$/, '');
      for (const f of files as { name?: string; priority?: number }[]) {
        if (f?.priority === 0 || typeof f?.name !== 'string' || !isMedia(f.name)) continue;
        const abs = `${save}/${f.name}`;
        if (!existsSync(abs)) continue;
        media++;
        if (linksOf(abs) === 1) single++;
      }

      const decision = decide(imp, present, media, single, superseded);
      bump(decision);
      if (decision === 'deleted' || decision === 'upgraded') {
        const why = decision === 'upgraded' ? 'an upgrade replaced it in the library' : 'its library files are gone';
        if (mode === 'audit') {
          log(`would remove '${name}' (${app.name}) — ${why}`);
        } else if (removed >= cfg.maxRemovals) {
          log(`WARN: RECLAIM_MAX_REMOVALS=${cfg.maxRemovals} reached — '${name}' left for the next run`);
        } else if (is2xx((await qbt.post('/api/v2/torrents/delete', { hashes: hash, deleteFiles: 'true' })).status)) {
          removed++;
          held.delete(hash);
          log(`Removed '${name}' (${app.name}) with its data — ${why}.`);
          // An upgrade's folder still holds the new file; rmdir leaves it.
          if (decision === 'deleted') pruneDirs(ctx, paths);
        } else {
          log(`ERROR: qBittorrent refused to remove '${name}'`);
          rc = 5;
        }
      } else if (decision === 'partial') {
        log(`partial: '${name}' (${app.name}) — ${present} of ${imp} imported file(s) still in the library; kept`);
      } else if (decision === 'moved') {
        log(`moved: '${name}' (${app.name}) — imports gone but its data is still linked elsewhere; kept`);
      }
    }

    // Keep what the app still has, and what it forgot of a torrent
    // qBittorrent still holds; the rest can never be decided again.
    for (const i of imports) if (liveHashes.has(i.hash) || held.has(i.hash)) kept.push(ledgerLine(app.name, i));
  }
  if (mode === 'run' && !ctx.ledger.write(kept)) rc = 3;

  const summary = ['deleted', 'upgraded', 'partial', 'moved', 'in-library', 'not-imported', 'incomplete']
    .filter((k) => count.has(k))
    .map((k) => ` ${k}=${count.get(k)}`)
    .join('');
  log(`Done (${mode}):${summary || ' nothing to look at'}; removed ${removed}.`);
  return rc;
}

/**
 * The folders a deleted import left behind, if they are now empty and inside
 * the library (below its top level). rmdir never removes anything with content.
 */
function pruneDirs(ctx: Ctx, paths: readonly string[]): void {
  const lib = `${ctx.cfg.library}/`;
  for (const p of paths) {
    for (let d = dirname(p); d.startsWith(lib) && d.slice(lib.length).includes('/'); d = dirname(d)) {
      try {
        rmdirSync(d);
      } catch {
        break;
      }
      ctx.log(`Pruned empty directory: ${d}`);
    }
  }
}

// ─── telling Radarr and Sonarr ────────────────────────────────────────────────

/**
 * Run after a burst of deletions, with the media files deleted (not moved). A
 * path still gone a debounce later is gone for good: an upgrade has put its new
 * file in place by then, and Radarr's record of the movie points to it. Radarr's
 * own deletes don't match either: by now the movie or its file record is gone.
 */
export async function forget(ctx: Ctx, deleted: readonly string[]): Promise<number> {
  const { cfg, log } = ctx;
  const [radarr, sonarr] = cfg.apps as [App, App];
  let rc = 0;
  let movies: unknown[] = [];
  let series: unknown[] = [];
  if (radarr.key) {
    const r = await arrApi(ctx, 'GET', radarr, '/api/v3/movie');
    if (r && Array.isArray(r.json)) movies = r.json;
    else {
      log("WARN: cannot list radarr's movies — it finds the deletions on its daily rescan");
      rc = 5;
    }
  }
  if (sonarr.key) {
    const r = await arrApi(ctx, 'GET', sonarr, '/api/v3/series');
    if (r && Array.isArray(r.json)) series = r.json;
    else {
      log("WARN: cannot list sonarr's series — it finds the deletions on its daily rescan");
      rc = 5;
    }
  }

  let n = 0;
  const forgot = new Set<number>();
  const rescan = new Map<number, string>();
  for (const p of deleted) {
    if (!p.startsWith(`${cfg.library}/`) || existsSync(p)) continue;
    const movie = movieWithFile(movies, p);
    if (movie) {
      if (forgot.has(movie.id)) continue;
      forgot.add(movie.id);
      if (n >= cfg.maxForgets) {
        log(
          `WARN: RECLAIM_MAX_FORGETS=${cfg.maxForgets} reached — '${movie.title}' stays in radarr; its daily rescan unmonitors it`,
        );
      } else if (ctx.dry) {
        n++;
        log(`would remove '${movie.title}' from radarr — its file was deleted from the library`);
      } else if (
        await arrApi(ctx, 'DELETE', radarr, `/api/v3/movie/${movie.id}?deleteFiles=false&addImportExclusion=false`)
      ) {
        n++;
        log(`Removed '${movie.title}' from radarr — its file was deleted from the library.`);
      } else {
        log(`ERROR: radarr refused to remove '${movie.title}'`);
        rc = 5;
      }
      continue;
    }
    const show = seriesHolding(series, p);
    if (show) rescan.set(show.id, show.title);
  }
  for (const [id, title] of rescan) {
    if (ctx.dry) log(`would ask sonarr to rescan '${title}'`);
    else if (await arrApi(ctx, 'POST', sonarr, '/api/v3/command', { name: 'RescanSeries', seriesId: id })) {
      log(`Asked sonarr to rescan '${title}' — it unmonitors the deleted episode(s).`);
    } else {
      log(`ERROR: sonarr refused to rescan '${title}'`);
      rc = 5;
    }
  }
  return rc;
}

// ─── watching ─────────────────────────────────────────────────────────────────

/** A reclaim run, then (with deleted paths) Radarr and Sonarr told. A dry run takes no lock. */
export async function reclaimLocked(ctx: Ctx, deleted: readonly string[] = []): Promise<number> {
  const { cfg, log } = ctx;
  let lock: Lock | null = null;
  if (!ctx.dry) {
    try {
      lock = await waitLock(cfg.lock, cfg.lockWaitMs);
    } catch {
      log(`ERROR: cannot open ${cfg.lock}`);
      return 3;
    }
    if (!lock) {
      log(`Another reclaim holds ${cfg.lock} — skipping.`);
      return 0;
    }
  }
  try {
    let rc = await reclaim(ctx, ctx.dry ? 'audit' : 'run');
    // Removing a movie wipes its history: into the ledger first, or not at all.
    if (deleted.length > 0) {
      if ((await record(ctx)) === 0) {
        const f = await forget(ctx, deleted);
        if (f !== 0) rc = f;
      } else {
        log('WARN: could not record the import history — radarr and sonarr are told nothing this run');
        rc = 5;
      }
    }
    return rc;
  } finally {
    lock?.release();
  }
}

/** Never waits: a reclaim holding the lock records as it runs. */
export async function recordLocked(ctx: Ctx): Promise<number> {
  let lock: Lock | null = null;
  if (!ctx.dry) {
    try {
      lock = tryLock(ctx.cfg.lock);
    } catch {
      ctx.log(`ERROR: cannot open ${ctx.cfg.lock}`);
      return 3;
    }
    if (!lock) return 0;
  }
  try {
    return await record(ctx);
  } finally {
    lock?.release();
  }
}

export interface WatchHooks {
  log: Log;
  sleep: (ms: number) => Promise<void>;
  debounceMs: number;
  debounce: string;
  cooldownMs: number;
  cooldown: string;
  recordEveryMs: number;
  /** A reclaim after a burst, with the media files deleted in it; its exit code. */
  reclaim: (deleted: string[]) => Promise<number>;
  record: () => Promise<number>;
}

/**
 * As plex-watch: one run per burst, after RECLAIM_DEBOUNCE seconds of quiet;
 * after a failure, wait RECLAIM_FAIL_COOLDOWN before reading on (what comes in
 * meanwhile waits in the pipe). Every RECLAIM_RECORD_EVERY seconds without an
 * event, record the imports. Reads "EVENT<TAB>path" lines; the deleted ones
 * (not the moved) go to forget. Returns when inotifywait ends.
 */
export async function watchLoop(src: LineSource, h: WatchHooks): Promise<void> {
  for (;;) {
    const first = await src.next(h.recordEveryMs);
    if (first === TIMEOUT) {
      await h.record().catch(() => 0);
      continue;
    }
    if (first === null) return; // inotifywait is gone
    let { ev, path } = parseEvent(first);
    if (!isMedia(path)) continue;
    let n = 0;
    const gone: string[] = [];
    for (;;) {
      if (isMedia(path)) {
        n++;
        h.log(`Gone from the library: ${path}`);
        if (ev === 'DELETE') gone.push(path);
      }
      const next = await src.next(h.debounceMs);
      if (next === TIMEOUT || next === null) break;
      ({ ev, path } = parseEvent(next));
    }
    h.log(`${n} media file(s) removed, and ${h.debounce}s of quiet since.`);
    let rc: number;
    try {
      rc = await h.reclaim(gone);
    } catch (e) {
      h.log(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
      rc = 3;
    }
    if (rc !== 0) {
      h.log(`WARN: the reclaim exited ${rc} — ignoring further deletions for ${h.cooldown}s.`);
      await h.sleep(h.cooldownMs);
    }
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

const USAGE = 'usage: arr-reclaim.sh watch [--dry-run]|run|--audit';

/** What must hold before any mode runs; a line on stderr when it doesn't. */
function preflight(deps: Deps, cfg: Config): boolean {
  let isDir = false;
  try {
    isDir = statSync(cfg.library).isDirectory();
  } catch {
    // missing
  }
  if (!isDir) deps.stderr(`not a directory: ${cfg.library}`);
  else if (!cfg.qbt.user || !cfg.qbt.pass) deps.stderr(`QBT_ARR_USER / QBT_ARR_PASS not set in ${deps.repo}/.env`);
  else if (!cfg.apps.some((a) => a.key))
    deps.stderr(`neither RADARR_API_KEY nor SONARR_API_KEY is set in ${deps.repo}/.env`);
  else return true;
  return false;
}

export async function main(argv: readonly string[], deps: Deps): Promise<number> {
  const cli = parseCli(argv, { flags: ['--audit', '--dry-run'], positionals: true, usage: USAGE });
  if (cli.help) {
    deps.stdout(headerHelp(await Bun.file(import.meta.path).text()));
    return 0;
  }
  const [mode, ...rest] = cli.flags['--audit'] ? ['--audit', ...cli.positionals] : cli.positionals;
  const dry = cli.flags['--dry-run'];
  if (rest.length > 0 || (dry && mode !== 'watch') || !['watch', 'run', '--audit'].includes(mode ?? '')) {
    throw new UsageError(USAGE);
  }

  const cfg = config(deps);
  if (!preflight(deps, cfg)) return 3;
  const log = deps.log;
  const fileBacked = fileLedger(cfg.ledger, log);
  const ctx: Ctx = { deps, cfg, log, dry, ledger: dry ? memoryLedger(fileBacked.read()) : fileBacked };

  if (mode === 'run') return reclaimLocked(ctx);
  if (mode === '--audit') return reclaim(ctx, 'audit');

  if (!deps.which(cfg.inotifywait)) {
    deps.stderr(`missing command: ${cfg.inotifywait} — sudo apt install inotify-tools`);
    return 3;
  }
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log(`Watching ${cfg.library} for deletions (debounce ${cfg.debounce}s) for ${cfg.qbt.url}.`);
  if (dry) log(`Dry run: nothing is removed, Radarr and Sonarr are told nothing, ${cfg.ledger} is only read.`);
  if ((await recordLocked(ctx)) !== 0) {
    log(`WARN: could not record the import history now — retrying every ${cfg.recordEvery}s.`);
  }
  const src = deps.lines([
    cfg.inotifywait,
    '-m',
    '-r',
    '-q',
    '-e',
    'delete',
    '-e',
    'moved_from',
    '--format',
    '%e\t%w%f',
    '--',
    cfg.library,
  ]);
  // Stopped (systemctl stop, ^C): inotifywait goes too, then this process dies
  // of the same signal, as the bash script did, so systemd reads a clean stop.
  const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
  const stop = (sig: NodeJS.Signals) => {
    src.close();
    for (const s of SIGNALS) process.removeListener(s, stop);
    process.kill(process.pid, sig);
  };
  for (const s of SIGNALS) process.on(s, stop);
  try {
    await watchLoop(src, {
      log,
      sleep: deps.sleep,
      debounceMs: cfg.debounceMs,
      debounce: cfg.debounce,
      cooldownMs: cfg.cooldownMs,
      cooldown: cfg.cooldown,
      recordEveryMs: cfg.recordEveryMs,
      reclaim: (gone) => reclaimLocked(ctx, gone),
      record: () => recordLocked(ctx),
    });
  } finally {
    for (const s of SIGNALS) process.removeListener(s, stop);
    src.close();
  }
  log('ERROR: inotifywait exited — the unit will be restarted.');
  return 5;
}

if (import.meta.main) {
  await runMain(() =>
    main(Bun.argv.slice(2), {
      http: makeHttp(),
      // Under systemd, stdout is the journal.
      log: stamped('reclaim: '),
      stdout: out,
      stderr: err,
      sleep: (ms) => Bun.sleep(ms),
      lines,
      which: (cmd) => Bun.which(cmd),
      env: process.env,
      repo: resolve(import.meta.dir, '../..'),
    }),
  );
}
