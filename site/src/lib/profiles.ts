// The map's data, read from the repo when the site builds. Imports are
// resolved from this file, so they work whatever the working directory, a
// missing file fails the build, and in `task site:dev` an edit reloads the page.

import recyclarr from '../../../apps/recyclarr/recyclarr.yml?raw';
import * as arrPolicy from '../../../stack/lib/arr-policy.ts';
import policy from '../data/profiles.yml?raw';
import { buildProfiles } from './profiles-core.ts';

export const { profiles, sizes } = buildProfiles(recyclarr, policy, arrPolicy);
