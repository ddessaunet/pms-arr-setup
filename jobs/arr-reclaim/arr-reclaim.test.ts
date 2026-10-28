// jobs/arr-reclaim/arr-reclaim.test.ts — unit fixtures and a full rehearsal for arr-reclaim.ts.
//
// Offline, and changes nothing outside a scratch folder. The rehearsal builds a
// real library and torrent tree with real hardlinks, and stands in for
// qBittorrent and the Radarr/Sonarr APIs with a fake Http — so the link
// counting, the decisions and the removals are the real code, on real files.

import { afterAll, describe, expect, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Http, HttpRequest } from '../../stack/lib/http.ts';
import { tryLock } from '../../stack/lib/lock.ts';
import { lines, TIMEOUT, type LineSource } from '../../stack/lib/run.ts';
import {
  decide,
  historyImports,
  importLine,
  isMedia,
  ledgerLine,
  ledgerRows,
  main,
  mergeImports,
  movieWithFile,
  parseEvent,
  seriesHolding,
  tsvField,
  untsvField,
  watchLoop,
  type Deps,
  type Import,
} from './arr-reclaim.ts';

const ROOT = resolve(import.meta.dir, '../..');
const SCRATCH = mkdtempSync(join(tmpdir(), 'arr-reclaim-test-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

// ─── the decision ─────────────────────────────────────────────────────────────
describe('decide  (imports, imports-present, media, media-with-one-link)', () => {
  const cases: [string, string, Parameters<typeof decide>][] = [
    ['never imported → not ours', 'not-imported', [0, 0, 1, 1]],
    ['imported and still there → keep', 'in-library', [1, 1, 1, 0]],
    ['one episode of a pack deleted → keep', 'partial', [8, 7, 8, 1]],
    ['all gone, data unlinked → REMOVE', 'deleted', [1, 0, 1, 1]],
    ['whole pack gone, all unlinked → REMOVE', 'deleted', [8, 0, 8, 8]],
    ['gone from its path but still linked (renamed) → keep', 'moved', [1, 0, 1, 0]],
    ['imports gone and no media left at all → keep', 'moved', [1, 0, 0, 0]],
    ['path re-imported by another download, data unlinked → REMOVE', 'upgraded', [1, 1, 1, 1, true]],
    ['superseded, but its data is still linked → keep', 'in-library', [1, 1, 1, 0, true]],
    ['not superseded: same numbers are a plain in-library', 'in-library', [1, 1, 1, 1, false]],
    ['never imported beats superseded', 'not-imported', [0, 0, 1, 1, true]],
  ];
  for (const [label, want, args] of cases) test(label, () => expect(decide(...args)).toBe(want as never));
});

// ─── history parsing ──────────────────────────────────────────────────────────
describe('history_imports', () => {
  const H = {
    page: 1,
    pageSize: 250,
    totalRecords: 3,
    records: [
      {
        eventType: 'downloadFolderImported',
        date: '2026-09-29T18:44:17Z',
        downloadId: 'ABCDEF0123',
        data: { importedPath: '/lib/movies/A (2000)/A (2000).mkv', droppedPath: '/t/a.mkv' },
      },
      {
        eventType: 'downloadFolderImported',
        date: '2026-09-29T18:44:17Z',
        downloadId: null,
        data: { importedPath: '/lib/manual.mkv' },
      },
      {
        eventType: 'downloadFolderImported',
        downloadId: 'ABCDEF0123',
        data: { importedPath: '/lib/movies/A (2000)/A (2000).srt' },
      },
    ],
  };
  test('date first, hash lowercased, one line per imported file; a missing date is never empty', () =>
    expect(historyImports(H)!.imports.map(importLine)).toEqual([
      '2026-09-29T18:44:17Z\tabcdef0123\t/lib/movies/A (2000)/A (2000).mkv',
      '0\tabcdef0123\t/lib/movies/A (2000)/A (2000).srt',
    ]));
  test("a manual import (no downloadId) is nobody's torrent", () =>
    expect(historyImports(H)!.imports.some((i) => i.path.includes('manual'))).toBe(false));
  test('an empty page is nothing', () => expect(historyImports({ records: [] })).toEqual({ imports: [], records: 0 }));
  test('the records counted, for paging', () => expect(historyImports(H)!.records).toBe(3));
  test('not a history page → undefined (the app is treated as unreadable)', () => {
    expect(historyImports(undefined)).toBeUndefined();
    expect(historyImports({ message: 'Unauthorized' })).toBeUndefined();
  });
  const imp = (date: string, hash: string, path: string): Import => ({ date, hash, path });
  test('merge: deduplicated, newest first', () =>
    expect(
      mergeImports([imp('2026-09-01', 'a', '/p'), imp('2026-09-02', 'b', '/p'), imp('2026-09-01', 'a', '/p')]),
    ).toEqual([imp('2026-09-02', 'b', '/p'), imp('2026-09-01', 'a', '/p')]));
  test('merge: byte order, as LC_ALL=C sort (é sorts after every ASCII byte)', () =>
    expect(mergeImports([imp('d', 'h', '/é'), imp('d', 'h', '/z')]).map((i) => i.path)).toEqual(['/é', '/z']));
});

describe('the ledger', () => {
  test('@tsv escaping, both ways', () => {
    const odd = 'a\\b\tc\nd\re';
    expect(tsvField(odd)).toBe('a\\\\b\\tc\\nd\\re');
    expect(untsvField(tsvField(odd))).toBe(odd);
  });
  test("an app's rows, in the ledger's order; another app's are not its", () => {
    const L = 'sonarr\t2\ts\t/s\nradarr\t3\tb\t/b\nradarr\t1\ta\t/a\n';
    expect(ledgerRows(L, 'radarr').map((i) => ledgerLine('radarr', i))).toEqual([
      'radarr\t3\tb\t/b',
      'radarr\t1\ta\t/a',
    ]);
    expect(ledgerRows(L, 'radar')).toEqual([]);
  });
  test('read and written back: byte-identical, escapes included', () => {
    const L = 'radarr\t2026-09-30T00:10:00Z\tr1\t/lib/a\\\\b.mkv\nsonarr\t0\ts1\t/lib/S/S01E01.mkv\n';
    const back = ['radarr', 'sonarr'].flatMap((a) => ledgerRows(L, a).map((i) => ledgerLine(a, i)));
    expect(back.map((l) => `${l}\n`).join('')).toBe(L);
  });
});

describe('movie_with_file / series_holding', () => {
  const M = [
    { id: 7, title: 'A', year: 2000, movieFile: { path: '/lib/movies/A (2000)/A (2000).mkv' } },
    { id: 8, title: 'B', year: 2001, movieFile: null },
    { id: 9, title: 'C', year: 2002 },
  ];
  test('the movie whose file it was', () =>
    expect(movieWithFile(M, '/lib/movies/A (2000)/A (2000).mkv')).toEqual({ id: 7, title: 'A (2000)' }));
  test("a movie without a file record is nobody's", () =>
    expect(movieWithFile(M, '/lib/movies/B (2001)/B (2001).mkv')).toBeUndefined());
  const S = [
    { id: 2, title: 'The Boys', path: '/lib/series/The Boys' },
    { id: 3, title: 'The Boy', path: '/lib/series/The Boy' },
  ];
  test('the series whose folder holds it, not one named like a prefix', () =>
    expect(seriesHolding(S, '/lib/series/The Boys/Season 01/The Boys - S01E01.mkv')).toEqual({
      id: 2,
      title: 'The Boys',
    }));
  test('outside every series folder → nothing', () =>
    expect(seriesHolding(S, '/lib/movies/A (2000)/A (2000).mkv')).toBeUndefined());
});

describe('is_media', () => {
  test('mkv', () => expect(isMedia('/lib/movies/A (2000)/A (2000).mkv')).toBe(true));
  test('uppercase MP4', () => expect(isMedia('/lib/x.MP4')).toBe(true));
  test('a subtitle is not', () => expect(isMedia('/lib/movies/A (2000)/A (2000).srt')).toBe(false));
  test('a directory is not', () => expect(isMedia('/lib/movies/A (2000)')).toBe(false));
});

describe('parseEvent (read -r ev path, tab-separated)', () => {
  test('event and path', () =>
    expect(parseEvent('DELETE\t/lib/a b.mkv')).toEqual({ ev: 'DELETE', path: '/lib/a b.mkv' }));
  test('a directory event', () =>
    expect(parseEvent('DELETE,ISDIR\t/lib/D (2000)')).toEqual({ ev: 'DELETE,ISDIR', path: '/lib/D (2000)' }));
  test('a tab inside the path is kept; trailing ones are not', () =>
    expect(parseEvent('MOVED_FROM\t/lib/a\tb.mkv\t')).toEqual({ ev: 'MOVED_FROM', path: '/lib/a\tb.mkv' }));
});

// ─── a box: a library, torrents, and the apps stood in for ────────────────────
interface Torrent {
  hash: string;
  name: string;
  save_path: string;
  progress: number;
}
interface Rec {
  date?: string;
  downloadId: string;
  data: { importedPath: string };
}

let boxes = 0;
function newBox() {
  const dir = join(SCRATCH, `box-${++boxes}`);
  const T = join(dir, 'torrents/radarr');
  const LIB = join(dir, 'lib');
  mkdirSync(T, { recursive: true });
  mkdirSync(join(LIB, 'movies'), { recursive: true });
  const s = {
    dir,
    T,
    LIB,
    L: join(LIB, 'movies'),
    ledger: join(dir, '.arr-reclaim.imports'),
    lock: join(dir, '.arr-reclaim.lock'),
    info: [] as Torrent[],
    hist: [] as Rec[],
    shist: [] as Rec[],
    sonarrDown: false,
    qbtDown: false,
    movies: [] as unknown[],
    series: [] as unknown[],
    deleted: [] as string[],
    arrCalls: [] as string[],
    logs: [] as string[],
    stderr: [] as string[],
  };
  const json = (v: unknown, status = 200) => ({ status, text: JSON.stringify(v), headers: new Headers() });
  const page = (recs: Rec[], url: URL) => {
    const p = Number(url.searchParams.get('page'));
    return json({ records: recs.slice((p - 1) * 250, p * 250) });
  };
  // qBittorrent and the two APIs. Deletions are recorded, and the torrent data
  // really is deleted, as qBittorrent would.
  const http: Http = async (u: string, req: HttpRequest) => {
    const url = new URL(u);
    const method = req.method ?? 'GET';
    const path = url.pathname;
    if (url.port === '8081') {
      if (s.qbtDown) return { status: 0, text: '', headers: new Headers(), error: 'refused' };
      if (path === '/api/v2/auth/login') return { status: 204, text: '', headers: new Headers() };
      if (path === '/api/v2/torrents/info') return json(url.searchParams.get('category') === 'radarr' ? s.info : []);
      if (path === '/api/v2/torrents/files') {
        const t = s.info.find((x) => x.hash === url.searchParams.get('hash'));
        return json([{ name: `${t?.name}.mkv`, priority: 1 }]);
      }
      if (path === '/api/v2/torrents/delete') {
        const h = new URLSearchParams(String(req.body)).get('hashes')!;
        s.deleted.push(h);
        const t = s.info.find((x) => x.hash === h);
        if (t) rmSync(join(s.T, `${t.name}.mkv`), { force: true });
        return { status: 200, text: '', headers: new Headers() };
      }
    }
    if (url.port === '7878') {
      if (path === '/api/v3/history') return page(s.hist, url);
      if (path === '/api/v3/movie' && method === 'GET') return json(s.movies);
      if (path.startsWith('/api/v3/movie/')) {
        s.arrCalls.push(`radarr ${method} ${path.slice('/api/v3/'.length)}${url.search}`);
        return json({});
      }
    }
    if (url.port === '8989') {
      if (path === '/api/v3/history') return s.sonarrDown ? json({}, 503) : page(s.shist, url);
      if (path === '/api/v3/series') return json(s.series);
      if (path === '/api/v3/command') {
        s.arrCalls.push(`sonarr ${String(req.body)}`);
        return json({ id: 1 });
      }
    }
    return json({}, 404);
  };
  const deps = (env: Record<string, string> = {}, extra: Partial<Deps> = {}): Deps => ({
    http,
    log: (l) => s.logs.push(l),
    stdout: (l) => s.logs.push(l),
    stderr: (l) => s.stderr.push(l),
    sleep: async () => {},
    lines: () => ({ next: async () => null, close() {} }),
    which: () => '/usr/bin/inotifywait',
    env: {
      APPDATA: dir,
      LIBRARY: LIB,
      QBT_ARR_USER: 'u',
      QBT_ARR_PASS: 'p',
      RADARR_API_KEY: 'rk',
      SONARR_API_KEY: 'sk',
      RECLAIM_LOCK_WAIT: '0.2',
      ...env,
    },
    repo: dir,
    ...extra,
  });
  /** Runs main; the log lines of this run only. */
  const go = async (argv: string[], env: Record<string, string> = {}, extra: Partial<Deps> = {}) => {
    s.logs = [];
    const rc = await main(argv, deps(env, extra));
    return { rc, out: s.logs.join('\n') };
  };
  return Object.assign(s, { go, deps });
}

const count = (re: RegExp, text: string) => text.split('\n').filter((l) => re.test(l)).length;
const file = (p: string, text: string) => writeFileSync(p, text);
const hashOf = (n: number) => String(n).padStart(40, '0');

// ─── full rehearsal on real files ─────────────────────────────────────────────
// Six Radarr torrents, one per outcome, built with real hardlinks:
//   del   imported, then deleted in "Plex"             → removed, folder pruned
//   keep  imported, still in the library               → kept
//   ren   imported, then renamed inside the library    → kept (still linked)
//   copy  imported by COPY (no hardlink), still there  → kept
//   stray finished, never imported (not in history)    → kept
//   dl    still downloading                            → kept
describe('reclaim — rehearsal', () => {
  const b = newBox();
  const { T, L } = b;
  for (const n of ['del', 'keep', 'ren', 'copy', 'stray', 'dl']) file(join(T, `${n}.mkv`), n);
  for (const d of ['Del (2001)', 'Keep (2002)', 'Ren (2003)', 'Copy (2004)']) mkdirSync(join(L, d));
  linkSync(join(T, 'del.mkv'), join(L, 'Del (2001)/Del (2001).mkv'));
  linkSync(join(T, 'keep.mkv'), join(L, 'Keep (2002)/Keep (2002).mkv'));
  linkSync(join(T, 'ren.mkv'), join(L, 'Ren (2003)/Ren (2003).mkv'));
  copyFileSync(join(T, 'copy.mkv'), join(L, 'Copy (2004)/Copy (2004).mkv'));
  unlinkSync(join(L, 'Del (2001)/Del (2001).mkv')); // deleted in Plex
  renameSync(join(L, 'Ren (2003)/Ren (2003).mkv'), join(L, 'Ren (2003)/Ren (2003) renamed.mkv')); // renamed, not deleted

  b.info = ['del', 'keep', 'ren', 'copy', 'stray', 'dl'].map((name, i) => ({
    hash: hashOf(i + 1),
    name,
    save_path: T,
    progress: name === 'dl' ? 0.4 : 1,
  }));
  b.hist = [
    ['Del (2001)', 1],
    ['Keep (2002)', 2],
    ['Ren (2003)', 3],
    ['Copy (2004)', 4],
  ].map(([d, n]) => ({ downloadId: hashOf(n as number), data: { importedPath: join(L, `${d}/${d}.mkv`) } }));

  test("audit: would remove only the deleted one, and it is 'del'; changes nothing", async () => {
    const { rc, out } = await b.go(['--audit']);
    expect(rc).toBe(0);
    expect(count(/would remove/, out)).toBe(1);
    expect(count(/would remove 'del'/, out)).toBe(1);
    expect(b.deleted).toEqual([]);
    expect(existsSync(join(T, 'del.mkv'))).toBe(true);
    expect(existsSync(b.ledger)).toBe(false); // audit: writes no ledger
  });

  let out = '';
  test("run: exactly one removal, the deleted import's torrent", async () => {
    ({ out } = await b.go(['run']));
    expect(b.deleted).toEqual([hashOf(1)]);
    expect(existsSync(join(T, 'del.mkv'))).toBe(false); // its data is gone
    expect(existsSync(join(L, 'Del (2001)'))).toBe(false); // its empty folder pruned
  });
  test('kept: in the library, renamed, by copy, never imported, still downloading', () => {
    for (const n of ['keep', 'ren', 'copy', 'stray', 'dl']) expect(existsSync(join(T, `${n}.mkv`))).toBe(true);
    expect(existsSync(join(L, 'Keep (2002)'))).toBe(true); // the library's other folders untouched
  });
  test('summary names every outcome', () =>
    expect(out).toContain('Done (run): deleted=1 moved=1 in-library=2 not-imported=1 incomplete=1; removed 1.'));
  test('it logs the removal and the pruning', () => {
    expect(out).toContain("Removed 'del' (radarr) with its data — its library files are gone.");
    expect(out).toContain(`Pruned empty directory: ${join(L, 'Del (2001)')}`);
    expect(out).toContain("moved: 'ren' (radarr) — imports gone but its data is still linked elsewhere; kept");
  });
  test("run: the ledger holds the history, as radarr's; 0600", () => {
    const rows = readFileSync(b.ledger, 'utf8').trimEnd().split('\n');
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.startsWith('radarr\t'))).toBe(true);
    expect(statSync(b.ledger).mode & 0o777).toBe(0o600);
  });
  test('a second run finds nothing more to remove, and leaves the ledger file alone', async () => {
    b.deleted = [];
    const before = statSync(b.ledger).mtimeMs;
    await Bun.sleep(10);
    await b.go(['run']);
    expect(b.deleted).toEqual([]);
    expect(statSync(b.ledger).mtimeMs).toBe(before);
  });
});

