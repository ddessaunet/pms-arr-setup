// jobs/stack-status/stack-status.test.ts — fixtures for stack-status.ts, and the
// names it shares with the rest of the repo.
//
//   bun test ./jobs/stack-status
//   UPDATE_GOLDEN=1 bun test ./jobs/stack-status   rewrite testdata/status.golden.json
//
// Offline, and changes nothing outside a scratch folder: docker, systemctl,
// journalctl, df, ip and the HTTP calls are stood in for.
// testdata/status.golden.json is also what the docs site's own test parses: the
// contract between this job and the page. It was written by the bash version of
// this job, and this one must still match it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { HttpRequest, HttpResponse } from '../../stack/lib/http.ts';
import type { RunOptions, RunResult } from '../../stack/lib/run.ts';
import {
  APP_PORT,
  bazarrProbe,
  classifyApp,
  classifyDeployDrift,
  classifyDisk,
  classifyDrift,
  classifyLan,
  classifyTimer,
  classifyStackApi,
  classifyWatcher,
  containersJson,
  DRIFT_APPS,
  envSecretValues,
  isNamedSecret,
  leaks,
  LOG_UNITS,
  logSource,
  main,
  parseShow,
  PLEX_IDENTITY,
  plexProbe,
  publish,
  qbtProbe,
  redact,
  REDACTED,
  secretsList,
  seerrProbe,
  servarrProbe,
  STALE_AFTER,
  STATUS_APPS,
  TIMERS,
  unclassifiedKeys,
  type AppInput,
  type Deps,
  type Fetched,
  type Item,
} from './stack-status.ts';

const ROOT = resolve(import.meta.dir, '../..');
const savedTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'UTC';
});
const SCRATCH = mkdtempSync(join(tmpdir(), 'stack-status-test-'));
afterAll(() => {
  process.env.TZ = savedTz;
  rmSync(SCRATCH, { recursive: true, force: true });
});
const NOW = 1791500000; // 2026-10-08T22:53:20Z

// ─── secrets ─────────────────────────────────────────────────────────────────
const ENV_TEXT = `PUID=1000
TZ=America/Argentina/Buenos_Aires
APPDATA=/opt/appdata
RADARR_API_KEY=abc123def456
QBT_ARR_USER=dario
QBT_ARR_PASS=p@ss/w+rd&x
PLEX_CLAIM="claim-xyz"
SHORT_KEY=ab
MYSTERY=some-long-value-here
MYSTERY_SHORT=true`;
const SJ = secretsList(envSecretValues(ENV_TEXT));

describe('secrets', () => {
  test('unclassified keys are reported', () =>
    expect(unclassifiedKeys(ENV_TEXT)).toEqual(['MYSTERY', 'MYSTERY_SHORT']));
  test('values masked: named 4+, unknown 8+, quotes stripped', () =>
    expect(envSecretValues(ENV_TEXT)).toEqual(['abc123def456', 'p@ss/w+rd&x', 'claim-xyz', 'some-long-value-here']));
  test('with URL-encoded forms, longest first', () =>
    expect(SJ).toEqual(['some-long-value-here', 'p%40ss%2Fw%2Brd%26x', 'abc123def456', 'p@ss/w+rd&x', 'claim-xyz']));
  test('every .env.example key is classified (secret by name, or public)', () =>
    expect(unclassifiedKeys(readFileSync(join(ROOT, '.env.example'), 'utf8'))).toEqual([]));
  test('passwords and keys are secret by name', () =>
    expect(['QBT_ARR_PASS', 'RADARR_API_KEY', 'PLEX_TOKEN', 'PLEX_CLAIM'].filter(isNamedSecret)).toHaveLength(4));
});

// ─── redaction ───────────────────────────────────────────────────────────────
describe('redact / leaks', () => {
  const DOC = {
    a: 'key abc123def456 in a line',
    b: ['url ?pw=p%40ss%2Fw%2Brd%26x&x=1', { c: 'pass p@ss/w+rd&x here' }],
    d: 'GET /library?X-Plex-Token=tok123abc&x=1',
    e: 'apikey=zzz999 and api_key: yyy888',
    f: '{"password":"hunter22"}',
    g: 'Authorization: Bearer eyJabc.def',
    h: 'The WebUI temporary password is provided for this session: Tmp9pass',
    i: 'proxy http://user:pw@host:8080/x',
    j: 'PlexOnlineToken="ptok-1"',
    k: 'Cookie: SID=abc; other',
    l: 'token bucket full, /opt/appdata/plex, claim-xyz',
    m: 'some-long-value-here',
  };
  const R = redact(DOC, SJ) as Record<string, unknown>;
  const text = JSON.stringify(R);
  for (const s of [
    'abc123def456',
    'p%40ss%2Fw%2Brd%26x',
    'p@ss/w+rd&x',
    'tok123abc',
    'zzz999',
    'yyy888',
    'hunter22',
    'eyJabc',
    'Tmp9pass',
    'user:pw',
    'ptok-1',
    'SID=abc',
    'claim-xyz',
    'some-long-value-here',
  ])
    test(`masked: ${s}`, () => expect(text.includes(s)).toBe(false));
  test('benign text survives', () => expect(String(R.l)).toContain('token bucket full, /opt/appdata/plex'));
  test('still valid JSON, same shape', () => expect(Object.keys(R).join(' ')).toBe('a b d e f g h i j k l m'));
  test('no leaks after redaction', () => expect(leaks(text, SJ)).toBe(0));
  test('leaks are counted before it', () => expect(leaks(JSON.stringify(DOC), SJ)).toBeGreaterThan(0));
  test('no secrets → no leaks (grep -F with no patterns)', () => expect(leaks(JSON.stringify(DOC), [])).toBe(0));
  test('each pattern masks what follows and keeps what names it', () =>
    expect([R.d, R.i, R.k]).toEqual([
      `GET /library?X-Plex-Token=${REDACTED}&x=1`,
      `proxy http://${REDACTED}@host:8080/x`,
      `Cookie: ${REDACTED}`,
    ]));
  test('leaks count each occurrence, longest first where two start together', () =>
    expect(leaks('aaaa-bbbb aaaa', ['aaaa', 'aaaa-bbbb'])).toBe(2));
});

