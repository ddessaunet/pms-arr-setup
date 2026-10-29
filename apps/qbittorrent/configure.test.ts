// apps/qbittorrent/configure.test.ts — unit fixtures for apps/qbittorrent/configure.ts,
// and main against a fake qBittorrent and a fake `docker logs`.
//
// Offline, and changes nothing. The live behaviour (first-run bootstrap from
// the temporary password, 204/401 logins, 409 on an existing category, host
// header validation) was checked against a throwaway linuxserver/qbittorrent
// 5.2.3 container; the fake answers the way it did.

import { describe, expect, test } from 'bun:test';
import type { HttpRequest, HttpResponse } from '../../stack/lib/http.ts';
import { lanAddresses } from '../../stack/lib/net.ts';
import type { RunResult } from '../../stack/lib/run.ts';
import { CATEGORIES, categoriesReport, domainList, main, prefsReport, tempPasswordOf, wantPrefs } from './configure.ts';
import { EXCLUDED_EXTS } from './excluded.ts';

// `hostname -I` as the bash test stubbed it.
const LAN = lanAddresses(['192.168.0.86', '192.168.0.66', '172.17.0.1', '172.18.0.1', 'fd73:5731::1']);

// ─── domain list ──────────────────────────────────────────────────────────────
describe('domain_list', () => {
  test('LAN IPv4 only: no docker bridges, no IPv6', () => expect(LAN).toEqual(['192.168.0.86', '192.168.0.66']));
  test('service name, loopback, host, LAN', () =>
    expect(domainList('pms', LAN)).toBe('qbittorrent;localhost;127.0.0.1;pms;192.168.0.86;192.168.0.66'));
  test('127.0.0.1 is always in it (else the script locks itself out)', () =>
    expect(domainList('pms', []).split(';')).toContain('127.0.0.1'));
});

// ─── wanted preferences ───────────────────────────────────────────────────────
describe('want_prefs', () => {
  const W = wantPrefs(domainList('pms', LAN));
  for (const k of [
    'save_path',
    'temp_path_enabled',
    'temp_path',
    'auto_tmm_enabled',
    'autorun_enabled',
    'listen_port',
    'upnp',
    'max_ratio_enabled',
    'max_ratio',
    'max_seeding_time_enabled',
    'max_seeding_time',
    'max_ratio_act',
    'dl_limit',
    'dont_count_slow_torrents',
    'web_ui_host_header_validation_enabled',
    'web_ui_domain_list',
    'excluded_file_names_enabled',
    'excluded_file_names',
  ]) {
    test(`sets ${k}`, () => expect(k in W).toBe(true));
  }
  test('never the hook', () => expect(W.autorun_enabled).toBe(false));
  test("peer port is not native's", () => expect(W.listen_port).toBe(13762));
  test('incomplete stays on the same volume', () => expect(W.temp_path).toBe('/mnt/data/torrents/.incomplete-arr'));
  test('seeding: ratio 2.0', () => expect(W.max_ratio).toBe(2));
  test('seeding: or 14 days', () => expect(W.max_seeding_time).toBe(20160));
  test('both limits on', () => expect([W.max_ratio_enabled, W.max_seeding_time_enabled]).toEqual([true, true]));
  // 0 is Stop. 1 (Remove) or 3 (RemoveWithContent) would pull the torrent out from
  // under Radarr/Sonarr before their "Remove Completed" tidies the queue.
  test('then STOP, never remove', () => expect(W.max_ratio_act).toBe(0));
  // Decluttarr's remove_slow only pauses on a busy line when a limit is set; 0 is
  // unlimited and would make it count a shared line as a slow swarm.
  test('download limit 64 MiB/s, never 0', () => expect(W.dl_limit).toBe(67108864));
  test('stalled downloads free their slot', () => expect(W.dont_count_slow_torrents).toBe(true));
  // Executables are never downloaded or seeded (the 2026-10-08 .exe fake).
  test('executables excluded', () => expect(W.excluded_file_names_enabled).toBe(true));
  test('one pattern per line, in this order', () =>
    expect(W.excluded_file_names).toBe('*.exe\n*.scr\n*.bat\n*.cmd\n*.com\n*.pif\n*.lnk\n*.msi\n*.vbs'));
  // A media, subtitle or info file in that list would silently stop imports.
  for (const e of ['mkv', 'mp4', 'avi', 'm4v', 'ts', 'srt', 'ass', 'sub', 'idx', 'nfo']) {
    test(`never excludes .${e}`, () =>
      expect(String(W.excluded_file_names).toLowerCase().split('\n')).not.toContain(`*.${e}`));
  }
  // Archives stay downloadable: the list is global, so hand-added torrents in
  // `manual` would lose theirs. Decluttarr clears single-archive fakes instead.
  for (const e of ['7z', 'zip', 'rar']) {
    test(`never excludes .${e}`, () =>
      expect(String(W.excluded_file_names).toLowerCase().split('\n')).not.toContain(`*.${e}`));
  }
  test('EXCLUDED_EXTS is the list it sends', () => expect(EXCLUDED_EXTS).toHaveLength(9));
});

