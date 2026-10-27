// stack/lib/api/gen.test.ts — the version header, and main against a fake app,
// a fake GitHub and a fake openapi-typescript. Offline; writes only to a temp dir.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { HttpRequest, HttpResponse } from '../http.ts';
import type { RunOptions, RunResult } from '../run.ts';
import { APPS, header, looksLikeSpec, main, versionOf } from './gen.ts';

const tmp = mkdtempSync(join(tmpdir(), 'api-gen-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const prowlarr = APPS.find((a) => a.name === 'prowlarr');
if (!prowlarr) throw new Error('no prowlarr in APPS');

describe('the header', () => {
  test('records the version, which versionOf reads back', () => {
    expect(versionOf(`${header(prowlarr, '2.6.5.5623')}export type x = 1;\n`)).toBe('2.6.5.5623');
  });
  test('names the spec at that tag', () =>
    expect(header(prowlarr, '2.6.5')).toContain('/Prowlarr/Prowlarr/v2.6.5/src/Prowlarr.Api.V1/openapi.json'));
  test('a file without one has no version', () => expect(versionOf('export {};\n')).toBeUndefined());
  for (const app of APPS) {
    test(`the checked-in ${app.name}.d.ts has one`, () => {
      const file = resolve(import.meta.dir, `${app.name}.d.ts`);
      expect(versionOf(readFileSync(file, 'utf8'))).toMatch(/^\d+\.\d+\.\d+/);
    });
  }
});

const seerr = APPS.find((a) => a.name === 'seerr');
if (!seerr) throw new Error('no seerr in APPS');
const SEERR = '3.5.1';
// Radarr and Sonarr run these, and their types are always in step here.
const OTHERS: Record<string, { version: string; key: string; url: string }> = {
  radarr: { version: '6.4.4.10685', key: 'rk', url: 'http://127.0.0.1:7878/api/v3/system/status' },
  sonarr: { version: '4.0.20.3014', key: 'sk', url: 'http://127.0.0.1:8989/api/v3/system/status' },
};

describe('the spec check', () => {
  test('JSON', () => expect(looksLikeSpec('{"openapi":"3.0.4"}')).toBe(true));
  test("YAML (Seerr's)", () => expect(looksLikeSpec("openapi: '3.0.2'\ninfo:\n")).toBe(true));
  test('an error page is neither', () => expect(looksLikeSpec('<html>404</html>')).toBe(false));
});

// Prowlarr runs `running`; Seerr runs 3.5.1, and its types are in step unless
// seerrHave says otherwise.
let n = 0;
function setup(running: string, have?: string, seerrHave: string | null = SEERR) {
  const repo = join(tmp, String(n++));
  mkdirSync(join(repo, 'stack/lib/api'), { recursive: true });
  if (have) writeFileSync(join(repo, 'stack/lib/api/prowlarr.d.ts'), `${header(prowlarr!, have)}export {};\n`);
  if (seerrHave) writeFileSync(join(repo, 'stack/lib/api/seerr.d.ts'), `${header(seerr!, seerrHave)}export {};\n`);
  for (const [name, o] of Object.entries(OTHERS)) {
    const app = APPS.find((a) => a.name === name)!;
    writeFileSync(join(repo, `stack/lib/api/${name}.d.ts`), `${header(app, o.version)}export {};\n`);
  }
  const urls: string[] = [];
  const argvs: string[][] = [];
  const lines: string[] = [];
  const reply = (status: number, text: string): HttpResponse => ({ status, text, headers: new Headers() });
  const deps = {
    http: async (url: string, req: HttpRequest): Promise<HttpResponse> => {
      urls.push(url);
      if (url === 'http://127.0.0.1:9696/api/v1/system/status') {
        const ok = req.headers?.['X-Api-Key'] === 'pk';
        return reply(ok ? 200 : 401, ok ? JSON.stringify({ version: running }) : '');
      }
      for (const o of Object.values(OTHERS))
        if (url === o.url)
          return req.headers?.['X-Api-Key'] === o.key
            ? reply(200, JSON.stringify({ version: o.version }))
            : reply(401, '');
      // Seerr's /status is public.
      if (url === 'http://127.0.0.1:5055/api/v1/status')
        return reply(req.headers?.['X-Api-Key'] === undefined ? 200 : 400, JSON.stringify({ version: SEERR }));
      if (url.endsWith('.yml')) return reply(200, "openapi: '3.0.2'\n");
      return reply(200, '{"openapi":"3.0.4"}');
    },
    run: async (argv: readonly string[], _opts?: RunOptions): Promise<RunResult> => {
      argvs.push([...argv]);
      writeFileSync(argv[argv.indexOf('-o') + 1] ?? '', 'export interface components {}\n');
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    },
    log: (l: string) => void lines.push(l),
    env: { PROWLARR_API_KEY: 'pk', RADARR_API_KEY: 'rk', SONARR_API_KEY: 'sk' } as Record<string, string>,
    repo,
  };
  return { deps, repo, urls, argvs, lines };
}

describe('main', () => {
  test('--check: in step', async () => {
    const s = setup('2.6.5.5623', '2.6.5.5623');
    expect(await main(['--check'], s.deps)).toBe(0);
    expect(s.lines).toEqual([
      '  ok       prowlarr 2.6.5.5623',
      `  ok       radarr ${OTHERS.radarr!.version}`,
      `  ok       sonarr ${OTHERS.sonarr!.version}`,
      `  ok       seerr ${SEERR}`,
    ]);
    expect(s.argvs).toEqual([]);
  });

  test('--check: behind is 1, and changes nothing', async () => {
    const s = setup('2.7.0.1', '2.6.5.5623');
    expect(await main(['--check'], s.deps)).toBe(1);
    expect(s.lines[0]).toBe('  BEHIND   prowlarr: types are 2.6.5.5623, running 2.7.0.1 — task types:gen');
    expect(versionOf(readFileSync(join(s.repo, 'stack/lib/api/prowlarr.d.ts'), 'utf8'))).toBe('2.6.5.5623');
  });

  test('gen: the spec at the running tag, through openapi-typescript, with the header', async () => {
    const s = setup('2.7.0.1');
    expect(await main([], s.deps)).toBe(0);
    expect(s.urls).toContain(
      'https://raw.githubusercontent.com/Prowlarr/Prowlarr/v2.7.0.1/src/Prowlarr.Api.V1/openapi.json',
    );
    expect(s.argvs[0]?.slice(1, 3)).toEqual(['--bun', join(s.repo, 'node_modules/.bin/openapi-typescript')]);
    const text = readFileSync(join(s.repo, 'stack/lib/api/prowlarr.d.ts'), 'utf8');
    expect(versionOf(text)).toBe('2.7.0.1');
    expect(text).toEndWith('export interface components {}\n');
    expect(s.lines[0]).toBe('  wrote    stack/lib/api/prowlarr.d.ts (new → 2.7.0.1)');
  });

  test('seerr: a YAML spec, kept as .yml for openapi-typescript, version from its keyless /status', async () => {
    const s = setup('2.6.5.5623', '2.6.5.5623', null);
    expect(await main([], s.deps)).toBe(0);
    expect(s.urls).toContain(`https://raw.githubusercontent.com/seerr-team/seerr/v${SEERR}/seerr-api.yml`);
    expect(s.argvs.map((a) => a[3]).filter((f) => f?.endsWith('.yml'))).toHaveLength(1);
    expect(versionOf(readFileSync(join(s.repo, 'stack/lib/api/seerr.d.ts'), 'utf8'))).toBe(SEERR);
    expect(s.lines).toContain(`  wrote    stack/lib/api/seerr.d.ts (new → ${SEERR})`);
  });

  test('a refused key is 3', async () => {
    const s = setup('2.7.0.1');
    s.deps.env = {};
    expect(await main(['--check'], s.deps)).toBe(3);
    expect(s.lines).toEqual(['  FAIL  prowlarr: version from http://127.0.0.1:9696 (HTTP 401)']);
  });
});
