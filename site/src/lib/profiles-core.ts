// The quality-profiles map, from the files that own each fact:
//
//   apps/recyclarr/recyclarr.yml   the profiles: names, qualities, upgrades, scores
//   stack/lib/arr-policy.ts        size caps, the default profile per app, which
//                                  profiles may upgrade (arr-configure applies it)
//   site/src/data/profiles.yml     what neither can say: who picks a profile,
//                                  HDR, low-quality groups, a one-line summary
//
// Pure (text and data in, data out) so `task site:test` runs it without Astro.
// Anything that disagrees throws, and a throw fails `astro build`: the map is
// never published out of step with the files it describes.

import { parse } from 'yaml';
import type { ScalarTag } from 'yaml';
import { z } from 'astro/zod';

export type App = 'radarr' | 'sonarr';
const APPS: App[] = ['radarr', 'sonarr'];

// recyclarr.yml reads its API keys with `!env_var NAME`. Only the name is kept,
// as a placeholder: nothing secret is ever in the file or on the page.
const envVar: ScalarTag = {
  tag: '!env_var',
  identify: () => false,
  resolve: (name: string) => `\${${name}}`,
};

const Group = z.strictObject({ name: z.string(), qualities: z.array(z.string()) });

const Policy = z.strictObject({
  // For a profile recyclarr.yml names only by trash_id: the guide's name and
  // allowed qualities, copied from the TRaSH guide's JSON.
  guide: z
    .record(z.string(), z.strictObject({ name: z.string(), url: z.url(), qualities: z.array(Group) }))
    .default({}),
  profiles: z.record(
    z.string(),
    z.strictObject({
      app: z.enum(['radarr', 'sonarr']),
      role: z.enum(['default', 'opt-in', 'by-hand']),
      pickedBy: z.string(),
      summary: z.string(),
      hdr: z.string().nullable(),
      lq: z.enum(['rejected', 'accepted']),
      dailySearch: z.boolean(),
    }),
  ),
});

export type QualityGroup = z.infer<typeof Group>;

export interface Profile {
  app: App;
  name: string;
  trashId: string | null;
  // Qualities from the guide, not recyclarr.yml (shown as such).
  guideQualities: boolean;
  guideUrl: string | null;
  // Most preferred first, as Radarr/Sonarr rank them.
  groups: QualityGroup[];
  upgrade: { allowed: boolean | null; until: string | null };
  // null: the guide's value is kept.
  minFormatScore: number | null;
  resetScores: boolean;
  remux: boolean;
  formats: { kind: 'guide'; groups: number } | { kind: 'hand-picked'; count: number };
  role: 'default' | 'opt-in' | 'by-hand';
  pickedBy: string;
  summary: string;
  hdr: string | null;
  lq: 'rejected' | 'accepted';
  dailySearch: boolean;
}

// MB per minute of runtime. max null: no maximum.
// One cap and the qualities that share it; a resolution can have several
// (Radarr's WEB-DL 1080p is capped higher than its encodes).
export interface SizeCap {
  resolution: string;
  qualities: string[];
  max: number | null;
  preferred: number;
}

const RECYCLARR = 'apps/recyclarr/recyclarr.yml';
const POLICY = 'site/src/data/profiles.yml';
const ARR = 'stack/lib/arr-policy.ts';

// ─── stack/lib/arr-policy.ts ──────────────────────────────────────────────────
// Imported, not parsed: profiles.ts passes the module itself, the tests a
// changed copy.

export interface ArrPolicy {
  DEFAULT_PROFILE: Readonly<Record<App, string>>;
  UPGRADE_PROFILES: Readonly<Record<App, readonly string[]>>;
  SIZE_CAPS: Readonly<Record<App, readonly { quality: string; max: number | null; preferred: number }[]>>;
}

/** The caps grouped for the map: one per resolution and cap, in the policy's order. */
export function sizeCapsOf(arr: ArrPolicy): Record<App, SizeCap[]> {
  const caps = {} as Record<App, SizeCap[]>;
  for (const app of APPS) {
    const byCap = new Map<string, SizeCap>();
    for (const { quality, max, preferred } of arr.SIZE_CAPS[app]) {
      const resolution = quality.replace(/.*-/, '');
      const key = `${resolution} ${max} ${preferred}`;
      const seen = byCap.get(key);
      if (seen) seen.qualities.push(quality);
      else byCap.set(key, { resolution, qualities: [quality], max, preferred });
    }
    if (byCap.size === 0) throw new Error(`${ARR}: no ${app} sizes in SIZE_CAPS`);
    caps[app] = [...byCap.values()];
  }
  return caps;
}