// ─── temporary password ───────────────────────────────────────────────────────
describe('temp_password', () => {
  test('parsed from the log', () =>
    expect(
      tempPasswordOf(
        [
          'The WebUI administrator username is: admin',
          'The WebUI administrator password was not set. A temporary password is provided for this session: ZK4tTJDGK',
          'You should set your own password in program preferences.',
        ].join('\n'),
      ),
    ).toBe('ZK4tTJDGK'));
  test('none once a password is set', () =>
    expect(tempPasswordOf('WebUI will be started shortly after internal preparations.\n')).toBe(''));
});

// ─── read-back ────────────────────────────────────────────────────────────────
describe('prefs_report / categories_report', () => {
  const W = wantPrefs(domainList('pms', LAN));
  const R = prefsReport({ ...W, listen_port: 6881, extra: 1 }, W);
  test('one line per wanted key', () => expect(R).toHaveLength(18));
  test('changed key is DRIFT', () =>
    expect(R.find((r) => r.key === 'listen_port')).toEqual({
      key: 'listen_port',
      ok: false,
      got: '6881',
      want: '13762',
    }));
  test('unchanged keys are ok', () => expect(R.filter((r) => r.ok)).toHaveLength(17));
  test('all ok when equal', () => expect(prefsReport(W, W).filter((r) => !r.ok)).toEqual([]));
  test('a missing key reads as null', () =>
    expect(prefsReport({}, { upnp: false })).toEqual([{ key: 'upnp', ok: false, got: 'null', want: 'false' }]));
  test('newlines are shown escaped, as @tsv did', () =>
    expect(prefsReport({}, { excluded_file_names: '*.exe\n*.scr' })[0]?.want).toBe('*.exe\\n*.scr'));

  const C = { radarr: { savePath: '/mnt/data/torrents/radarr' }, sonarr: { savePath: '/wrong' } };
  const byKey = (got: Parameters<typeof categoriesReport>[0], key: string) =>
    categoriesReport(got).find((r) => r.key === key);
  test('category ok', () => expect(byKey(C, 'category radarr')?.ok).toBe(true));
  test('category moved', () => expect(byKey(C, 'category sonarr')?.ok).toBe(false));
  test('category missing', () => expect(byKey({}, 'category sonarr')).toMatchObject({ ok: false, got: '(missing)' }));
  test('manual has its own path', () =>
    expect(byKey({ manual: { savePath: '/mnt/data/torrents/manual' } }, 'category manual')?.ok).toBe(true));
});

// ─── main, against a fake qBittorrent ─────────────────────────────────────────
const ENV = { QBT_ARR_USER: 'dario', QBT_ARR_PASS: 's3cret pw' };
const TEMP = 'ZK4tTJDGK';

interface State {
  /** The WebUI login; null until one is set (first run: only the temporary password works). */
  creds: { user: string; pass: string } | null;
  prefs: Record<string, unknown>;
  cats: Record<string, { savePath: string }>;
  /** Status createCategory answers; 409 for an existing one. */
  createStatus?: number;
  loginStyle: '5.x' | '4.x';
}

function configured(): State {
  return {
    creds: { user: 'dario', pass: 's3cret pw' },
    prefs: wantPrefs(domainList('pms', ['10.0.0.50'])),
    cats: Object.fromEntries(CATEGORIES.map((c) => [c.name, { savePath: c.path }])),
    loginStyle: '5.x',
  };
}

function fresh(): State {
  return { creds: null, prefs: { listen_port: 6881, upnp: true }, cats: {}, loginStyle: '5.x' };
}

