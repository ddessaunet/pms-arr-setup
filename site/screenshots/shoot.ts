// Screenshots of the site for PR descriptions: task site:screenshot -- [scene…]
// (.claude/skills/pr-screenshots). Builds the site into .dist-shots, serves it
// on a loopback port, and renders each scene (scenes.ts) in headless Chromium
// with /api/ and /live/ answered from the scene's made-up data, so nothing
// needs the sign-in or reaches the live stack: every other request off the
// loopback port is refused. Writes .screenshots/<scene>.png. With no scene,
// all of them; --list prints their names.

import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { chromium, type Route } from 'playwright';
import { NOW, SCENES, type Scene } from './scenes.ts';

const SITE = resolve(import.meta.dir, '..');
const DIST = join(SITE, '.dist-shots');
const OUT = join(SITE, '.screenshots');

const args = process.argv.slice(2);
if (args.includes('--list')) {
  console.log(Object.keys(SCENES).join('\n'));
  process.exit(0);
}
const names = args.length ? args : Object.keys(SCENES);
const unknown = names.filter((n) => !(n in SCENES));
if (unknown.length) {
  console.error(`No such scene: ${unknown.join(', ')} (task site:screenshot -- --list)`);
  process.exit(2);
}

// The build, as nginx would serve it: /x/ is /x/index.html.
const build = Bun.spawnSync(['bun', '--bun', 'astro', 'build', '--outDir', DIST], {
  cwd: SITE,
  stdout: 'inherit',
  stderr: 'inherit',
  env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
});
if (build.exitCode !== 0) {
  console.error('The build failed: no screenshots.');
  process.exit(1);
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(req) {
    const { pathname } = new URL(req.url);
    const p = normalize(join(DIST, decodeURIComponent(pathname)));
    if (!p.startsWith(DIST) || !existsSync(p)) return new Response('not found', { status: 404 });
    if (!statSync(p).isDirectory()) return new Response(Bun.file(p));
    if (!pathname.endsWith('/')) return new Response(null, { status: 301, headers: { Location: `${pathname}/` } });
    const index = join(p, 'index.html');
    return existsSync(index) ? new Response(Bun.file(index)) : new Response('not found', { status: 404 });
  },
});
const ORIGIN = `http://127.0.0.1:${server.port}`;

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
let failed = 0;

async function shoot(name: string, scene: Scene) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    locale: 'en-US',
    timezoneId: 'UTC',
  });
  const misses: string[] = [];
  const errors: string[] = [];
  await context.route('**/*', (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const key = `${req.method()} ${url.pathname}`;
    if (url.origin !== ORIGIN) {
      misses.push(`${key} (off the box: refused)`);
      return route.abort('blockedbyclient');
    }
    if (!/^\/(api|live)\//.test(url.pathname)) return route.continue();
    const answer = scene.api?.[key];
    if (!answer) {
      misses.push(key);
      console.log(`  ${key} → 404 (no fixture)`);
      return route.fulfill({ status: 404, json: { error: 'no fixture' } });
    }
    console.log(`  ${key} → ${answer.status ?? 200} (fixture)`);
    return route.fulfill({ status: answer.status ?? 200, json: answer.body });
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.clock.setFixedTime(NOW);
  try {
    await page.goto(ORIGIN + scene.path, { waitUntil: 'networkidle' });
    await scene.steps?.(page);
    await page.evaluate(() => document.fonts.ready);
    const path = join(OUT, `${name}.png`);
    if (scene.clip) await page.locator(scene.clip).screenshot({ path });
    else await page.screenshot({ path, fullPage: true });
    if (misses.length || errors.length)
      throw new Error([...misses.map((m) => `unanswered: ${m}`), ...errors].join('; '));
    console.log(`${name}: ${path}`);
  } catch (e) {
    failed++;
    console.error(`${name}: FAILED: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await context.close();
  }
}

try {
  for (const name of names) await shoot(name, SCENES[name] as Scene);
} finally {
  await browser.close();
  await server.stop(true);
  rmSync(DIST, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
