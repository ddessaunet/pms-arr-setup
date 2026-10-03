// @ts-check
// The docs website. Built on the host (`task site:build`) and served by
// apps/docs (nginx) from site/dist. See site/Taskfile.yml.
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  // One page for now; the root goes to it, so its URL stays put as pages arrive.
  redirects: { '/': '/quality-profiles/' },
  // The page reads ../apps/recyclarr/recyclarr.yml and stack/lib/arr-configure.sh
  // (src/lib/profiles.ts); the dev server only serves inside site/ unless told.
  vite: { server: { fs: { allow: ['..'] } } },
  integrations: [
    starlight({
      title: 'pms',
      sidebar: [{ label: 'Quality profiles', link: '/quality-profiles/' }],
      pagefind: false, // one page: nothing to search yet
      lastUpdated: false,
    }),
  ],
});