// The cap: with every torrent "deleted", only RECLAIM_MAX_REMOVALS go per run.
describe('reclaim — the cap', () => {
  test('five deleted, three removed, and the rest are named for the next run', async () => {
    const b = newBox();
    for (let n = 1; n <= 5; n++) file(join(b.T, `cap${n}.mkv`), 'x');
    b.info = [1, 2, 3, 4, 5].map((n) => ({ hash: `c${n}`, name: `cap${n}`, save_path: b.T, progress: 1 }));
    b.hist = [1, 2, 3, 4, 5].map((n) => ({ downloadId: `C${n}`, data: { importedPath: join(b.L, `gone${n}.mkv`) } }));
    const { out } = await b.go(['run'], { RECLAIM_MAX_REMOVALS: '3' });
    expect(b.deleted).toHaveLength(3);
    expect(count(/RECLAIM_MAX_REMOVALS=3 reached — 'cap\d' left for the next run/, out)).toBe(2);
  });
});

// ─── an upgrade, on real files ────────────────────────────────────────────────
// Radarr grabbed "old", imported it, then an upgrade "new" was imported to the
// SAME library path. The library now links "new"; "old" is down to one link.
describe('reclaim — upgrade', () => {
  const b = newBox();
  const U = join(b.L, 'Up (2024)');
  mkdirSync(U);
  file(join(b.T, 'up-old.mkv'), 'old');
  file(join(b.T, 'up-new.mkv'), 'new');
  linkSync(join(b.T, 'up-old.mkv'), join(U, 'Up (2024).mkv')); // first import
  unlinkSync(join(U, 'Up (2024).mkv'));
  linkSync(join(b.T, 'up-new.mkv'), join(U, 'Up (2024).mkv')); // the upgrade replaces it
  file(join(b.T, 're-still.mkv'), 'kept');
  linkSync(join(b.T, 're-still.mkv'), join(b.LIB, 'elsewhere.mkv')); // superseded, still linked
  b.info = [
    { hash: 'u1', name: 'up-old', save_path: b.T, progress: 1 },
    { hash: 'u2', name: 'up-new', save_path: b.T, progress: 1 },
    { hash: 'u3', name: 're-still', save_path: b.T, progress: 1 },
  ];
  const p = join(U, 'Up (2024).mkv');
  b.hist = [
    { date: '2026-09-03T00:00:00Z', downloadId: 'U2', data: { importedPath: p } },
    { date: '2026-09-02T00:00:00Z', downloadId: 'U3', data: { importedPath: p } },
    { date: '2026-09-01T00:00:00Z', downloadId: 'U1', data: { importedPath: p } },
  ];
  let out = '';
  test('only the replaced torrent is removed, and it says why', async () => {
    ({ out } = await b.go(['run']));
    expect(b.deleted).toEqual(['u1']);
    expect(count(/Removed 'up-old'.*an upgrade replaced it/, out)).toBe(1);
  });
  test('the new file is still in the library, its folder is not pruned', () => {
    expect(existsSync(p)).toBe(true);
    expect(existsSync(U)).toBe(true);
  });
  test('the new torrent is kept; superseded but still linked is kept', () => {
    expect(existsSync(join(b.T, 'up-new.mkv'))).toBe(true);
    expect(existsSync(join(b.T, 're-still.mkv'))).toBe(true);
  });
  test('summary', () => expect(out).toContain('upgraded=1 in-library=2; removed 1.'));
  test("the replaced torrent's import stays in the ledger while the history has it", () =>
    expect(count(/\tu1\t/, readFileSync(b.ledger, 'utf8'))).toBe(1));
});