// ─── containers ──────────────────────────────────────────────────────────────
const INSPECT = [
  {
    Name: '/radarr',
    RestartCount: 0,
    Config: { Image: 'x' },
    State: {
      Status: 'running',
      Running: true,
      Restarting: false,
      StartedAt: '2026-10-08T18:00:00.123456789Z',
      ExitCode: 0,
    },
    NetworkSettings: { Networks: { arr: { IPAddress: '172.19.0.5' } } },
  },
  {
    Name: '/sonarr',
    RestartCount: 2,
    Config: { Image: 'x' },
    State: { Status: 'running', Running: true, Restarting: false, StartedAt: '2026-10-08T22:50:00Z', ExitCode: 0 },
    NetworkSettings: { Networks: {} },
  },
  {
    Name: '/seerr',
    RestartCount: 0,
    Config: { Image: 'x' },
    State: { Status: 'exited', Running: false, Restarting: false, StartedAt: '2026-10-08T18:00:00Z', ExitCode: 137 },
    NetworkSettings: { Networks: {} },
  },
  {
    Name: '/decluttarr',
    RestartCount: 0,
    Config: { Image: 'x' },
    State: {
      Status: 'running',
      Running: true,
      Restarting: false,
      StartedAt: '2026-10-08T18:00:00Z',
      ExitCode: 0,
      Health: { Status: 'unhealthy' },
    },
    NetworkSettings: { Networks: {} },
  },
  {
    Name: '/bazarr',
    RestartCount: 5,
    Config: { Image: 'x' },
    State: { Status: 'restarting', Running: true, Restarting: true, StartedAt: '2026-10-08T22:53:00Z', ExitCode: 1 },
    NetworkSettings: { Networks: {} },
  },
];
const C = containersJson(JSON.stringify(INSPECT));

describe('containers_json', () => {
  test('keyed by name', () => expect(Object.keys(C).sort().join(' ')).toBe('bazarr decluttarr radarr seerr sonarr'));
  test('health and IPs', () => expect(`${C.decluttarr?.health} ${C.radarr?.ips[0]}`).toBe('unhealthy 172.19.0.5'));
  test('garbage → {}', () => expect(containersJson('not json')).toEqual({}));
});

// ─── probes ──────────────────────────────────────────────────────────────────
const H = JSON.stringify([
  { source: 'IndexerStatusCheck', type: 'warning', message: 'Indexers unavailable: 1337x' },
  { source: 'UpdateCheck', type: 'notice', message: 'New update' },
  { source: 'X', type: 'ok', message: 'fine' },
]);
const P = servarrProbe(200, 0.041, H, '{"version":"6.4.4"}', 7878);
const ID_OK = `<MediaContainer size="0" apiVersion="1.0" machineIdentifier="${PLEX_IDENTITY}" version="1.43.4"></MediaContainer>`;

describe('probes', () => {
  test('servarr: warning degrades, notice informs, ok is dropped', () =>
    expect(P.reasons.map((r) => `${r.level}:${r.text}`).join('|')).toBe(
      'degraded:IndexerStatusCheck: Indexers unavailable: 1337x|notice:UpdateCheck: New update',
    ));
  test('servarr: version and ms', () => expect(`${P.version} ${P.ms}`).toBe('6.4.4 41'));
  test('servarr: 401 → key refused', () =>
    expect(servarrProbe(401, 0, '', '', 7878).reasons[0]?.level).toBe('degraded'));
  test('servarr: nothing answering → down', () =>
    expect(servarrProbe(0, 0, '', '', 7878).down).toBe('not answering on :7878'));
  test('servarr: 503 → down', () => expect(servarrProbe(503, 0, '', '', 7878).down).toBe('HTTP 503'));
  test('bazarr: each issue degrades', () =>
    expect(
      bazarrProbe(
        200,
        0,
        '{"data":[{"object":"radarr","issue":"not reachable"}]}',
        '{"data":{"bazarr_version":"1.6.2"}}',
      ).reasons.map((r) => `${r.level}:${r.text}`),
    ).toEqual(['degraded:radarr: not reachable']));
  test('seerr: restartRequired degrades', () => {
    const s = seerrProbe(200, 0, '{"version":"3.5.0","restartRequired":true}');
    expect(`${s.reasons[0]?.level} ${s.version}`).toBe('degraded 3.5.0');
  });
  test('plex: right identity, server version (not apiVersion)', () => {
    const p = plexProbe(200, 0, ID_OK);
    expect(`${p.down} ${p.version}`).toBe('null 1.43.4');
  });
  test('plex: another identity is down', () =>
    expect(plexProbe(200, 0, '<MediaContainer machineIdentifier="0000000000000000" version="1"/>').down).toBe(
      'identity 00000000…, expected f3860770…: a fresh database?',
    ));
  test('plex: not answering', () => expect(plexProbe(0, 0, '').down).toBe('not answering on :32400'));
  test('qbt: connected', () => {
    const q = qbtProbe(204, '', 200, '{"connection_status":"connected","dht_nodes":300}', 'v5.2.4', 0, NOW);
    expect(`${JSON.stringify(q.reasons)} ${q.version} ${q.facts.connection}`).toBe('[] v5.2.4 connected');
  });
  test('qbt: firewalled degrades', () =>
    expect(qbtProbe(204, '', 200, '{"connection_status":"firewalled"}', 'v5', 0, NOW).reasons[0]?.text).toBe(
      'connection firewalled',
    ));
  test('qbt: refused login degrades, backs off', () => {
    const q = qbtProbe(200, 'Fails.', 0, '', '', 0, NOW);
    expect(`${q.facts.loginRefused} ${q.reasons[0]?.text}`).toBe(
      'true login refused (wrong user or password); next try in 1 h',
    );
  });
  test('qbt: banned (403)', () =>
    expect(qbtProbe(403, '', 0, '', '', 0, NOW).reasons[0]?.text).toBe('login refused (banned); next try in 1 h'));
  test('qbt: during backoff, no login, next try shown', () => {
    const q = qbtProbe(0, '', 0, '', '', NOW + 3600, NOW);
    expect(`${q.reasons[0]?.level} ${q.reasons[0]?.text}`).toBe('degraded login refused earlier; next try 23:53');
  });
});

