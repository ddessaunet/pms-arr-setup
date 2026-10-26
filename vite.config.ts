// Vite+ (`vp`): lint and format for the stack's TypeScript (apps/, jobs/, stack/).
// `task lint` runs `vp check`; `bun test` runs the tests, not vp. The docs site
// has its own config (site/vite.config.ts) and package manager, so it is left out.
import { defineConfig } from 'vite-plus';

export default defineConfig({
  // The site's style. Markdown and YAML stay as laid out by hand.
  fmt: {
    singleQuote: true,
    semi: true,
    printWidth: 120,
    ignorePatterns: [
      'site/**',
      '.claude/**',
      '**/testdata/**',
      'stack/lib/api/*.d.ts',
      '**/*.md',
      '**/*.yml',
      '**/*.yaml',
    ],
  },
  lint: { ignorePatterns: ['site/**', '.claude/**', 'node_modules/**', 'stack/lib/api/*.d.ts'] },
});