function fakeQbt(state: State) {
  const calls: (HttpRequest & { url: string })[] = [];
  const sids = new Set<string>();
  let n = 0;
  const reply = (status: number, text = '', headers: Record<string, string> = {}): HttpResponse => ({
    status,
    text,
    headers: new Headers(headers),
  });
  const http = async (url: string, req: HttpRequest): Promise<HttpResponse> => {
    calls.push({ url, ...req });
    const path = new URL(url).pathname;
    const form = new URLSearchParams(req.body instanceof URLSearchParams ? req.body : String(req.body ?? ''));
    if (path === '/api/v2/auth/login') {
      const u = form.get('username');
      const p = form.get('password');
      const ok = state.creds ? u === state.creds.user && p === state.creds.pass : u === 'admin' && p === TEMP;
      if (!ok) return state.loginStyle === '4.x' ? reply(200, 'Fails.') : reply(401);
      const sid = `sid${n++}`;
      sids.add(sid);
      const cookie = { 'Set-Cookie': `SID=${sid}; HttpOnly; path=/` };
      return state.loginStyle === '4.x' ? reply(200, 'Ok.', cookie) : reply(204, '', cookie);
    }
    const sid = req.headers?.Cookie?.replace(/^SID=/, '');
    if (!sid || !sids.has(sid) || req.headers?.Referer !== 'http://127.0.0.1:8081') return reply(403, 'Forbidden');
    switch (path) {
      case '/api/v2/app/preferences':
        return reply(200, JSON.stringify(state.prefs));
      case '/api/v2/torrents/categories':
        return reply(200, JSON.stringify(state.cats));
      case '/api/v2/app/setPreferences': {
        const set = JSON.parse(form.get('json') ?? '{}') as Record<string, unknown>;
        if ('web_ui_password' in set)
          state.creds = { user: String(set.web_ui_username), pass: String(set.web_ui_password) };
        else state.prefs = { ...state.prefs, ...set };
        return reply(200);
      }
      case '/api/v2/torrents/createCategory': {
        const name = form.get('category') ?? '';
        const status = state.createStatus ?? (name in state.cats ? 409 : 200);
        if (status === 200) state.cats[name] = { savePath: form.get('savePath') ?? '' };
        return reply(status);
      }
      case '/api/v2/torrents/editCategory':
        state.cats[form.get('category') ?? ''] = { savePath: form.get('savePath') ?? '' };
        return reply(200);
      default:
        return reply(404);
    }
  };
  return { http, calls };
}

function run(argv: string[], state: State, opts: { env?: Record<string, string>; dockerLogs?: string } = {}) {
  const fake = fakeQbt(state);
  const lines: string[] = [];
  const errs: string[] = [];
  const runs: string[][] = [];
  const code = main(argv, {
    http: fake.http,
    run: async (cmd): Promise<RunResult> => {
      runs.push([...cmd]);
      return { code: 0, stdout: opts.dockerLogs ?? '', stderr: '', timedOut: false };
    },
    log: (l) => void lines.push(l),
    err: (l) => void errs.push(l),
    hostname: () => 'pms',
    lanIps: () => ['10.0.0.50'],
    env: opts.env ?? ENV,
    repo: '/nonexistent',
  });
  return { code, lines, errs, runs, calls: fake.calls };
}

const paths = (calls: { url: string }[]) => calls.map((c) => new URL(c.url).pathname.replace('/api/v2/', ''));
const FIRST_RUN_LOG =
  'The WebUI administrator password was not set. A temporary password is provided for this session: ZK4tTJDGK\n';

