// apps/qbittorrent/configure.ts — apply the container qBittorrent's settings through its
// WebUI API, then read them back. Idempotent: re-running changes nothing.
//
//   apps/qbittorrent/configure.sh            set credentials (first run), settings, categories; verify
//   apps/qbittorrent/configure.sh --check    read back and report drift only; changes nothing
//
// Normally run as `task qbittorrent:configure` / `task qbittorrent:check`.
//
// This is the container instance on :8081 that Radarr and Sonarr use — the
// only one since Phase 7a retired pms-local's native qbittorrent-nox (:8080).
//
// The settings live below as data, so a reinstall gets exactly these in one
// command. docs/phases.md points here rather than repeating them.
//
// First run on a fresh container: qBittorrent has no password yet and prints a
// temporary one in its log. The script reads it, logs in as admin, and sets
// QBT_ARR_USER / QBT_ARR_PASS from .env; every later run logs in with those.
// Passwords travel in request bodies — never in argv, a URL or a log line.
//
// Exit: 0 applied and verified (or no drift) · 1 drift, or a step failed ·
// 2 usage · 3 cannot log in / not configured.

import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { headerHelp, parseCli } from '../../stack/lib/cli.ts';
import { envGet, envSeconds, type Env } from '../../stack/lib/env.ts';
import { runMain } from '../../stack/lib/exit.ts';
import { httpCode, is2xx, jsonOf, makeHttp, type Http } from '../../stack/lib/http.ts';
import { err, out, type Log } from '../../stack/lib/log.ts';
import { lanIps } from '../../stack/lib/net.ts';
import { qbtLogin, type QbtSession } from '../../stack/lib/qbittorrent.ts';
import { run, type Run } from '../../stack/lib/run.ts';
import { jsonEqual } from '../../stack/lib/servarr.ts';
import { excludedNames } from './excluded.ts';

const TORRENTS = '/mnt/data/torrents';

// ─── the settings ─────────────────────────────────────────────────────────────

/**
 * Categories: name → save path. With automatic torrent management on, a
 * torrent Radarr adds under "radarr" lands in its category's path.
 *
 * "manual" is for torrents added by hand in the WebUI. Radarr and Sonarr list
 * only their own category, Decluttarr sees only their queues, and arr-reclaim
 * only radarr/sonarr, so nothing imports, replaces or removes these. They seed
 * to the share limits below, stop, and stay until deleted by hand. Adding one
 * under radarr/sonarr instead puts it in that app's queue, where Decluttarr can
 * replace it if it crawls.
 */
export const CATEGORIES: readonly { name: string; path: string }[] = [
  { name: 'radarr', path: `${TORRENTS}/radarr` },
  { name: 'sonarr', path: `${TORRENTS}/sonarr` },
  { name: 'manual', path: `${TORRENTS}/manual` },
];

/**
 * Host header validation stays on; these are the names it accepts.
 *   qbittorrent  — Radarr/Sonarr on the arr network (Phase 4)
 *   127.0.0.1    — this script. Leave it out and the first setPreferences
 *                  locks the script out of every call after it.
 */
export function domainList(host: string, lan: readonly string[]): string {
  return ['qbittorrent', 'localhost', '127.0.0.1', host, ...lan].join(';');
}