// ─── deleted in Radarr: the history goes with the movie ───────────────────────
// "gone" was imported and recorded; then the movie was deleted in Radarr with
// its files, which purged its history. "unknown" is the same on disk but was
// never recorded. A sonarr row stays put while Sonarr cannot be read.
describe('reclaim — deleted in Radarr', () => {
  const b = newBox();
  const G = join(b.L, 'Gone (2005)');
  mkdirSync(G);
  file(join(b.T, 'gone.mkv'), 'gone');
  linkSync(join(b.T, 'gone.mkv'), join(G, 'Gone (2005).mkv'));
  file(join(b.T, 'unknown.mkv'), 'unknown');
  b.info = [
    { hash: 'r1', name: 'gone', save_path: b.T, progress: 1 },
    { hash: 'r2', name: 'unknown', save_path: b.T, progress: 1 },
  ];
  b.hist = [{ date: '2026-09-30T00:10:00Z', downloadId: 'R1', data: { importedPath: join(G, 'Gone (2005).mkv') } }];
  b.shist = [{ date: '2026-09-20T00:00:00Z', downloadId: 'S1', data: { importedPath: '/lib/series/S/S01E01.mkv' } }];

  // The watcher records while idle: one quiet read, then inotifywait ends.
  const idleOnce = (): LineSource => {
    let n = 0;
    return { next: async () => (n++ === 0 ? TIMEOUT : null), close() {} };
  };
  test('record: one line per app that had news, into the ledger; nothing removed', async () => {
    const { rc, out } = await b.go(['watch'], {}, { lines: idleOnce });
    expect(rc).toBe(5); // inotifywait ended
    expect(count(/Recorded 1 import\(s\)/, out)).toBe(2);
    expect(readFileSync(b.ledger, 'utf8').trimEnd().split('\n')).toHaveLength(2);
    expect(b.deleted).toEqual([]);
  });
  test('record again: nothing new, nothing said, no duplicates', async () => {
    const { out } = await b.go(['watch'], {}, { lines: idleOnce });
    expect(count(/Recorded/, out)).toBe(0);
    expect(readFileSync(b.ledger, 'utf8').trimEnd().split('\n')).toHaveLength(2);
  });

  test('audit: would remove the recorded one; ledger byte-identical', async () => {
    unlinkSync(join(G, 'Gone (2005).mkv')); // "Delete movie", with files
    rmdirSync(G);
    b.hist = []; // … and Radarr's history of it
    b.sonarrDown = true;
    const before = readFileSync(b.ledger);
    const { out } = await b.go(['--audit']);
    expect(count(/would remove 'gone'/, out)).toBe(1);
    expect(readFileSync(b.ledger).equals(before)).toBe(true);
  });
  let out = '';
  test('run: the recorded torrent is removed, its data gone; never recorded: kept', async () => {
    ({ out } = await b.go(['run']));
    expect(b.deleted).toEqual(['r1']);
    expect(existsSync(join(b.T, 'gone.mkv'))).toBe(false);
    expect(existsSync(join(b.T, 'unknown.mkv'))).toBe(true);
  });
  test('summary', () => expect(out).toContain('deleted=1 not-imported=1; removed 1.'));
  test('it says sonarr could not be read', () =>
    expect(out).toContain("WARN: cannot read sonarr's import history at http://127.0.0.1:8989"));
  test('its row is dropped: neither Radarr nor qBittorrent has it', () =>
    expect(count(/\tr1\t/, readFileSync(b.ledger, 'utf8'))).toBe(0));
  test('Sonarr unreachable: its row is kept', () =>
    expect(count(/^sonarr\t.*\ts1\t/, readFileSync(b.ledger, 'utf8'))).toBe(1));
});