describe('main', () => {
  test('--check on a configured qBittorrent: no drift, nothing written', async () => {
    const { code, lines, calls } = run(['--check'], configured());
    expect(await code).toBe(0);
    expect(lines.slice(0, 3)).toEqual([
      'qBittorrent at http://127.0.0.1:8081 (check)',
      '  logged in as dario',
      'Read-back:',
    ]);
    expect(lines).toContain('  ok     web_ui_domain_list = qbittorrent;localhost;127.0.0.1;pms;10.0.0.50');
    expect(lines).toContain(
      '  ok     excluded_file_names = *.exe\\n*.scr\\n*.bat\\n*.cmd\\n*.com\\n*.pif\\n*.lnk\\n*.msi\\n*.vbs',
    );
    expect(lines.at(-1)).toBe('No drift.');
    expect(paths(calls)).toEqual(['auth/login', 'app/preferences', 'torrents/categories']);
  });

  test('--check: drift is 1, word for word', async () => {
    const s = configured();
    s.prefs.listen_port = 6881;
    delete s.cats.manual;
    const { code, lines } = run(['--check'], s);
    expect(await code).toBe(1);
    expect(lines).toContain('  DRIFT  listen_port = 6881, want 13762');
    expect(lines).toContain('  DRIFT  category manual = (missing), want /mnt/data/torrents/manual');
    expect(lines.at(-1)).toBe('To apply: task qbittorrent:configure');
  });

  test('4.x logins (200 Ok.) work too', async () => {
    const s = configured();
    s.loginStyle = '4.x';
    expect(await run(['--check'], s).code).toBe(0);
  });

  test('the password goes in the body, never the URL or argv', async () => {
    const { code, calls, runs } = run([], fresh(), { dockerLogs: FIRST_RUN_LOG });
    expect(await code).toBe(0);
    const login = calls.filter((c) => c.url.endsWith('/auth/login')).at(-1);
    expect(String(login?.body)).toBe('username=dario&password=s3cret+pw');
    expect(calls.some((c) => c.url.includes('s3cret'))).toBe(false);
    expect(runs.flat().some((a) => a.includes('s3cret'))).toBe(false);
  });

  test('apply on a fresh container: temporary password, our login, settings, categories', async () => {
    const s = fresh();
    const { code, lines, runs } = run([], s, { dockerLogs: FIRST_RUN_LOG });
    expect(await code).toBe(0);
    expect(runs).toEqual([['docker', 'logs', 'qbittorrent']]);
    expect(lines.slice(0, 6)).toEqual([
      'qBittorrent at http://127.0.0.1:8081 (apply)',
      '  first run: logged in with the temporary password; setting dario',
      '  credentials set; logged in as dario',
      '  preferences applied',
      '  categories applied',
      'Read-back:',
    ]);
    expect(lines.at(-1)).toBe('No drift.');
    expect(s.creds).toEqual({ user: 'dario', pass: 's3cret pw' });
    expect(s.prefs.listen_port).toBe(13762);
  });

  test('apply, refused, no temporary password: 3, with the hint', async () => {
    const s = configured();
    s.creds = { user: 'dario', pass: 'other' };
    const { code, lines } = run([], s, { dockerLogs: 'WebUI will be started shortly.\n' });
    expect(await code).toBe(3);
    expect(lines.slice(-2)).toEqual([
      '  FAIL  cannot log in as dario (HTTP 401).',
      "        No temporary password in 'docker logs qbittorrent' either — is it running, or was its password set to something else?",
    ]);
  });

  test('--check, refused: 3, asked once, no docker', async () => {
    const s = configured();
    s.creds = { user: 'dario', pass: 'other' };
    const { code, lines, runs, calls } = run(['--check'], s);
    expect(await code).toBe(3);
    expect(lines.at(-1)).toBe('  FAIL  cannot log in as dario (HTTP 401).');
    expect(runs).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test('ensure_category: new → created, nothing else', async () => {
    const s = configured();
    s.cats = {};
    const { code, calls } = run([], s);
    expect(await code).toBe(0);
    expect(paths(calls).filter((p) => p.includes('Category'))).toEqual([
      'torrents/createCategory',
      'torrents/createCategory',
      'torrents/createCategory',
    ]);
  });

  test('ensure_category: exists (409) → edited', async () => {
    const s = configured();
    s.cats.sonarr = { savePath: '/old' };
    const { code, calls } = run([], s);
    expect(await code).toBe(0);
    expect(
      paths(calls)
        .filter((p) => p.includes('Category'))
        .slice(0, 2),
    ).toEqual(['torrents/createCategory', 'torrents/editCategory']);
    expect(s.cats.sonarr?.savePath).toBe('/mnt/data/torrents/sonarr');
  });

  test('ensure_category: 500 → error, no edit attempted, and only one call made', async () => {
    const s = configured();
    s.createStatus = 500;
    const { code, lines, calls } = run([], s);
    expect(await code).toBe(1);
    expect(lines.at(-1)).toBe('  FAIL  category radarr (HTTP 500)');
    expect(paths(calls).filter((p) => p.includes('Category'))).toEqual(['torrents/createCategory']);
  });

  test('no login in .env is 3, on stderr, before any request', async () => {
    const { code, errs, calls } = run(['--check'], configured(), { env: { QBT_ARR_USER: 'dario' } });
    expect(await code).toBe(3);
    expect(errs).toEqual([
      "QBT_ARR_USER and QBT_ARR_PASS must be set in /nonexistent/.env (the :8081 instance's WebUI login).",
    ]);
    expect(calls).toEqual([]);
  });

  test('a word it does not know is a usage error', async () => {
    await expect(run(['--now'], configured()).code).rejects.toThrow('usage: configure.sh [--check]');
  });

  test('-h prints the header, exit codes included', async () => {
    const { code, lines } = run(['-h'], configured());
    expect(await code).toBe(0);
    expect(lines[0]).toStartWith("apps/qbittorrent/configure.ts — apply the container qBittorrent's settings");
    expect(lines[0]).toContain('Exit: 0 applied and verified');
  });
});