export function wantPrefs(domains: string): Record<string, unknown> {
  return {
    save_path: TORRENTS,
    temp_path_enabled: true,
    temp_path: `${TORRENTS}/.incomplete-arr`,
    auto_tmm_enabled: true,
    autorun_enabled: false,
    listen_port: 13762,
    upnp: false,
    max_ratio_enabled: true,
    max_ratio: 2,
    max_seeding_time_enabled: true,
    max_seeding_time: 20160,
    max_ratio_act: 0,
    dl_limit: 67108864,
    dont_count_slow_torrents: true,
    web_ui_host_header_validation_enabled: true,
    web_ui_domain_list: domains,
    excluded_file_names_enabled: true,
    excluded_file_names: excludedNames(),
  };
}
// Seeding: ratio 2.0 or 14 days (20160 min), whichever comes first, then the
// torrent STOPS (max_ratio_act 0 — no ShareLimitAction line in the conf; 1 is
// Remove and 3 RemoveWithContent, checked on 5.2.3). Stopping rather than
// removing leaves the removal to Radarr/Sonarr's "Remove Completed", which also
// tidies their queue. The library copy is its own hardlink and stays.
//
// Deleting in Plex does not wait for this: arr-reclaim removes the torrent of
// an imported file once its last library link is gone.
//
// Download limit 64 MiB/s (bytes/s here, ~537 Mbit/s): just under what the 600
// Mbit/s line can carry as payload (75 MB/s raw, ~66-68 MiB/s after TCP/IP and
// BitTorrent overhead), so it costs about 5%. It is what lets Decluttarr's
// remove_slow tell a thin swarm from a busy line: it pauses itself while
// qBittorrent runs above 80% of this limit (~51 MiB/s), and with no limit it
// assumes infinite capacity and never pauses (apps/decluttarr/config.yaml). Set it
// above what the line delivers and that pause never comes.
// dont_count_slow_torrents: a download stuck under 2 KiB/s stops holding one of
// the 3 active slots, so the queue behind it keeps moving until it is replaced.
//
// Excluded file names (excluded.ts): on 2026-10-08 "Scrubs 2026 S02E04 …
// H264-CAKES" was one 886 MB Windows .exe, a week before the episode aired.
// Sonarr refused the import, but qBittorrent had already seeded 763 MB of it.
// Matching ignores case (*.exe skips X.EXE), and a release with a video beside
// an .exe (RARBG's marker) still imports, minus the .exe. A fake that is ONLY an
// executable now finishes empty, and Sonarr/Radarr report "No files found are
// eligible for import in …/X.exe". Decluttarr's remove_failed_imports removes
// and blocklists that, and the app searches again. All checked on a throwaway
// qBittorrent 5.2.4 and Sonarr 4.0.20.

// ─── pure helpers (apps/qbittorrent/configure.test.ts) ───────────────────────

/** The temporary password qBittorrent prints while none is set: the last one in its log. */
export function tempPasswordOf(logs: string): string {
  let found = '';
  for (const line of logs.split('\n')) {
    const m = /temporary password is provided for this session: (\S*)/.exec(line);
    if (m) found = m[1] ?? '';
  }
  return found;
}

/** jq's tostring inside @tsv: strings raw, the rest JSON, tabs and newlines escaped. */
function shown(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? null);
  return s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

export interface ReportLine {
  key: string;
  ok: boolean;
  got: string;
  want: string;
}

/** One line per wanted preference, in want's order. */
export function prefsReport(got: Record<string, unknown>, want: Record<string, unknown>): ReportLine[] {
  return Object.entries(want).map(([key, value]) => ({
    key,
    ok: jsonEqual(got[key] ?? null, value),
    got: shown(got[key]),
    want: shown(value),
  }));
}

/** One line per category: its save path, or "(missing)". */
export function categoriesReport(got: Record<string, { savePath?: unknown } | undefined>): ReportLine[] {
  return CATEGORIES.map(({ name, path }) => {
    const sp = got[name]?.savePath;
    const have = sp === undefined || sp === null || sp === false ? '(missing)' : shown(sp);
    return { key: `category ${name}`, ok: have === path, got: have, want: path };
  });
}

// ─── main ─────────────────────────────────────────────────────────────────────

export interface Deps {
  http: Http;
  run: Run;
  log: Log;
  err: Log;
  hostname: () => string;
  lanIps: () => string[];
  env: Env;
  /** The tree whose .env holds QBT_ARR_USER / QBT_ARR_PASS: the install, or a source. */
  repo: string;
}

async function verify(s: QbtSession, want: Record<string, unknown>, log: Log): Promise<boolean> {
  const prefs = await s.get('/api/v2/app/preferences');
  if (!is2xx(prefs.status)) {
    log(`  FAIL  cannot read preferences (HTTP ${httpCode(prefs.status)})`);
    return false;
  }
  const cats = await s.get('/api/v2/torrents/categories');
  if (!is2xx(cats.status)) {
    log(`  FAIL  cannot read categories (HTTP ${httpCode(cats.status)})`);
    return false;
  }
  const report = [
    ...prefsReport((jsonOf(prefs) ?? {}) as Record<string, unknown>, want),
    ...categoriesReport((jsonOf(cats) ?? {}) as Record<string, { savePath?: unknown }>),
  ];
  let ok = true;
  for (const r of report) {
    if (r.ok) log(`  ok     ${r.key} = ${r.got}`);
    else {
      log(`  DRIFT  ${r.key} = ${r.got}, want ${r.want}`);
      ok = false;
    }
  }
  return ok;
}