// ─── telling Radarr and Sonarr, on real files ─────────────────────────────────
//   Gone (2010)    file deleted in Plex                       → removed from Radarr
//   Up (2011)      deleted, but an upgrade put a file back     → kept
//   Twice (2012)   its file named twice in one burst          → removed once
//   two episodes of one series, one of another                → each series rescanned once
//   a deleted file Radarr no longer knows (its own delete)    → nothing
//   a path outside the library                                → nothing
describe('forget — rehearsal', () => {
  const b = newBox();
  const { L } = b;
  const SL = join(b.LIB, 'series');
  mkdirSync(join(L, 'Up (2011)'));
  mkdirSync(join(SL, 'Show/Season 01'), { recursive: true });
  mkdirSync(join(SL, 'Other/Season 02'), { recursive: true });
  file(join(L, 'Up (2011)/Up (2011).mkv'), 'new');
  b.movies = [
    { id: 21, title: 'Gone', year: 2010, movieFile: { path: join(L, 'Gone (2010)/Gone (2010).mkv') } },
    { id: 22, title: 'Up', year: 2011, movieFile: { path: join(L, 'Up (2011)/Up (2011).mkv') } },
    { id: 23, title: 'Twice', year: 2012, movieFile: { path: join(L, 'Twice (2012)/Twice (2012).mkv') } },
    { id: 24, title: 'Kept', year: 2013, movieFile: null },
  ];
  b.series = [
    { id: 31, title: 'Show', path: join(SL, 'Show') },
    { id: 32, title: 'Other', path: join(SL, 'Other') },
  ];
  const GONE = [
    join(L, 'Gone (2010)/Gone (2010).mkv'),
    join(L, 'Up (2011)/Up (2011).mkv'),
    join(L, 'Twice (2012)/Twice (2012).mkv'),
    join(L, 'Twice (2012)/Twice (2012).mkv'),
    join(L, 'Kept (2013)/Kept (2013).mkv'),
    join(SL, 'Show/Season 01/Show - S01E01.mkv'),
    join(SL, 'Show/Season 01/Show - S01E02.mkv'),
    join(SL, 'Other/Season 02/Other - S02E01.mkv'),
    '/elsewhere/Gone (2010)/Gone (2010).mkv',
  ];
  // One burst of these deletions, through the watcher.
  const burst = (paths: readonly string[]) => () => {
    const q = paths.map((p) => `DELETE\t${p}`);
    return { next: async () => (q.length ? q.shift()! : null), close() {} };
  };
  const forget = async (paths: readonly string[], env: Record<string, string> = {}) => {
    b.arrCalls = [];
    return b.go(['watch'], env, { lines: burst(paths) });
  };

  let out = '';
  test('forget: the deleted movies removed from Radarr, once each, files untouched', async () => {
    ({ out } = await forget(GONE));
    expect(b.arrCalls.filter((c) => c.startsWith('radarr'))).toEqual(
      [21, 23].map((id) => `radarr DELETE movie/${id}?deleteFiles=false&addImportExclusion=false`),
    );
  });
  test('forget: each series with a deleted episode rescanned once', () =>
    expect(b.arrCalls.filter((c) => c.startsWith('sonarr')).sort()).toEqual(
      [31, 32].map((id) => `sonarr {"name":"RescanSeries","seriesId":${id}}`),
    ));
  test('forget: says what it did, and the burst', () => {
    expect(count(/from radarr — its file was deleted/, out)).toBe(2);
    expect(count(/Asked sonarr to rescan/, out)).toBe(2);
    expect(out).toContain('9 media file(s) removed, and 60s of quiet since.');
    expect(out).not.toContain('WARN: the reclaim exited');
  });
  test("forget: the cap leaves the rest to Radarr's rescan", async () => {
    const { out } = await forget(GONE, { RECLAIM_MAX_FORGETS: '1' });
    expect(b.arrCalls.filter((c) => c.startsWith('radarr'))).toHaveLength(1);
    expect(count(/RECLAIM_MAX_FORGETS=1 reached/, out)).toBe(1);
  });
  test('forget: nothing gone for good → nothing said or done', async () => {
    const { out } = await forget([join(L, 'Up (2011)/Up (2011).mkv')]);
    expect(b.arrCalls).toEqual([]);
    expect(out).not.toMatch(/radarr|sonarr/);
  });

  // The burst's reclaim records the history before forgetting anything, and
  // forgets nothing when it can't.
  test('history unreadable → Radarr told nothing, and it says so', async () => {
    b.sonarrDown = true;
    const { out } = await forget([join(L, 'Gone (2010)/Gone (2010).mkv')]);
    b.sonarrDown = false;
    expect(b.arrCalls).toEqual([]);
    expect(count(/radarr and sonarr are told nothing/, out)).toBe(1);
    expect(out).toContain('WARN: the reclaim exited 5 — ignoring further deletions for 300s.');
  });
  test('history recorded → Radarr told', async () => {
    await forget([join(L, 'Gone (2010)/Gone (2010).mkv')]);
    expect(b.arrCalls.filter((c) => c.startsWith('radarr'))).toHaveLength(1);
  });
  test('a run without deletions (task, or manual run) tells nobody', async () => {
    b.arrCalls = [];
    await b.go(['run']);
    expect(b.arrCalls).toEqual([]);
  });
  test('a move is reclaimed, never forgotten', async () => {
    b.arrCalls = [];
    const q = [`MOVED_FROM\t${join(L, 'Gone (2010)/Gone (2010).mkv')}`];
    await b.go(['watch'], {}, { lines: () => ({ next: async () => q.shift() ?? null, close() {} }) });
    expect(b.arrCalls).toEqual([]);
  });

  // ─── watch --dry-run: says, never does ──────────────────────────────────────
  test('dry run: says what it would tell Radarr and Sonarr, and tells them nothing', async () => {
    const { rc, out } = await forget(GONE, {});
    expect(rc).toBe(5);
    b.arrCalls = [];
    const dry = await b.go(['watch', '--dry-run'], {}, { lines: burst(GONE) });
    expect(b.arrCalls).toEqual([]);
    expect(dry.out).toContain('Dry run: nothing is removed');
    expect(count(/would remove '(Gone \(2010\)|Twice \(2012\))' from radarr/, dry.out)).toBe(2);
    expect(count(/would ask sonarr to rescan '(Show|Other)'/, dry.out)).toBe(2);
    expect(out).toContain('Asked sonarr');
  });
});

