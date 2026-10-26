// stack/lib/api/gen.test.ts — the version header, and main against a fake app,
// a fake GitHub and a fake openapi-typescript. Offline; writes only to a temp dir.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { HttpRequest, HttpResponse } from '../http.ts';
import type { RunOptions, RunResult } from '../run.ts';
import { APPS, header, main, versionOf } from './gen.ts';

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
  test('the checked-in file has one', () => {
    const file = resolve(import.meta.dir, 'prowlarr.d.ts');
    expect(versionOf(readFileSync(file, 'utf8'))).toMatch(/^\d+\.\d+\.\d+/);
  });
});

let n = 0;
function setup(running: string, have?: string) {
  const repo = join(tmp, String(n++));
  mkdirSync(join(repo, 'stack/lib/api'), { recursive: true });
  if (have) writeFileSync(join(repo, 'stack/lib/api/prowlarr.d.ts'), `${header(prowlarr!, have)}export {};\n`);
  const urls: string[] = [];
  const argvs: string[][] = [];
  const lines: string[] = [];
  const deps = {
    http: async (url: string, req: HttpRequest): Promise<HttpResponse> => {
      urls.push(url);
      if (url.endsWith('/system/status')) {
        const ok = req.headers?.['X-Api-Key'] === 'pk';
        return { status: ok ? 200 : 401, text: ok ? JSON.stringify({ version: running }) : '', headers: new Headers() };
      }
      return { status: 200, text: '{"openapi":"3.0.4"}', headers: new Headers() };
    },
    run: async (argv: readonly string[], _opts?: RunOptions): Promise<RunResult> => {
      argvs.push([...argv]);
      writeFileSync(argv[argv.indexOf('-o') + 1] ?? '', 'export interface components {}\n');
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    },
    log: (l: string) => void lines.push(l),
    env: { PROWLARR_API_KEY: 'pk' } as Record<string, string>,
    repo,
  };
  return { deps, repo, urls, argvs, lines };
}

describe('main', () => {
  test('--check: in step', async () => {
    const s = setup('2.6.5.5623', '2.6.5.5623');
    expect(await main(['--check'], s.deps)).toBe(0);
    expect(s.lines).toEqual(['  ok       prowlarr 2.6.5.5623']);
    expect(s.argvs).toEqual([]);
  });

  test('--check: behind is 1, and changes nothing', async () => {
    const s = setup('2.7.0.1', '2.6.5.5623');
    expect(await main(['--check'], s.deps)).toBe(1);
    expect(s.lines).toEqual(['  BEHIND   prowlarr: types are 2.6.5.5623, running 2.7.0.1 — task types:gen']);
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
    expect(s.lines).toEqual(['  wrote    stack/lib/api/prowlarr.d.ts (new → 2.7.0.1)']);
  });

  test('a refused key is 3', async () => {
    const s = setup('2.7.0.1');
    s.deps.env = {};
    expect(await main(['--check'], s.deps)).toBe(3);
    expect(s.lines).toEqual(['  FAIL  prowlarr: version from http://127.0.0.1:9696 (HTTP 401)']);
  });
});
