// apps/plex/configure.ts — pin Plex to the wired interface through its API, then
// read it back. Idempotent.
//
//   apps/plex/configure.sh            apply, then verify
//   apps/plex/configure.sh --check    verify only; changes nothing
//
// Normally run as `task plex:configure` / `task plex:check`.
//
// Until 2026-10-17 the box had two NICs on one subnet, both on DHCP: eno1
// (wired) and wlp2s0 (Wi-Fi). With "Preferred network interface" on Any, Plex
// advertised both addresses, and clients picked the Wi-Fi one as often as not.
// The box is wired-only now, at a reserved address (10.0.0.50), and the pin
// stays: it names the interface, not an address, so a NIC added later or a
// moved address can't change what Plex offers local clients.
//
// This is the only Plex setting the repo owns; everything else stays in Plex's
// own UI. The token is PLEX_TOKEN from .env, or else the server's own
// PlexOnlineToken from its Preferences.xml.
//
// Exit: 0 applied and verified (or no drift) · 1 drift, or a step failed ·
// 2 usage · 3 not reachable, no token, or the interface does not exist.

import { resolve } from 'node:path';
import { headerHelp, parseCli } from '../../stack/lib/cli.ts';
import { envGet, envSeconds, type Env } from '../../stack/lib/env.ts';
import { runMain } from '../../stack/lib/exit.ts';
import { httpCode, is2xx, jsonOf, makeHttp, type Http, type HttpResponse } from '../../stack/lib/http.ts';
import { err, out, type Log } from '../../stack/lib/log.ts';
import { plexPrefsPath, readPlexToken } from '../../stack/lib/plex.ts';

// ─── the setting ──────────────────────────────────────────────────────────────
export const DEFAULT_IFACE = 'eno1';
export const PREF = 'PreferredNetworkInterface';

// What GET /:/prefs (Accept: application/json) returns, as far as this reads it.
export interface PlexSetting {
  id: string;
  value?: unknown;
  /** ":Any|eno1:eno1 (192.168.0.86)|…" */
  enumValues?: string;
}

// ─── pure helpers (apps/plex/configure.test.ts) ──────────────────────────────

function settingsOf(prefs: unknown): PlexSetting[] {
  const list = (prefs as { MediaContainer?: { Setting?: unknown } } | null | undefined)?.MediaContainer?.Setting;
  return Array.isArray(list) ? (list as PlexSetting[]) : [];
}

/** The value of one setting in a /:/prefs response; undefined when absent ("" is Any, and present). */
export function prefValue(prefs: unknown, id: string): string | undefined {
  const v = settingsOf(prefs).find((s) => s.id === id)?.value;
  if (v === undefined || v === null || v === false) return undefined;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function enumEntries(prefs: unknown, id: string): string[] {
  const values = settingsOf(prefs).find((s) => s.id === id)?.enumValues ?? '';
  return values === '' ? [] : values.split('|');
}

/** The interfaces Plex offers for the setting, in its order ("" is Any). */
export function prefChoices(prefs: unknown, id: string): string[] {
  return enumEntries(prefs, id).map((e) => e.split(':')[0] ?? '');
}

/** The address Plex lists for an interface, e.g. 192.168.0.86; "" when none. */
export function ifaceAddr(prefs: unknown, id: string, iface: string): string {
  for (const e of enumEntries(prefs, id)) {
    if (!e.startsWith(`${iface}:`)) continue;
    const m = /\(([^)]*)\)/.exec(e);
    if (m) return m[1] ?? '';
  }
  return '';
}

export const hasChoice = (prefs: unknown, id: string, iface: string) => prefChoices(prefs, id).includes(iface);

// ─── main ─────────────────────────────────────────────────────────────────────

export interface Deps {
  http: Http;
  log: Log;
  /** Where the usage-free errors go: the missing token. */
  err: Log;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  env: Env;
  /** The tree whose .env holds PLEX_TOKEN and APPDATA: the install, or a source. */
  repo: string;
}