// ─── classify_app ────────────────────────────────────────────────────────────
const OKP = servarrProbe(200, 0.01, '[]', '{"version":"6.4.4"}', 7878);
const DOWNP = servarrProbe(0, 0, '', '', 7878);
const app = (
  id: string,
  container: AppInput['container'],
  probe: AppInput['probe'],
  drift = null as AppInput['drift'],
  onDemand = false,
) => classifyApp({ id, onDemand, container, probe, drift, now: NOW });
const lv = (i: Item) => `${i.level} | ${i.summary}`;

describe('classify_app', () => {
  test('running, healthy → ok, uptime and version', () =>
    expect(lv(app('radarr', C.radarr!, OKP))).toBe('ok | up 4 h · 6.4.4'));
  test('no container → down', () => expect(lv(app('radarr', null, OKP))).toBe('down | no container'));
  test('exited → down (probe ignored)', () =>
    expect(lv(app('seerr', C.seerr!, DOWNP))).toBe('down | not running (exited, exit 137)'));
  test('restart loop → down', () =>
    expect(lv(app('bazarr', C.bazarr!, OKP))).toBe('down | restarting (Docker restart loop)'));
  test('unhealthy → down', () =>
    expect(lv(app('decluttarr', C.decluttarr!, null))).toBe('down | health check: unhealthy'));
  test('restarted 3 min ago → degraded', () =>
    expect(lv(app('sonarr', C.sonarr!, OKP))).toBe('degraded | restarted by Docker 2 time(s); up 3 min'));
  test('running but not answering → down', () =>
    expect(lv(app('radarr', C.radarr!, DOWNP))).toBe('down | not answering on :7878'));
  test('settings drift → degraded', () =>
    expect(
      lv(
        app('radarr', C.radarr!, OKP, {
          id: 'radarr',
          result: 'drift',
          lines: ['DRIFT  host: allowedHosts'],
          checkedAtEpoch: 1791498200,
        }),
      ),
    ).toBe('degraded | settings drift (checked 30 min ago): DRIFT  host: allowedHosts'));
  test('a check warning stays ok, counted', () =>
    expect(
      lv(
        app('radarr', C.radarr!, OKP, {
          id: 'prowlarr',
          result: 'warn',
          lines: ['FAILING  1337x'],
          checkedAtEpoch: 1791498200,
        }),
      ),
    ).toBe('ok | up 4 h · 6.4.4 · 1 notice(s)'));
  test('on demand → n/a', () =>
    expect(lv(app('recyclarr', null, null, null, true))).toBe('n/a | runs on demand (task recyclarr:sync)'));
  test('health warning → degraded', () =>
    expect(lv(app('radarr', C.radarr!, P))).toBe('degraded | IndexerStatusCheck: Indexers unavailable: 1337x'));
});

// ─── host ────────────────────────────────────────────────────────────────────
const SHOW = `Id=lan-address.timer
ActiveState=active
UnitFileState=enabled

Id=lan-address.service
ActiveState=inactive
Result=success
ExecMainStatus=0

Id=pms-update.timer
ActiveState=active
UnitFileState=enabled

Id=pms-update.service
ActiveState=inactive
Result=exit-code
ExecMainStatus=9

Id=stack-status.timer
ActiveState=inactive
UnitFileState=

Id=stack-status.service
ActiveState=activating
Result=success
ExecMainStatus=0

Id=arr-reclaim.service
ActiveState=active
SubState=running
ActiveEnterTimestamp=@1791489200

Id=stack-api.service
ActiveState=active
SubState=running
ActiveEnterTimestamp=@1791496400`;
const SJSON = parseShow(SHOW);
const DF90 = '/dev/x 753118085120 645078695936 76393869312 90% /mnt/data';
const DF96 = '/dev/x 753118085120 723000000000 30118085120 96% /mnt/data';
const IPJ = [
  { ifname: 'lo', addr_info: [{ family: 'inet', local: '127.0.0.1', scope: 'host' }] },
  {
    ifname: 'eno1',
    addr_info: [
      { family: 'inet', local: '192.168.0.86', scope: 'global' },
      { family: 'inet6', local: 'fd00::1', scope: 'global' },
    ],
  },
  { ifname: 'wlp2s0', addr_info: [{ family: 'inet', local: '192.168.0.66', scope: 'global' }] },
  { ifname: 'docker0', addr_info: [{ family: 'inet', local: '172.17.0.1', scope: 'global' }] },
];
const STATE_OK = 'qbittorrent 192.168.0.66 192.168.0.86\nradarr 192.168.0.66 192.168.0.86';

