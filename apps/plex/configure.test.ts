// apps/plex/configure.test.ts — unit fixtures for apps/plex/configure.ts, and
// main against a fake Plex.
//
// Offline, and changes nothing. The live behaviour was checked on the real Plex 1.43.4:
// - GET /:/prefs with Accept: application/json returns MediaContainer.Setting[],
//   PreferredNetworkInterface among them, with value "" for Any and enumValues
//   listing the host's interfaces with their current addresses
// - PUT /:/prefs?PreferredNetworkInterface=eno1 sets it; the .env PLEX_TOKEN
//   is accepted

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpRequest, HttpResponse } from '../../stack/lib/http.ts';
import { DEFAULT_IFACE, hasChoice, ifaceAddr, main, PREF, prefChoices, prefValue } from './configure.ts';

const TMP = mkdtempSync(join(tmpdir(), 'plex-configure-test-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

/** As Plex 1.43.4 returns it, trimmed to two settings. */
function prefs(value: string) {
  return {
    MediaContainer: {
      size: 2,
      Setting: [
        { id: 'FriendlyName', type: 'text', default: '', value: 'Local PMS' },
        {
          id: 'PreferredNetworkInterface',
          label: 'Preferred network interface',
          type: 'text',
          default: '',
          value,
          advanced: true,
          group: 'network',
          enumValues: ':Any|eno1:eno1 (192.168.0.86)|wlp2s0:wlp2s0 (192.168.0.66)|docker0:docker0 (172.17.0.1)',
        },
      ],
    },
  };
}

describe('the wanted setting', () => {
  test('the wired NIC by default', () => expect(DEFAULT_IFACE).toBe('eno1'));
  test("Plex's id for it", () => expect(PREF).toBe('PreferredNetworkInterface'));
});

describe('pref_value', () => {
  test('Any is the empty value', () => expect(prefValue(prefs(''), PREF)).toBe(''));
  test('a set interface', () => expect(prefValue(prefs('eno1'), PREF)).toBe('eno1'));
  test('Any still counts as present', () => expect(prefValue(prefs(''), PREF)).not.toBeUndefined());
  test('an absent setting fails', () => expect(prefValue(prefs(''), 'NoSuchPref')).toBeUndefined());
  test('a non-JSON body fails', () => expect(prefValue(undefined, PREF)).toBeUndefined());
});

describe('pref_choices / iface_addr', () => {
  test('every offered interface, Any first', () =>
    expect(prefChoices(prefs(''), PREF)).toEqual(['', 'eno1', 'wlp2s0', 'docker0']));
  test("eno1's address", () => expect(ifaceAddr(prefs(''), PREF, 'eno1')).toBe('192.168.0.86'));
  test('wlp2s0 is not eno1', () => expect(ifaceAddr(prefs(''), PREF, 'wlp2s0')).toBe('192.168.0.66'));
  test('unknown interface → empty', () => expect(ifaceAddr(prefs(''), PREF, 'eth9')).toBe(''));
  test('eno1 is offered', () => expect(hasChoice(prefs(''), PREF, 'eno1')).toBe(true));
  test('a prefix is not a match', () => expect(hasChoice(prefs(''), PREF, 'eno')).toBe(false));
  test('a missing NIC is refused', () => expect(hasChoice(prefs(''), PREF, 'eth0')).toBe(false));
  test('no enumValues: no choices', () =>
    expect(prefChoices({ MediaContainer: { Setting: [{ id: PREF }] } }, PREF)).toEqual([]));
});

// prefs_token moved to stack/lib/plex.ts (readPlexToken); stack/lib/plex.test.ts has its cases.

// ─── main, against a fake Plex ────────────────────────────────────────────────
type Reply = { status: number; json?: unknown };

/** A fake Plex: /identity, and /:/prefs whose value the PUT changes. */
function fakePlex(opts: { value?: string; status?: Partial<Record<string, number>> } = {}) {
  let value = opts.value ?? 'eno1';
  const calls: (HttpRequest & { url: string })[] = [];
  const http = async (url: string, req: HttpRequest): Promise<HttpResponse> => {
    calls.push({ url, ...req });
    const u = new URL(url);
    const key = `${req.method ?? 'GET'} ${u.pathname}`;
    let r: Reply;
    const forced = opts.status?.[key];
    if (forced !== undefined) r = { status: forced };
    else if (key === 'GET /identity') r = { status: 200, json: { MediaContainer: { version: '1.43.4.10010' } } };
    else if (key === 'GET /:/prefs') r = { status: 200, json: prefs(value) };
    else if (key === 'PUT /:/prefs') {
      value = u.searchParams.get(PREF) ?? value;
      r = { status: 200 };
    } else r = { status: 404 };
    return { status: r.status, text: r.json === undefined ? '' : JSON.stringify(r.json), headers: new Headers() };
  };
  return { http, calls, value: () => value };
}

function run(argv: string[], plex: ReturnType<typeof fakePlex>, env: Record<string, string> = { PLEX_TOKEN: 'pt' }) {
  const lines: string[] = [];
  const errs: string[] = [];
  let clock = 0;
  const code = main(argv, {
    http: plex.http,
    log: (l) => void lines.push(l),
    err: (l) => void errs.push(l),
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    env,
    repo: '/nonexistent',
  });
  return { code, lines, errs };
}

describe('main', () => {
  test('--check, pinned: no drift', async () => {
    const { code, lines } = run(['--check'], fakePlex());
    expect(await code).toBe(0);
    expect(lines).toEqual([
      'Plex at http://127.0.0.1:32400 (check)',
      '  up: 1.43.4.10010',
      'Read-back:',
      '  ok       preferred network interface: eno1 (192.168.0.86)',
      'No drift.',
    ]);
  });

  test('--check on Any: drift, word for word, and nothing written', async () => {
    const plex = fakePlex({ value: '' });
    const { code, lines } = run(['--check'], plex);
    expect(await code).toBe(1);
    expect(lines.slice(-3)).toEqual([
      'Read-back:',
      '  DRIFT    preferred network interface: Any, want eno1',
      'To apply: task plex:configure',
    ]);
    expect(plex.calls.filter((c) => c.method === 'PUT')).toEqual([]);
  });

  test('apply on Any: sets it, then reads it back', async () => {
    const plex = fakePlex({ value: '' });
    const { code, lines } = run([], plex);
    expect(await code).toBe(0);
    expect(lines).toContain('  interface set: Any → eno1');
    expect(lines.at(-1)).toBe('No drift.');
    expect(plex.value()).toBe('eno1');
  });

  test('apply, already pinned: nothing written', async () => {
    const plex = fakePlex();
    const { code, lines } = run([], plex);
    expect(await code).toBe(0);
    expect(lines).toContain('  interface already eno1');
    expect(plex.calls.filter((c) => c.method === 'PUT')).toEqual([]);
  });

  test('the token goes in a header, never the URL', async () => {
    const plex = fakePlex({ value: '' });
    await run([], plex).code;
    expect(plex.calls.every((c) => c.headers?.['X-Plex-Token'] === 'pt' && !c.url.includes('pt'))).toBe(true);
    expect(plex.calls.every((c) => c.headers?.Accept === 'application/json')).toBe(true);
  });

  test('an interface Plex does not offer is 3', async () => {
    const { code, lines } = run(['--check'], fakePlex(), { PLEX_TOKEN: 'pt', PLEX_IFACE: 'eth0' });
    expect(await code).toBe(3);
    expect(lines.at(-1)).toBe('  FAIL  Plex offers no interface eth0 (has: eno1 wlp2s0 docker0)');
  });

  test('a refused token is 3', async () => {
    const { code, lines } = run(['--check'], fakePlex({ status: { 'GET /:/prefs': 401 } }));
    expect(await code).toBe(3);
    expect(lines.at(-1)).toBe('  FAIL  read prefs (HTTP 401)');
  });

  test('another failed read is 1', async () => {
    const { code } = run(['--check'], fakePlex({ status: { 'GET /:/prefs': 500 } }));
    expect(await code).toBe(1);
  });

  test('a refused write is 1', async () => {
    const { code, lines } = run([], fakePlex({ value: '', status: { 'PUT /:/prefs': 400 } }));
    expect(await code).toBe(1);
    expect(lines.at(-1)).toBe('  FAIL  write PreferredNetworkInterface (HTTP 400)');
  });

  test('not answering is 3 after PLEX_WAIT, every 3 s', async () => {
    const plex = fakePlex({ status: { 'GET /identity': 0 } });
    const { code, lines } = run(['--check'], plex, { PLEX_TOKEN: 'pt', PLEX_WAIT: '9', PLEX_URL: 'http://plex:32400' });
    expect(await code).toBe(3);
    expect(plex.calls).toHaveLength(4); // at 0, 3, 6 and 9 s
    expect(lines.at(-1)).toBe('  FAIL  not answering at http://plex:32400 — is it running?');
  });

  test('PLEX_TIMEOUT is per request, in seconds', async () => {
    const plex = fakePlex();
    await run(['--check'], plex, { PLEX_TOKEN: 'pt', PLEX_TIMEOUT: '4' }).code;
    expect(plex.calls.every((c) => c.timeoutMs === 4000)).toBe(true);
  });

  test("no PLEX_TOKEN: the server's own, from Preferences.xml", async () => {
    const path = join(TMP, 'Preferences.xml');
    writeFileSync(path, '<Preferences MachineIdentifier="abc" PlexOnlineToken="own-tok"/>\n');
    const plex = fakePlex();
    expect(await run(['--check'], plex, { PLEX_PREFS: path }).code).toBe(0);
    expect(plex.calls[0]?.headers?.['X-Plex-Token']).toBe('own-tok');
  });

  test('no token anywhere is 3, on stderr, before any request', async () => {
    const plex = fakePlex();
    const { code, errs } = run(['--check'], plex, { PLEX_PREFS: join(TMP, 'none.xml') });
    expect(await code).toBe(3);
    expect(errs).toEqual([`No Plex token: set PLEX_TOKEN in /nonexistent/.env, or check ${join(TMP, 'none.xml')}.`]);
    expect(plex.calls).toEqual([]);
  });

  test('a word it does not know is a usage error', async () => {
    await expect(run(['--apply'], fakePlex()).code).rejects.toThrow('usage: configure.sh [--check]');
  });

  test('-h prints the header, exit codes included', async () => {
    const { code, lines } = run(['-h'], fakePlex());
    expect(await code).toBe(0);
    expect(lines[0]).toStartWith('apps/plex/configure.ts — pin Plex to the wired interface');
    expect(lines[0]).toContain('Exit: 0 applied and verified (or no drift)');
  });
});