export async function main(argv: readonly string[], deps: Deps): Promise<number> {
  const { env, log, repo } = deps;
  const cli = parseCli(argv, { flags: ['--check'], usage: 'usage: configure.sh [--check]' });
  if (cli.help) {
    log(headerHelp(await Bun.file(import.meta.path).text()));
    return 0;
  }
  const mode = cli.flags['--check'] ? 'check' : 'apply';

  const appdata = envGet('APPDATA', { repo, env }) || '/opt/appdata';
  const url = env.PLEX_URL || 'http://127.0.0.1:32400';
  const prefsPath = env.PLEX_PREFS || plexPrefsPath(appdata);
  const timeoutMs = envSeconds(env, 'PLEX_TIMEOUT', 15);
  const waitMs = envSeconds(env, 'PLEX_WAIT', 90);
  const iface = env.PLEX_IFACE || DEFAULT_IFACE;
  const token = envGet('PLEX_TOKEN', { repo, env }) || readPlexToken(prefsPath);
  if (!token) {
    deps.err(`No Plex token: set PLEX_TOKEN in ${repo}/.env, or check ${prefsPath}.`);
    return 3;
  }

  // The token goes in a header, never the URL.
  const px = (method: string, path: string): Promise<HttpResponse> =>
    deps.http(`${url}${path}`, {
      method,
      headers: { 'X-Plex-Token': token, Accept: 'application/json' },
      timeoutMs,
    });

  log(`Plex at ${url} (${mode})`);
  const deadline = deps.now() + waitMs;
  let identity = await px('GET', '/identity');
  while (!is2xx(identity.status)) {
    if (deps.now() >= deadline) {
      log(`  FAIL  not answering at ${url} — is it running?`);
      return 3;
    }
    await deps.sleep(3000);
    identity = await px('GET', '/identity');
  }
  const about = jsonOf(identity) as { MediaContainer?: { version?: unknown } } | undefined;
  log(`  up: ${about === undefined ? '' : String(about?.MediaContainer?.version ?? '?')}`);

  // Plex lists the host's interfaces as the setting's choices. One that is
  // missing (renamed NIC, unplugged at boot) would leave Plex on nothing.
  const first = await px('GET', '/:/prefs');
  if (!is2xx(first.status)) {
    log(`  FAIL  read prefs (HTTP ${httpCode(first.status)})`);
    return first.status === 401 ? 3 : 1;
  }
  if (!hasChoice(jsonOf(first), PREF, iface)) {
    const has = prefChoices(jsonOf(first), PREF).filter(Boolean).join(' ');
    log(`  FAIL  Plex offers no interface ${iface} (has: ${has})`);
    return 3;
  }

  if (mode === 'apply') {
    const r = await px('GET', '/:/prefs');
    if (!is2xx(r.status)) {
      log(`  FAIL  read prefs (HTTP ${httpCode(r.status)})`);
      return 1;
    }
    const got = prefValue(jsonOf(r), PREF);
    if (got === undefined) {
      log(`  FAIL  no ${PREF} in /:/prefs`);
      return 1;
    }
    if (got === iface) log(`  interface already ${iface}`);
    else {
      const w = await px('PUT', `/:/prefs?${PREF}=${encodeURIComponent(iface)}`);
      if (!is2xx(w.status)) {
        log(`  FAIL  write ${PREF} (HTTP ${httpCode(w.status)})`);
        return 1;
      }
      log(`  interface set: ${got || 'Any'} → ${iface}`);
    }
  }

  log('Read-back:');
  const r = await px('GET', '/:/prefs');
  if (!is2xx(r.status)) {
    log(`  FAIL  read prefs (HTTP ${httpCode(r.status)})`);
    return 1;
  }
  const prefs = jsonOf(r);
  const got = prefValue(prefs, PREF);
  if (got === undefined) {
    log(`  FAIL  no ${PREF} in /:/prefs`);
    return 1;
  }
  if (got === iface) {
    log(`  ok       preferred network interface: ${iface} (${ifaceAddr(prefs, PREF, iface)})`);
    log('No drift.');
    return 0;
  }
  log(`  DRIFT    preferred network interface: ${got || 'Any'}, want ${iface}`);
  if (mode === 'check') log('To apply: task plex:configure');
  return 1;
}

if (import.meta.main) {
  await runMain(() =>
    main(Bun.argv.slice(2), {
      http: makeHttp(),
      log: out,
      err,
      sleep: (ms) => Bun.sleep(ms),
      now: () => Date.now(),
      env: process.env,
      repo: resolve(import.meta.dir, '../..'),
    }),
  );
}