describe('host items', () => {
  test('parse_show keys by Id', () =>
    expect(`${SJSON['pms-update.service']?.Result} ${SJSON['pms-update.service']?.ExecMainStatus}`).toBe(
      'exit-code 9',
    ));
  const LT = { 'lan-address.timer': { next: 1791500300000000, last: 1791500000000000 } };
  test('armed timer → last and next', () =>
    expect(lv(classifyTimer('lan-address', SJSON, LT))).toBe('ok | last Thu 22:53 · next Thu 22:58'));
  test("failed run, with the updater's meaning", () =>
    expect(lv(classifyTimer('pms-update', SJSON, {}))).toBe(
      'degraded | last run failed: exit-code (an update was rolled back; the old image is serving)',
    ));
  test('not installed → degraded', () =>
    expect(lv(classifyTimer('stack-status', SJSON, {}))).toBe(
      'degraded | timer not armed (not installed): task deploy',
    ));
  test('unknown unit → degraded', () => expect(classifyTimer('nothing', SJSON, {}).level).toBe('degraded'));
  test('watcher running', () => expect(lv(classifyWatcher(SJSON, NOW))).toBe('ok | watching the library, up 3 h'));
  test('watcher stopped → down', () => expect(classifyWatcher({}, NOW).level).toBe('down'));
  test('stack-api running', () =>
    expect(lv(classifyStackApi(SJSON, NOW))).toBe('ok | signing in the owner, up 60 min'));
  test('stack-api stopped → down, and what that costs', () =>
    expect(lv(classifyStackApi({}, NOW))).toBe(
      'down | not running (not installed): the site shows only its login page',
    ));
  test('disk 90% → ok', () => expect(lv(classifyDisk('/mnt/data', DF90, 95))).toBe('ok | 90% used, 76 GB free'));
  test('disk 96% → degraded', () =>
    expect(lv(classifyDisk('/mnt/data', DF96, 95))).toBe('degraded | 96% used, 30 GB free'));
  test('no df → unknown', () => expect(classifyDisk('/mnt/data', '', 95).level).toBe('unknown'));
  test("df's header alone → unknown", () =>
    expect(classifyDisk('/mnt/data', 'Filesystem 1-blocks Used Available Capacity Mounted on', 95).level).toBe(
      'unknown',
    ));
  test('LAN: addresses, docker bridges and IPv6 left out', () =>
    expect(lv(classifyLan(IPJ, STATE_OK, ['qbittorrent', 'radarr']))).toBe(
      'ok | 192.168.0.86 (eno1), 192.168.0.66 (wlp2s0)',
    ));
  test('LAN: an app still on old addresses → degraded', () =>
    expect(classifyLan(IPJ, STATE_OK, ['qbittorrent', 'radarr', 'sonarr']).reasons[0]?.text).toBe(
      'address settings not applied yet: sonarr (lan-address runs every 5 min)',
    ));
  test('LAN: no address → down', () => expect(classifyLan([], '', ['qbittorrent']).level).toBe('down'));
});

// ─── drift ───────────────────────────────────────────────────────────────────
const dr = (rc: number, out: string) => {
  const r = classifyDrift(rc, out);
  return `${r.result} ${r.lines.join('|')}`;
};

describe('classify_drift', () => {
  test('clean', () => expect(dr(0, 'Read-back:\n  ok       naming\nNo drift.')).toBe('ok '));
  test('an indexer down is a warning, not a failure', () =>
    expect(dr(0, '  ok   x\n  FAILING  1337x (flare) — test fails\nNo drift.')).toBe(
      'warn FAILING  1337x (flare) — test fails',
    ));
  test("bazarr's warn lines too", () =>
    expect(dr(0, '  warn     health: x\nNo drift.')).toBe('warn warn     health: x'));
  test('drift', () =>
    expect(dr(1, '  DRIFT    host: allowedHosts\nTo apply: task arr:configure')).toBe(
      'drift DRIFT    host: allowedHosts',
    ));
  test('a failed step is failed', () =>
    expect(dr(1, '  FAIL  indexer sync still started after 90s')).toBe(
      'failed FAIL  indexer sync still started after 90s',
    ));
  test('drift and a failure → failed', () => expect(classifyDrift(1, '  DRIFT  a\n  FAIL  b').result).toBe('failed'));
  test('cannot log in (3), last line kept', () =>
    expect(dr(3, 'Seerr at x\ncannot log in')).toBe('failed cannot log in'));
  test('timed out (124)', () => expect(dr(124, '')).toBe('failed timed out'));
  test('deploy clean', () => expect(classifyDeployDrift(0, 'ok: x\nchecked').result).toBe('ok'));
  test('deploy drift keeps the problem lines', () => {
    const r = classifyDeployDrift(1, 'ok: a\nSYSTEM MISSING: /etc/systemd/system/x.timer\n\nTo apply: task deploy');
    expect(`${r.result} ${r.lines.join('|')}`).toBe('drift SYSTEM MISSING: /etc/systemd/system/x.timer');
  });
});