describe('watch --dry-run on real files', () => {
  const b = newBox();
  const D = join(b.L, 'Del (2001)');
  mkdirSync(D);
  file(join(b.T, 'del.mkv'), 'del');
  linkSync(join(b.T, 'del.mkv'), join(D, 'Del (2001).mkv'));
  b.info = [{ hash: 'd1', name: 'del', save_path: b.T, progress: 1 }];
  b.hist = [{ date: '2026-10-01T00:00:00Z', downloadId: 'D1', data: { importedPath: join(D, 'Del (2001).mkv') } }];
  b.movies = [{ id: 41, title: 'Del', year: 2001, movieFile: { path: join(D, 'Del (2001).mkv') } }];
  const LEDGER = 'radarr\t2026-01-01T00:00:00Z\told\t/lib/old.mkv\n';
  file(b.ledger, LEDGER);

  let out = '';
  test('a deletion: it would remove the torrent and the movie, and does neither', async () => {
    unlinkSync(join(D, 'Del (2001).mkv'));
    const q = [`DELETE\t${join(D, 'Del (2001).mkv')}`];
    ({ out } = await b.go(
      ['watch', '--dry-run'],
      {},
      { lines: () => ({ next: async () => q.shift() ?? null, close() {} }) },
    ));
    expect(out).toContain("would remove 'del' (radarr) — its library files are gone");
    expect(out).toContain("would remove 'Del (2001)' from radarr — its file was deleted from the library");
    expect(out).toContain('Done (audit): deleted=1; removed 0.');
    expect(b.deleted).toEqual([]);
    expect(b.arrCalls).toEqual([]);
  });
  test('the data, the folder and the ledger are untouched; it recorded in memory', () => {
    expect(existsSync(join(b.T, 'del.mkv'))).toBe(true);
    expect(existsSync(D)).toBe(true);
    expect(readFileSync(b.ledger, 'utf8')).toBe(LEDGER);
    expect(out).toContain('Recorded 1 import(s) of radarr.');
  });
  test('it takes no lock: it runs while the lock is held', async () => {
    const held = tryLock(b.lock)!;
    try {
      const { out } = await b.go(
        ['watch', '--dry-run'],
        {},
        {
          lines: () => {
            const q = [`DELETE\t${join(D, 'Del (2001).mkv')}`];
            return { next: async () => q.shift() ?? null, close() {} };
          },
        },
      );
      expect(out).not.toContain('Another reclaim holds');
      expect(out).toContain('Done (audit)');
    } finally {
      held.release();
    }
  });
  test('only watch takes --dry-run', () => expect(b.go(['run', '--dry-run'])).rejects.toThrow('usage: arr-reclaim.sh'));
});

