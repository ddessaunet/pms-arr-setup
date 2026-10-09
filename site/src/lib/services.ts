// The dashboard's services, read from the repo when the site builds: every
// apps/<app>/compose.yaml (for the ports) and src/data/services.yml. Raw
// imports resolve from this file, a missing file fails the build, and in
// `task site:dev` an edit reloads the page.

import servicesText from '../data/services.yml?raw';
import { buildServices } from './services-core.ts';

const composeFiles = import.meta.glob<string>('../../../apps/*/compose.yaml', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const composeById = Object.fromEntries(
  Object.entries(composeFiles).map(([path, text]) => [path.split('/').at(-2) as string, text]),
);

export const services = buildServices(composeById, servicesText);