// ─── logs ────────────────────────────────────────────────────────────────────
describe('log_source', () => {
  const JRAW =
    '-- No entries --\n2026-10-08T18:31:24-03:00 pms systemd[1]: Started lan-address.service.\n2026-10-08T18:31:25-03:00 pms lan-address.sh[9]:     No drift.\n2026-10-08T18:31:26-03:00 pms arr-reclaim.sh[8]: reclaim: WARN: could not record';
  const J = logSource('journal', 'unit:x', 'x', JRAW, '');
  test('journal: time and message, host dropped', () =>
    expect(`${J.tail[0]?.t}|${J.tail[0]?.msg}`).toBe(
      '2026-10-08T18:31:24-03:00|systemd[1]: Started lan-address.service.',
    ));
  test('journal: only the WARN line is a problem', () =>
    expect(`${J.problemCount} ${J.problems[0]?.msg.split(': ')[1]}`).toBe('1 reclaim'));
  const DRAW =
    '2026-10-09T01:03:59.927366728Z [Info] RssSyncService: Processing 166 releases\n2026-10-09T01:04:00.5Z \u001b[31m[Warn]\u001b[0m IndexerStatus: 1337x failing\nStarting Plex Media Server. . . (you can ignore the libusb_init error)\nCritical: libusb_init failed\n2026-10-09T01:05:00Z [Fatal] ConsoleApp: Failed to bind to address\n2026-10-09T01:06:00Z token bucket refilled\n2026-10-09T01:07:00Z   DRIFT  web_ui_domain_list';
  const D = logSource('docker', 'container:x', 'x', DRAW, '');
  test('docker: nanoseconds cut to ms', () => expect(D.tail[0]?.t).toBe('2026-10-09T01:03:59.927Z'));
  test('docker: ANSI colour stripped', () => expect(D.tail[1]?.msg).toBe('[Warn] IndexerStatus: 1337x failing'));
  test('docker: a line without a time', () => expect(D.tail[2]?.t).toBeNull());
  test('problems: Warn, Fatal, DRIFT — not libusb, not benign', () =>
    expect(D.problems.map((p) => p.msg).join('|')).toBe(
      '[Warn] IndexerStatus: 1337x failing|[Fatal] ConsoleApp: Failed to bind to address|  DRIFT  web_ui_domain_list',
    ));
  const MANY = Array.from({ length: 60 }, (_, i) => `2026-10-09T01:00:00Z line ${i + 1}`).join('\n');
  test('keeps the last 50 lines', () => {
    const s = logSource('docker', 'c', 'c', MANY, '');
    expect(`${s.tail.length} ${s.tail[0]?.msg} ${s.tail.at(-1)?.msg}`).toBe('50 line 11 line 60');
  });
  test('cuts a line at 500 characters', () =>
    expect(logSource('docker', 'c', 'c', 'x'.repeat(700), '').tail[0]?.msg).toHaveLength(500));
  test('keeps the error of a failed read', () =>
    expect(logSource('docker', 'c', 'c', '', 'docker logs exit 1').error).toBe('docker logs exit 1'));
});

// ─── publish ─────────────────────────────────────────────────────────────────
describe('publish', () => {
  const outDir = join(SCRATCH, 'out-publish');
  mkdirSync(outDir, { recursive: true });
  const lines: string[] = [];
  const c = (mode: 'file' | 'stdout', secrets = SJ) => ({
    deps: { log: (l: string) => void lines.push(l) } as unknown as Deps,
    mode,
    outDir,
    secrets,
  });
  const read = () => readFileSync(join(outDir, 't.json'), 'utf8').trim();
  test('written, redacted', () => {
    expect(publish(c('file'), 't.json', { x: 'key abc123def456' })).toBe(true);
    expect(read()).toBe(`{"x":"key ${REDACTED}"}`);
  });
  test('mode 644 for nginx', () => expect((statSync(join(outDir, 't.json')).mode & 0o777).toString(8)).toBe('644'));
  test('no temp files left', () => expect(readdirSync(outDir)).toEqual(['t.json']));
  test('replaced', () => {
    publish(c('file'), 't.json', { x: 'new' });
    expect(read()).toBe('{"x":"new"}');
  });
  test('invalid JSON refused, old kept', () => {
    expect(publish(c('file'), 't.json', undefined)).toBe(false);
    expect(read()).toBe('{"x":"new"}');
  });
  // A secret where the masking cannot reach it (it masks values, not keys) but
  // the guard, which reads the whole text, does: refused.
  test('leak guard refuses, old kept', () => {
    const guard = { ...c('file'), secrets: [...SJ, 'never-masked-secret'] };
    expect(publish(guard, 't.json', { 'never-masked-secret': 1 })).toBe(false);
    expect(read()).toBe('{"x":"new"}');
  });
  test('--stdout prints, writes nothing', () => {
    lines.length = 0;
    publish(c('stdout'), 'u.json', { x: 'new' });
    expect(`${JSON.parse(lines[0] ?? '{}').x} ${existsSync(join(outDir, 'u.json')) ? 'file' : 'no-file'}`).toBe(
      'new no-file',
    );
  });
});

// ─── a whole fast run, everything stood in for ───────────────────────────────
// Every container: bazarr in a restart loop, decluttarr unhealthy, seerr exited,
// sonarr restarted 3 min ago with an indexer warning, the rest fine.
const runOk = (name: string, ip = '') => ({
  Name: `/${name}`,
  RestartCount: 0,
  State: { Status: 'running', Running: true, Restarting: false, StartedAt: '2026-10-08T18:00:00Z', ExitCode: 0 },
  NetworkSettings: { Networks: { arr: { IPAddress: ip } } },
});
const INSPECT_ALL = [
  ...INSPECT,
  runOk('docs'),
  runOk('flaresolverr', '172.19.0.4'),
  runOk('plex'),
  runOk('prowlarr'),
  runOk('qbittorrent'),
];
const SHOW_ALL = `${SHOW}

Id=arr-fallback-search.timer
ActiveState=active
UnitFileState=enabled

Id=arr-fallback-search.service
ActiveState=inactive
Result=success
ExecMainStatus=0

Id=stack-status-drift.timer
ActiveState=active
UnitFileState=enabled

Id=stack-status-drift.service
ActiveState=inactive
Result=success
ExecMainStatus=0`.replace(
  'Id=stack-status.timer\nActiveState=inactive\nUnitFileState=',
  'Id=stack-status.timer\nActiveState=active\nUnitFileState=enabled',
);

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false });