// ─── the lock ─────────────────────────────────────────────────────────────────
describe('the lock', () => {
  const b = newBox();
  test('run waits for a held lock, then skips', async () => {
    const held = tryLock(b.lock)!;
    try {
      const { rc, out } = await b.go(['run']);
      expect(rc).toBe(0);
      expect(out).toBe(`Another reclaim holds ${b.lock} — skipping.`);
    } finally {
      held.release();
    }
  });
  test.skipIf(!Bun.which('flock'))("a bash run's lock (util-linux flock) is honoured", async () => {
    // As the bash script holds it: an fd, flock on it, and one process to kill.
    const proc = Bun.spawn(['sh', '-c', 'exec 9>"$1"; flock 9; exec sleep 3', 'sh', b.lock], { stdout: 'ignore' });
    await Bun.sleep(300);
    try {
      expect((await b.go(['run'])).out).toBe(`Another reclaim holds ${b.lock} — skipping.`);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });
  test('the idle record never waits: a held lock means no record', async () => {
    b.hist = [{ downloadId: 'X1', data: { importedPath: '/x.mkv' } }];
    const held = tryLock(b.lock)!;
    let n = 0;
    try {
      await b.go(['watch'], {}, { lines: () => ({ next: async () => (n++ < 2 ? TIMEOUT : null), close() {} }) });
      expect(existsSync(b.ledger)).toBe(false);
    } finally {
      held.release();
    }
  });
  test('an unopenable lock is exit 3', async () => {
    const { rc, out } = await b.go(['run'], { RECLAIM_LOCK: join(b.dir, 'no/such/dir/lock') });
    expect(rc).toBe(3);
    expect(out).toContain('ERROR: cannot open');
  });
});

// ─── more failures ────────────────────────────────────────────────────────────
describe('failures', () => {
  test('qBittorrent away: exit 5, said', async () => {
    const b = newBox();
    b.qbtDown = true;
    const { rc, out } = await b.go(['--audit']);
    expect(rc).toBe(5);
    expect(out).toBe('ERROR: cannot reach qBittorrent at http://127.0.0.1:8081');
  });
  test('history paged: 251 imports are two pages, all read', async () => {
    const b = newBox();
    b.hist = Array.from({ length: 251 }, (_, i) => ({ downloadId: `P${i}`, data: { importedPath: `/p/${i}.mkv` } }));
    b.shist = [];
    const q: string[] = [];
    let n = 0;
    await b.go(
      ['watch'],
      {},
      { lines: () => ({ next: async () => (n++ === 0 ? TIMEOUT : (q.shift() ?? null)), close() {} }) },
    );
    expect(readFileSync(b.ledger, 'utf8').trimEnd().split('\n')).toHaveLength(251);
  });
  test('a reclaim that throws: logged, cooled down, the watch goes on', async () => {
    const said: string[] = [];
    let slept = 0;
    const q = ['DELETE\t/lib/a.mkv', 'DELETE\t/lib/b.mkv'];
    let runs = 0;
    await watchLoop(
      { next: async () => (q.length ? q.shift()! : null), close() {} },
      {
        log: (l) => said.push(l),
        sleep: async (ms) => void (slept += ms),
        debounceMs: 1,
        debounce: '1',
        cooldownMs: 300_000,
        cooldown: '300',
        recordEveryMs: 1000,
        reclaim: async () => {
          runs++;
          throw new Error('boom');
        },
        record: async () => 0,
      },
    );
    expect(runs).toBe(1);
    expect(said).toContain('ERROR: boom');
    expect(said).toContain('WARN: the reclaim exited 3 — ignoring further deletions for 300s.');
    expect(slept).toBe(300_000);
  });
});

// ─── debounce ─────────────────────────────────────────────────────────────────
describe('watch_loop', () => {
  /** Lines with a delay before each (ms), then the end. */
  const timed = (items: [number, string][]): LineSource => {
    const q = [...items];
    return {
      async next(timeoutMs) {
        const head = q[0];
        if (!head) return null;
        if (head[0] > timeoutMs) {
          head[0] -= timeoutMs;
          return TIMEOUT;
        }
        q.shift();
        return head[1];
      },
      close() {},
    };
  };
  const loop = async (src: LineSource) => {
    const runs: string[] = [];
    await watchLoop(src, {
      log: () => {},
      sleep: async () => {},
      debounceMs: 1000,
      debounce: '1',
      cooldownMs: 0,
      cooldown: '0',
      recordEveryMs: 1000,
      reclaim: async (gone) => {
        runs.push(['run', ...gone].join(' '));
        return 0;
      },
      record: async () => {
        runs.push('record');
        return 0;
      },
    });
    return runs;
  };
  test('one burst → one run, with its deleted media', async () =>
    expect(
      await loop(
        timed([
          [0, 'DELETE\t/lib/a.mkv'],
          [0, 'DELETE\t/lib/a.srt'],
          [0, 'DELETE\t/lib/b.mkv'],
        ]),
      ),
    ).toEqual(['run /lib/a.mkv /lib/b.mkv']));
  test('a move is reclaimed, never forgotten', async () =>
    expect(
      await loop(
        timed([
          [0, 'MOVED_FROM\t/lib/old name.mkv'],
          [0, 'DELETE\t/lib/d.mkv'],
        ]),
      ),
    ).toEqual(['run /lib/d.mkv']));
  test('no media in the burst → no run', async () => {
    expect(await loop(timed([[0, 'DELETE\t/lib/poster.jpg']]))).toEqual([]);
    expect(await loop(timed([[0, 'DELETE,ISDIR\t/lib/movies/Dir (2000)']]))).toEqual([]);
  });
  test('idle → a record, then the burst → a run', async () =>
    expect(await loop(timed([[1500, 'DELETE\t/lib/c.mkv']]))).toEqual(['record', 'run /lib/c.mkv']));
  test('two bursts apart → two runs', async () =>
    expect(
      await loop(
        timed([
          [0, 'DELETE\t/lib/a.mkv'],
          [1500, 'DELETE\t/lib/b.mkv'],
        ]),
      ),
    ).toEqual(['run /lib/a.mkv', 'run /lib/b.mkv']));
});

// ─── inotifywait itself ───────────────────────────────────────────────────────
describe.skipIf(!Bun.which('inotifywait'))('a real inotifywait on a scratch library', () => {
  test('a delete and a move, as the watch reads them', async () => {
    const lib = join(SCRATCH, 'inotify');
    mkdirSync(join(lib, 'movies/A (2000)'), { recursive: true });
    const a = join(lib, 'movies/A (2000)/A (2000).mkv');
    file(a, 'a');
    file(join(lib, 'b.mkv'), 'b');
    const src = lines([
      'inotifywait',
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
      lib,
    ]);
    try {
      await Bun.sleep(300); // watches established
      unlinkSync(a);
      renameSync(join(lib, 'b.mkv'), join(lib, 'c.mkv'));
      expect(await src.next(3000)).toBe(`DELETE\t${a}`);
      expect(await src.next(3000)).toBe(`MOVED_FROM\t${join(lib, 'b.mkv')}`);
    } finally {
      src.close();
    }
  });
});

describe('stopped', () => {
  test('SIGTERM: inotifywait goes too, and the watch dies of the signal (a clean stop to systemd)', async () => {
    const b = newBox();
    const fake = join(b.dir, 'inotifywait');
    const pidFile = join(b.dir, 'inotify.pid');
    file(fake, `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 30\n`);
    Bun.spawnSync(['chmod', '+x', fake]);
    const proc = Bun.spawn(['bun', '--no-install', join(import.meta.dir, 'arr-reclaim.ts'), 'watch'], {
      env: {
        ...process.env,
        APPDATA: b.dir,
        LIBRARY: b.LIB,
        QBT_ARR_USER: 'u',
        QBT_ARR_PASS: 'p',
        RADARR_API_KEY: 'rk',
        RADARR_URL: 'http://127.0.0.1:9',
        SONARR_URL: 'http://127.0.0.1:9',
        INOTIFYWAIT: fake,
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await Bun.sleep(50);
    const child = Number(readFileSync(pidFile, 'utf8'));
    proc.kill('SIGTERM');
    await proc.exited;
    expect(proc.signalCode).toBe('SIGTERM');
    await Bun.sleep(100);
    expect(() => process.kill(child, 0)).toThrow(); // gone
  });
});

// ─── main ─────────────────────────────────────────────────────────────────────
describe('main', () => {
  const b = newBox();
  test('usage → UsageError (exit 2 through runMain)', async () => {
    for (const argv of [[], ['bogus'], ['run', 'extra'], ['--audit', '--dry-run'], ['--bogus']])
      expect(b.go(argv)).rejects.toThrow('usage: arr-reclaim.sh watch [--dry-run]|run|--audit');
  });
  test('--help prints the header', async () => {
    const { rc, out } = await b.go(['--help']);
    expect(rc).toBe(0);
    expect(out).toStartWith('jobs/arr-reclaim/arr-reclaim.ts — when media Radarr or Sonarr imported is deleted');
  });
  const pre: [string, Record<string, string>, string][] = [
    ['no library', { LIBRARY: join(SCRATCH, 'none') }, `not a directory: ${join(SCRATCH, 'none')}`],
    ['no qBittorrent login', { QBT_ARR_PASS: '' }, 'QBT_ARR_USER / QBT_ARR_PASS not set in'],
    ['no API key', { RADARR_API_KEY: '', SONARR_API_KEY: '' }, 'neither RADARR_API_KEY nor SONARR_API_KEY is set in'],
  ];
  for (const [label, env, msg] of pre)
    test(`preflight: ${label} → exit 3`, async () => {
      b.stderr = [];
      expect((await b.go(['run'], env)).rc).toBe(3);
      expect(b.stderr.join('\n')).toContain(msg);
    });
  test('watch without inotifywait → exit 3', async () => {
    b.stderr = [];
    expect((await b.go(['watch'], {}, { which: () => null })).rc).toBe(3);
    expect(b.stderr).toEqual(['missing command: inotifywait — sudo apt install inotify-tools']);
  });
  test('watch: its header, then exit 5 when inotifywait ends', async () => {
    const { rc, out } = await b.go(['watch']);
    expect(rc).toBe(5);
    expect(out.split('\n')).toEqual([
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `Watching ${b.LIB} for deletions (debounce 60s) for http://127.0.0.1:8081.`,
      'ERROR: inotifywait exited — the unit will be restarted.',
    ]);
  });
  test('watch starts inotifywait on the library, as the bash did', async () => {
    let argv: readonly string[] = [];
    await b.go(
      ['watch'],
      { INOTIFYWAIT: '/x/inotifywait' },
      {
        lines: (a) => {
          argv = a;
          return { next: async () => null, close() {} };
        },
      },
    );
    expect(argv).toEqual([
      '/x/inotifywait',
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
      b.LIB,
    ]);
  });
  test('a key only in .env is read from it; one in the environment wins', async () => {
    file(join(b.dir, '.env'), 'RADARR_API_KEY=fromfile\nSONARR_API_KEY=fromfile\n');
    const keys = new Set<string>();
    const d = b.deps({ RADARR_API_KEY: '', SONARR_API_KEY: 'fromenv' });
    await main(['--audit'], {
      ...d,
      http: async (u, req) => {
        if (/:(7878|8989)\//.test(u)) keys.add(`${new URL(u).port} ${req.headers?.['X-Api-Key']}`);
        return d.http(u, req);
      },
    });
    unlinkSync(join(b.dir, '.env'));
    expect([...keys].sort()).toEqual(['7878 fromfile', '8989 fromenv']);
  });
});

// ─── one name, several owners ─────────────────────────────────────────────────
describe('the unit', () => {
  const unit = readFileSync(join(ROOT, 'jobs/arr-reclaim/arr-reclaim.service'), 'utf8');
  const source = readFileSync(join(ROOT, 'jobs/arr-reclaim/arr-reclaim.ts'), 'utf8');
  test('runs the launcher, watching', () =>
    expect(unit.match(/^ExecStart=(.*)$/m)?.[1]).toBe('@PMS_HOME@/jobs/arr-reclaim/arr-reclaim.sh watch'));
  test('allows no netlink, so the job stays clear of stack/lib/net.ts', () => {
    expect(unit).toMatch(/^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/m);
    expect(source).not.toMatch(/net\.ts/);
  });
  test('leaves Bun its JIT (no MemoryDenyWriteExecute)', () =>
    expect(unit).not.toMatch(/^MemoryDenyWriteExecute=yes/m));
});