// ─── the map ──────────────────────────────────────────────────────────────────

export function buildProfiles(recyclarrText: string, policyText: string, arr: ArrPolicy) {
  const raw = parse(recyclarrText, { customTags: [envVar] });
  const policy = Policy.parse(parse(policyText));
  const sizes = sizeCapsOf(arr);

  const found: Omit<Profile, 'role' | 'pickedBy' | 'summary' | 'hdr' | 'lq' | 'dailySearch'>[] = [];
  for (const app of APPS) {
    for (const [instance, cfg] of Object.entries<any>(raw?.[app] ?? {})) {
      for (const p of cfg.quality_profiles ?? []) {
        const guide = p.trash_id ? policy.guide[p.trash_id] : undefined;
        const name: string | undefined = p.name ?? guide?.name;
        if (!name) {
          throw new Error(
            `${RECYCLARR}: ${app}.${instance} has a profile with trash_id ${p.trash_id ?? '(none)'} and no name: — ` +
              `give it one there, or add guide.${p.trash_id} to ${POLICY}`,
          );
        }
        const groups: QualityGroup[] | undefined = (p.qualities ?? guide?.qualities)?.map((q: any) => ({
          name: q.name,
          qualities: q.qualities ?? [q.name],
        }));
        if (!groups?.length)
          throw new Error(`"${name}": no qualities: in ${RECYCLARR}, and none under guide.${p.trash_id} in ${POLICY}`);
        found.push({
          app,
          name,
          trashId: p.trash_id ?? null,
          guideQualities: !p.qualities,
          guideUrl: guide?.url ?? null,
          groups,
          upgrade: { allowed: p.upgrade?.allowed ?? null, until: p.upgrade?.until_quality ?? null },
          minFormatScore: p.min_format_score ?? null,
          resetScores: p.reset_unmatched_scores?.enabled === true,
          remux: groups.some((g) => g.qualities.some((q) => /remux/i.test(q))),
          formats: p.trash_id
            ? { kind: 'guide', groups: (cfg.custom_format_groups?.add ?? []).length }
            : {
                kind: 'hand-picked',
                count: (cfg.custom_formats ?? [])
                  .filter((c: any) => c.assign_scores_to?.some((a: any) => a.name === name))
                  .reduce((n: number, c: any) => n + (c.trash_ids?.length ?? 0), 0),
              },
        });
      }
    }
  }

  // Both files name the same profiles, once each.
  const names = found.map((p) => p.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`${RECYCLARR}: two profiles are named "${dup}"`);
  const inData = Object.keys(policy.profiles);
  const onlyYaml = names.filter((n) => !inData.includes(n));
  const onlyData = inData.filter((n) => !names.includes(n));
  if (onlyYaml.length || onlyData.length) {
    const list = (ns: string[]) => ns.map((n) => JSON.stringify(n)).join(', ') || '-';
    throw new Error(
      `${POLICY} and ${RECYCLARR} list different quality profiles.\n` +
        `  only in recyclarr.yml (describe them in profiles.yml): ${list(onlyYaml)}\n` +
        `  only in profiles.yml (remove or rename them): ${list(onlyData)}`,
    );
  }

  const profiles: Profile[] = found.map((p) => {
    const d = policy.profiles[p.name];
    if (d.app !== p.app)
      throw new Error(`${POLICY}: "${p.name}" says app ${d.app}, but recyclarr.yml has it under ${p.app}`);
    return { ...p, ...d };
  });

  // The same facts as arr-policy.ts, which arr-configure applies.
  for (const app of APPS) {
    const defaults = profiles.filter((p) => p.app === app && p.role === 'default').map((p) => p.name);
    const want = arr.DEFAULT_PROFILE[app];
    if (defaults.length !== 1 || defaults[0] !== want) {
      throw new Error(
        `${app}: the default profile is ${JSON.stringify(want)} in ${ARR} (DEFAULT_PROFILE), but ${JSON.stringify(defaults)} in ${POLICY}`,
      );
    }
    const upgrading = profiles
      .filter((p) => p.app === app && p.upgrade.allowed)
      .map((p) => p.name)
      .sort();
    const allowed = [...arr.UPGRADE_PROFILES[app]].sort();
    if (JSON.stringify(upgrading) !== JSON.stringify(allowed)) {
      throw new Error(
        `${app}: ${RECYCLARR} lets ${JSON.stringify(upgrading)} upgrade, but ${ARR} (UPGRADE_PROFILES) allows ${JSON.stringify(allowed)}`,
      );
    }
  }

  return { profiles, sizes };
}

export function profileSlug(name: string): string {
  return (
    'profile-' +
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
  );
}