function fakes() {
  const runs: string[][] = [];
  const run = async (argv: readonly string[], _o?: RunOptions): Promise<RunResult> => {
    runs.push([...argv]);
    switch (`${argv[0]} ${argv[1]}`) {
      case 'docker inspect':
        return ok(JSON.stringify(INSPECT_ALL));
      case 'systemctl show':
        return ok(`${SHOW_ALL}\n`);
      case 'systemctl list-timers':
        return ok('[{"unit":"lan-address.timer","next":1791500300000000,"last":1791500000000000}]');
      case 'ip -j':
        return ok(JSON.stringify(IPJ));
      case 'df -P':
        return ok(`Filesystem 1-blocks Used Available Capacity Mounted\n${DF90}\n`);
      default:
        return { code: 127, stdout: '', stderr: 'no such command', timedOut: false };
    }
  };
  const runMerged = async (argv: readonly string[]) => {
    runs.push([...argv]);
    if (argv[0] === 'journalctl') return { code: 0, output: '2026-10-08T18:31:24-03:00 pms x[1]: ok' };
    if (argv[0] === 'docker')
      return {
        code: 0,
        output: '2026-10-09T01:00:00Z [Info] fine\n2026-10-09T01:00:01Z [Warn] something with apikey=zzz999',
      };
    return { code: 0, output: '' };
  };
  const fetch = async (url: string): Promise<Fetched> => {
    const r = (body: string, code: number, seconds: number) => ({ code, seconds, body });
    if (/:(7878\/api\/v3|9696\/api\/v1)\/health$/.test(url)) return r('[]', 200, 0.01);
    if (/:7878\/.*\/status$/.test(url)) return r('{"version":"6.4.4"}', 200, 0.01);
    if (/:9696\/.*\/status$/.test(url)) return r('{"version":"2.6.5"}', 200, 0.01);
    if (url.endsWith(':8989/api/v3/health')) return r(H, 200, 0.02);
    if (/:8989\/.*\/status$/.test(url)) return r('{"version":"4.0.20"}', 200, 0.01);
    if (url.endsWith(':32400/identity')) return r(ID_OK, 200, 0.005);
    if (url.endsWith(':8088/login/')) return r('<html>', 200, 0.002);
    if (url === 'http://172.19.0.4:8191/') return r('{"msg":"FlareSolverr is ready!","version":"3.5.2"}', 200, 0.003);
    return r('', 0, 0);
  };
  // qBittorrent: logs in (5.x), connected.
  const qbt: string[] = [];
  const http = async (url: string, req: HttpRequest): Promise<HttpResponse> => {
    const path = new URL(url).pathname;
    qbt.push(`${req.method ?? 'GET'} ${path}`);
    const reply = (status: number, text = '', headers: Record<string, string> = {}) => ({
      status,
      text,
      headers: new Headers(headers),
    });
    if (path === '/api/v2/auth/login') {
      const form = new URLSearchParams(req.body instanceof URLSearchParams ? req.body : String(req.body ?? ''));
      return form.get('username') === 'arr' && form.get('password') === 'qbt-pass'
        ? reply(204, '', { 'Set-Cookie': 'SID=s1; HttpOnly' })
        : reply(200, 'Fails.');
    }
    if (req.headers?.Cookie !== 'SID=s1') return reply(403, 'Forbidden');
    if (path === '/api/v2/transfer/info') return reply(200, '{"connection_status":"connected","dht_nodes":300}');
    if (path === '/api/v2/app/version') return reply(200, 'v5.2.4');
    return reply(200);
  };
  return { run, runMerged, fetch, http, runs, qbt };
}

interface Setup {
  repo: string;
  appdata: string;
  outDir: string;
  lines: string[];
  deps: Deps;
  f: ReturnType<typeof fakes>;
}
let n = 0;
function setup(envExtra = ''): Setup {
  const repo = join(SCRATCH, `repo${n++}`);
  const appdata = join(repo, 'appdata');
  const outDir = join(appdata, 'docs-status');
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(appdata, 'bazarr/config'), { recursive: true });
  writeFileSync(join(appdata, 'bazarr/config/config.yaml'), 'auth:\n  apikey: bazarr-key-123\n');
  writeFileSync(
    join(repo, '.env'),
    `APPDATA=${appdata}\nRADARR_API_KEY=rk-12345\nQBT_ARR_USER=arr\nQBT_ARR_PASS=qbt-pass\n${envExtra}`,
  );
  writeFileSync(join(appdata, '.lan-address'), LAN_STATE);
  const f = fakes();
  const lines: string[] = [];
  const deps: Deps = {
    run: f.run,
    runMerged: f.runMerged,
    fetch: f.fetch,
    http: f.http,
    now: () => NOW,
    log: (l) => void lines.push(l),
    which: () => true,
    env: {},
    repo,
  };
  return { repo, appdata, outDir, lines, deps, f };
}
const LAN_STATE = ['qbittorrent', 'prowlarr', 'radarr', 'sonarr', 'seerr']
  .map((a) => `${a} 192.168.0.66 192.168.0.86`)
  .join('\n');
const DRIFT_DOC = {
  schema: 1,
  generatedAtEpoch: 1791498200,
  apps: [
    { id: 'radarr', result: 'ok', lines: [] },
    { id: 'prowlarr', result: 'warn', lines: ['FAILING  1337x (flare)'] },
  ],
  deploy: { result: 'ok', lines: [] },
};
const readJson = (p: string) =>
  JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown> & { apps: Item[]; host: Item[] };

