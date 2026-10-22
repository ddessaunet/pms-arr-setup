// Starlight route middleware (astro.config.mjs `routeMiddleware`). The profile
// cards are a component, so their headings never reach the page's table of
// contents; this lists them under "The profiles", in the map's order (movies,
// then series), linking to the ids ProfileCard.astro gives their headings.

import { defineRouteMiddleware } from '@astrojs/starlight/route-data';
import { profiles } from './lib/profiles.ts';
import { profileSlug } from './lib/profiles-core.ts';

const APP_ORDER = ['radarr', 'sonarr'];

export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  if (route.id !== 'quality-profiles' || !route.toc) return;
  const section = route.toc.items.find((item) => item.slug === 'the-profiles');
  if (!section) throw new Error('quality-profiles.mdx: no "The profiles" heading for the profile list');
  section.children = APP_ORDER.flatMap((app) => profiles.filter((p) => p.app === app)).map((p) => ({
    depth: 3,
    slug: profileSlug(p.name),
    text: p.name,
    children: [],
  }));
});
