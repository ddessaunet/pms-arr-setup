// Vite+ (`vp`): the site's lint, format and tests. See site/Taskfile.yml.
// Astro never reads this file: the build's own settings are in astro.config.mjs.
import { defineConfig } from 'vite-plus';

export default defineConfig({
  // The style the site was already written in. CSS and YAML stay as laid out by
  // hand: Oxfmt would split every one-line CSS rule and drop the YAML's columns.
  fmt: { singleQuote: true, semi: true, printWidth: 120, ignorePatterns: ['**/*.css', '**/*.yml', '**/*.yaml'] },
  lint: { ignorePatterns: ['dist/**', '.dist-*/**', '.astro/**'] },
  test: { include: ['src/lib/*.test.ts'] },
});