describe('fast_run', () => {
  const s = setup();
  writeFileSync(join(s.outDir, 'drift.json'), JSON.stringify(DRIFT_DOC));
  let code = -1;
  let S: ReturnType<typeof readJson>;
  let L: { sources: unknown[] };
  beforeAll(async () => {
    code = await main([], s.deps);
    S = readJson(join(s.outDir, 'status.json'));
    L = JSON.parse(readFileSync(join(s.outDir, 'logs.json'), 'utf8'));
  });
  test('fast_run exits 0 on a degraded stack', () => expect(code).toBe(0));
  test('schema, overall, counts', () =>
    expect(`${S.schema} ${S.overall} ${JSON.stringify(S.counts)}`).toBe(
      '1 down {"degraded":2,"down":3,"n/a":1,"ok":15}',
    ));
  test('one item per app, in order', () => expect(S.apps.map((a) => a.id)).toEqual([...STATUS_APPS]));
  test("apps' levels", () =>
    expect(S.apps.map((a) => `${a.id}:${a.level}`).join(' ')).toBe(
      'bazarr:down decluttarr:down docs:ok flaresolverr:ok plex:ok prowlarr:ok qbittorrent:ok radarr:ok recyclarr:n/a seerr:down sonarr:degraded',
    ));
  test('host levels', () =>
    expect(S.host.map((h) => `${h.id}:${h.level}`).join(' ')).toBe(
      'service:arr-reclaim:ok service:stack-api:ok timer:pms-update:degraded timer:arr-fallback-search:ok timer:lan-address:ok timer:stack-status:ok timer:stack-status-drift:ok disk:/mnt/data:ok lan:ok drift:ok',
    ));
  test('the drift warning reaches its app as a notice', () => {
    const p = S.apps.find((a) => a.id === 'prowlarr');
    expect(`${p?.level} | ${p?.summary}`).toBe('ok | up 4 h · 2.6.5 · 1 notice(s)');
  });
  test('LAN addresses for the page', () =>
    expect((S.lan as { addr: string }[]).map((a) => a.addr).join(' ')).toBe('192.168.0.86 192.168.0.66'));
  test('logs: every unit and container (not recyclarr)', () => expect(L.sources).toHaveLength(16));
  test('logs: secrets in log lines masked', () =>
    expect(readFileSync(join(s.outDir, 'logs.json'), 'utf8').includes('zzz999')).toBe(false));
  test('the documents are mode 644', () =>
    expect(
      ['status.json', 'logs.json'].map((f) => (statSync(join(s.outDir, f)).mode & 0o777).toString(8)).join(' '),
    ).toBe('644 644'));
  test('qBittorrent: logged in, read, logged out', () =>
    expect(s.f.qbt).toEqual([
      'POST /api/v2/auth/login',
      'GET /api/v2/transfer/info',
      'GET /api/v2/app/version',
      'POST /api/v2/auth/logout',
    ]));
  test('the first run says so', () => expect(s.lines).toEqual(['overall down: first run']));
  const GOLD = join(import.meta.dir, 'testdata/status.golden.json');
  test('matches testdata/status.golden.json (UPDATE_GOLDEN=1 to rewrite)', () => {
    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(GOLD, `${JSON.stringify(S, null, 2)}\n`);
    expect(S).toEqual(JSON.parse(readFileSync(GOLD, 'utf8')));
  });
});

describe('main', () => {
  test('a second run logs only what changed', async () => {
    const s = setup();
    await main([], s.deps);
    s.lines.length = 0;
    INSPECT_ALL.find((c) => c.Name === '/seerr')!.State.Running = true;
    INSPECT_ALL.find((c) => c.Name === '/seerr')!.State.Status = 'running';
    try {
      await main([], s.deps);
    } finally {
      INSPECT_ALL.find((c) => c.Name === '/seerr')!.State.Running = false;
      INSPECT_ALL.find((c) => c.Name === '/seerr')!.State.Status = 'exited';
    }
    // seerr answers nothing in the fakes, so it is now down for another reason: same level.
    expect(s.lines).toEqual([]);
  });

  test('a refused qBittorrent login backs off for an hour, and is not retried', async () => {
    const s = setup('QBT_ARR_PASS=wrong\n');
    await main([], s.deps);
    const state = JSON.parse(readFileSync(join(s.appdata, '.stack-status.state'), 'utf8'));
    expect(state).toEqual({ qbtBackoffUntil: NOW + 3600 });
    expect((statSync(join(s.appdata, '.stack-status.state')).mode & 0o777).toString(8)).toBe('600');
    s.f.qbt.length = 0;
    await main([], s.deps);
    expect(s.f.qbt).toEqual([]);
    const q = readJson(join(s.outDir, 'status.json')).apps.find((a) => a.id === 'qbittorrent');
    expect(q?.reasons[0]?.text).toBe('login refused earlier; next try 23:53');
  });

  test('--drift: every configure --check and deploy --check, into drift.json', async () => {
    const s = setup();
    s.deps.runMerged = async (argv) => {
      s.f.runs.push([...argv]);
      if (argv[0]?.endsWith('/apps/prowlarr/configure.sh')) return { code: 0, output: '  FAILING  1337x\nNo drift.' };
      if (argv[0]?.endsWith('/apps/bazarr/configure.sh'))
        return { code: 1, output: '  DRIFT    settings: plex.ip\nTo apply: task bazarr:configure' };
      if (argv[0]?.endsWith('/stack/deploy.sh')) return { code: 0, output: 'ok: all\nchecked' };
      return { code: 0, output: 'No drift.' };
    };
    expect(await main(['--drift'], s.deps)).toBe(0);
    expect(s.f.runs.map((a) => a.slice(0, 2).join(' ').replace(s.repo, ''))).toEqual([
      ...DRIFT_APPS.map((a) => `/apps/${a}/configure.sh --check`),
      '/stack/deploy.sh --check',
    ]);
    const d = JSON.parse(readFileSync(join(s.outDir, 'drift.json'), 'utf8'));
    expect(d.apps.map((a: { id: string; result: string }) => `${a.id} ${a.result}`)).toEqual([
      'qbittorrent ok',
      'prowlarr warn',
      'radarr ok',
      'sonarr ok',
      'seerr ok',
      'bazarr drift',
      'plex ok',
    ]);
    expect(Object.keys(d.apps[0])).toEqual(['id', 'rc', 'seconds', 'result', 'lines']);
    expect(s.lines).toEqual([
      'settings check: qbittorrent ok, prowlarr warn, radarr ok, sonarr ok, seerr ok, bazarr drift, plex ok, deploy ok',
    ]);
  });

  test('--audit: counts only, writes nothing', async () => {
    const s = setup('MYSTERY=some-long-value-here\n');
    expect(await main(['--audit'], s.deps)).toBe(0);
    expect(s.lines[0]).toBe('secrets loaded: 4 literal value(s); unclassified .env keys (masked): MYSTERY');
    expect(s.lines[1]).toMatch(/^status\.json +\d+ bytes, +\d+ masked, 0 leaks$/);
    expect(s.lines[2]).toMatch(/^logs\.json +\d+ bytes, +[1-9]\d* masked, 0 leaks$/);
    expect(existsSync(join(s.outDir, 'status.json'))).toBe(false);
  });

  test('another run holds the lock: skipped, 0', async () => {
    const s = setup();
    const { tryLock } = await import('../../stack/lib/lock.ts');
    const held = tryLock(join(s.appdata, '.stack-status.lock'));
    try {
      expect(await main([], s.deps)).toBe(0);
      expect(s.lines).toEqual([`Another run holds ${join(s.appdata, '.stack-status.lock')} — skipping.`]);
    } finally {
      held?.release();
    }
  });

  test('an output folder it cannot write: 1', async () => {
    const s = setup();
    rmSync(s.outDir, { recursive: true });
    expect(await main([], s.deps)).toBe(1);
    expect(s.lines[0]).toStartWith(`ERROR: ${s.outDir} is missing or not writable`);
  });

  test('no .env, or no docker: 3', async () => {
    const s = setup();
    rmSync(join(s.repo, '.env'));
    expect(await main([], s.deps)).toBe(3);
    const t = setup();
    t.deps.which = () => false;
    expect(await main([], t.deps)).toBe(3);
    expect(t.lines).toEqual(['missing command: docker']);
  });

  test('a word it does not know is a usage error', async () => {
    const s = setup();
    await expect(main(['--now'], s.deps)).rejects.toThrow('usage: stack-status.sh [--drift] [--stdout | --audit]');
  });
});

