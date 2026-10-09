// @ts-check
// The docs website. Built on the host (`task site:build`) and served by
// apps/docs (nginx) from site/dist. See site/Taskfile.yml.
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  // The pages read files outside site/ (src/lib/profiles.ts, src/lib/services.ts);
  // the dev server only serves inside site/ unless told. /live is the
  // dashboard's data, which nginx serves on the box: `task site:dev` proxies to
  // it, so the preview shows the live status too.
  vite: {
    server: {
      fs: { allow: ['..'] },
      proxy: { '/live': 'http://127.0.0.1:8088' },
    },
  },
  integrations: [
    starlight({
      title: 'pms',
      sidebar: [
        { label: 'Stack', link: '/' },
        { label: 'Quality profiles', link: '/quality-profiles/' },
      ],
      // The Pacman theme (DESIGN.md at the repo root): self-hosted fonts, so the
      // LAN site needs no font CDN, then the theme itself. Latin only: every page
      // is English.
      customCss: [
        '@fontsource/press-start-2p/latin-400.css',
        '@fontsource/space-mono/latin-400.css',
        '@fontsource/space-mono/latin-700.css',
        '@fontsource-variable/space-grotesk',
        './src/styles/pacman.css',
      ],
      // One dark theme: no picker, and no stored or system preference.
      components: {
        ThemeProvider: './src/components/overrides/ThemeProvider.astro',
        ThemeSelect: './src/components/overrides/ThemeSelect.astro',
      },
      pagefind: false, // one page: nothing to search yet
      lastUpdated: false,
    }),
  ],
});
