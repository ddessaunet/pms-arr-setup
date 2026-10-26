// stack/lib/rules.test.ts — the runtime rules for the stack's TypeScript.
//
// The install is a copy with no node_modules, and Bun runs with --no-install,
// so a script that imports a package works in the source and breaks on the box.
// Every non-test .ts under apps/, jobs/ and stack/ may import only:
//   - relative paths ('./x.ts', '../lib/y.ts')
//   - Bun's and node's built-ins ('bun:ffi', 'node:fs')
//   - anything, in an `import type` line (erased before it runs)
// Also: no Bun.$ (run.ts is the one way to run a command), no process.exit()
// (exit.ts sets process.exitCode), and every stack/lib module has a test.

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');

/** The source without its comments, near enough for these checks. */
const codeOf = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

/** The module specifiers a source loads at runtime. */
function runtimeImports(source: string): string[] {
  const code = codeOf(source);
  const found: string[] = [];
  // import … from 'x' / export … from 'x', possibly over several lines; `type` ones are erased.
  for (const m of code.matchAll(/^\s*(import|export)\s+(type\s)?[^'";]*?\bfrom\s*['"]([^'"]+)['"]/gm)) {
    if (!m[2]) found.push(m[3] ?? '');
  }
  for (const m of code.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) found.push(m[1] ?? ''); // import 'x'
  for (const m of code.matchAll(/\b(?:import|require)\s*\(\s*['"`]([^'"`]+)['"`]/g)) found.push(m[1] ?? '');
  return found;
}

const allowed = (spec: string) => /^\.\.?\//.test(spec) || /^(bun|node):/.test(spec);

function sources(): string[] {
  const glob = new Bun.Glob('{apps,jobs,stack}/**/*.ts');
  return [...glob.scanSync({ cwd: ROOT })].filter((f) => !f.endsWith('.test.ts')).sort();
}

describe('runtimeImports', () => {
  test('finds what loads at runtime, skips type-only lines', () => {
    const src = [
      "import { a } from './a.ts';",
      "import type { B } from 'some-package';",
      "export type { C } from 'other-package';",
      'import {',
      '  d,',
      '  e,',
      "} from 'lodash';",
      "import 'side-effect';",
      "export * from '../lib/x.ts';",
      "const m = await import('dynamic');",
      "// import nope from 'commented';",
      "/* import nope from 'block' */",
    ].join('\n');
    expect(runtimeImports(src)).toEqual(['./a.ts', 'lodash', '../lib/x.ts', 'side-effect', 'dynamic']);
  });
  test('allowed', () => {
    expect(['./a.ts', '../b.ts', 'bun:ffi', 'node:fs'].every(allowed)).toBe(true);
    expect(['fs', 'lodash', 'bun', '@types/bun', '/abs.ts'].some(allowed)).toBe(false);
  });
});

describe('every non-test .ts', () => {
  const files = sources();
  test('there are some', () => expect(files.length).toBeGreaterThan(0));
  for (const f of files) {
    test(f, () => {
      const src = readFileSync(resolve(ROOT, f), 'utf8');
      const code = codeOf(src);
      expect({ file: f, imports: runtimeImports(src).filter((s) => !allowed(s)) }).toEqual({ file: f, imports: [] });
      expect({ file: f, bunShell: /\bBun\.\$|\bimport\s*\{[^}]*\$[^}]*\}\s*from\s*['"]bun['"]/.test(code) }).toEqual({
        file: f,
        bunShell: false,
      });
      expect({ file: f, processExit: /\bprocess\.exit\s*\(/.test(code) }).toEqual({ file: f, processExit: false });
    });
  }
});

test('every stack/lib module has a test', () => {
  const missing = sources()
    .filter((f) => f.startsWith('stack/lib/') && !f.startsWith('stack/lib/api/'))
    .filter((f) => !existsSync(resolve(ROOT, f.replace(/\.ts$/, '.test.ts'))));
  expect(missing).toEqual([]);
});