export async function main(argv: readonly string[], deps: Deps): Promise<number> {
  const { env, log, repo } = deps;
  const cli = parseCli(argv, { flags: ['--check'], usage: 'usage: configure.sh [--check]' });
  if (cli.help) {
    log(headerHelp(await Bun.file(import.meta.path).text()));
    return 0;
  }
  const mode = cli.flags['--check'] ? 'check' : 'apply';

  const url = env.QBT_ARR_URL || 'http://127.0.0.1:8081';
  const user = envGet('QBT_ARR_USER', { repo, env });
  const pass = envGet('QBT_ARR_PASS', { repo, env });
  const container = env.QBT_CONTAINER || 'qbittorrent';
  const timeoutMs = envSeconds(env, 'QBT_TIMEOUT', 10);
  if (!user || !pass) {
    deps.err(`QBT_ARR_USER and QBT_ARR_PASS must be set in ${repo}/.env (the :8081 instance's WebUI login).`);
    return 3;
  }

  // The last status, as bash's $HTTP: what the failure line reports.
  let last = 0;
  const http: Http = async (u, req) => {
    const r = await deps.http(u, req);
    last = r.status;
    return r;
  };
  const login = (u: string, p: string) => qbtLogin(http, { url, user: u, pass: p, timeoutMs });

  // First run: log in with the temporary password and set ours.
  const bootstrap = async (): Promise<QbtSession | undefined> => {
    const logs = await deps.run(['docker', 'logs', container], { timeoutMs: 30_000 });
    const tmp = tempPasswordOf(logs.stdout + logs.stderr);
    if (!tmp) return undefined;
    const admin = await login('admin', tmp);
    if (admin.kind !== 'ok') return undefined;
    log(`  first run: logged in with the temporary password; setting ${user}`);
    const set = await admin.session.post('/api/v2/app/setPreferences', {
      json: JSON.stringify({ web_ui_username: user, web_ui_password: pass }),
    });
    if (!is2xx(set.status)) return undefined;
    const ours = await login(user, pass);
    return ours.kind === 'ok' ? ours.session : undefined;
  };

  log(`qBittorrent at ${url} (${mode})`);
  let session: QbtSession | undefined;
  const first = await login(user, pass);
  if (first.kind === 'ok') {
    session = first.session;
    log(`  logged in as ${user}`);
  } else if (mode === 'apply' && (session = await bootstrap())) {
    log(`  credentials set; logged in as ${user}`);
  } else {
    log(`  FAIL  cannot log in as ${user} (HTTP ${httpCode(last)}).`);
    if (mode !== 'check') {
      log(
        `        No temporary password in 'docker logs ${container}' either — is it running, or was its password set to something else?`,
      );
    }
    return 3;
  }

  const want = wantPrefs(domainList(deps.hostname(), deps.lanIps()));
  if (mode === 'apply') {
    const set = await session.post('/api/v2/app/setPreferences', { json: JSON.stringify(want) });
    if (!is2xx(set.status)) {
      log(`  FAIL  setPreferences (HTTP ${httpCode(set.status)})`);
      return 1;
    }
    log('  preferences applied');
    // Create, or on 409 (exists) edit, so a changed path is applied too.
    for (const { name, path } of CATEGORIES) {
      const form = { category: name, savePath: path };
      let r = await session.post('/api/v2/torrents/createCategory', form);
      if (r.status === 409) r = await session.post('/api/v2/torrents/editCategory', form);
      if (!is2xx(r.status)) {
        log(`  FAIL  category ${name} (HTTP ${httpCode(r.status)})`);
        return 1;
      }
    }
    log('  categories applied');
  }

  log('Read-back:');
  if (await verify(session, want, log)) {
    log('No drift.');
    return 0;
  }
  if (mode === 'check') log('To apply: task qbittorrent:configure');
  return 1;
}

if (import.meta.main) {
  await runMain(() =>
    main(Bun.argv.slice(2), {
      http: makeHttp(),
      run,
      log: out,
      err,
      hostname,
      lanIps: () => lanIps(),
      env: process.env,
      repo: resolve(import.meta.dir, '../..'),
    }),
  );
}