// ─── one name, several owners ────────────────────────────────────────────────
describe('pinned against the repo', () => {
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  test('STATUS_APPS is every apps/<app>', () =>
    expect([...STATUS_APPS] as string[]).toEqual(
      readdirSync(join(ROOT, 'apps'), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort(),
    ));
  test("DRIFT_APPS is Taskfile.yml's CONFIGURED", () =>
    expect(DRIFT_APPS.join(' ')).toBe(/^ {2}CONFIGURED: (.*)$/m.exec(read('Taskfile.yml'))?.[1] ?? ''));
  for (const [a, port] of Object.entries(APP_PORT)) {
    if (a === 'plex')
      test('plex runs on the host network (32400)', () =>
        expect(read('apps/plex/compose.yaml')).toContain('network_mode: host'));
    else
      test(`${a} probes its published port ${port}`, () =>
        expect(read(`apps/${a}/compose.yaml`)).toMatch(new RegExp(`^\\s+- "${port}:[0-9]+"`, 'm')));
  }
  test("plex identity is CLAUDE.md's", () =>
    expect(read('CLAUDE.md')).toContain(`identity \`${PLEX_IDENTITY.slice(0, 8)}…\``));
  const jobFiles = readdirSync(join(ROOT, 'jobs')).flatMap((j) => readdirSync(join(ROOT, 'jobs', j)));
  for (const u of LOG_UNITS) test(`log unit ${u} exists`, () => expect(jobFiles).toContain(`${u}.service`));
  for (const t of TIMERS) test(`timer ${t} exists`, () => expect(jobFiles).toContain(`${t}.timer`));
  test('the docs container mounts the output directory at /live', () =>
    expect(read('apps/docs/compose.yaml')).toContain('${APPDATA:?set APPDATA in .env}/docs-status:/live:ro'));
  test('nginx serves /live/ from it', () => expect(read('apps/docs/nginx.conf')).toMatch(/^\s+alias \/live\/;/m));
  test('the script writes there by default', () =>
    expect(read('jobs/stack-status/stack-status.ts')).toContain(
      "env.STACK_STATUS_DIR || join(appdata, 'docs-status')",
    ));
  for (const u of ['stack-status', 'stack-status-drift'])
    test(`${u}.service allows netlink`, () =>
      expect(read(`jobs/stack-status/${u}.service`)).toMatch(/^RestrictAddressFamilies=.*AF_NETLINK/m));
  test('Bun runs under both units: no MemoryDenyWriteExecute (its JIT needs it off)', () => {
    for (const u of ['stack-status', 'stack-status-drift'])
      expect(read(`jobs/stack-status/${u}.service`)).not.toMatch(/^MemoryDenyWriteExecute=yes/m);
  });
  const execStart = (u: string) => /^ExecStart=(.*)$/m.exec(read(`jobs/stack-status/${u}.service`))?.[1];
  test('fast unit runs the script', () =>
    expect(execStart('stack-status')).toBe('@PMS_HOME@/jobs/stack-status/stack-status.sh'));
  test('drift unit runs it with --drift', () =>
    expect(execStart('stack-status-drift')).toBe('@PMS_HOME@/jobs/stack-status/stack-status.sh --drift'));
  test('every 2 minutes after a minute', () =>
    expect(read('jobs/stack-status/stack-status.timer').match(/^On(Boot|UnitActive)Sec=.*$/gm)).toEqual([
      'OnBootSec=1min',
      'OnUnitActiveSec=2min',
    ]));
  test('drift hourly', () =>
    expect(read('jobs/stack-status/stack-status-drift.timer').match(/^OnUnitActiveSec=.*$/gm)).toEqual([
      'OnUnitActiveSec=1h',
    ]));
  test('the page calls stale what the job calls stale', () => {
    expect(read('site/src/lib/status-view.ts')).toContain('staleAfterSeconds');
    expect(STALE_AFTER).toBe(360);
  });
});
