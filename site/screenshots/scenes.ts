// The screenshot scenes (task site:screenshot, shoot.ts): a page, what its
// scripts get from /api/ and /live/, and what to do before the picture. The
// answers are made up: the repo is public, so a screenshot never shows the
// live stack (its requests, titles or users). A PR that changes how a page
// looks adds or extends the scenes that show it (.claude/skills/pr-screenshots).

import type { Page } from 'playwright';
import type { AiInfo, RequestReport, RequestsDoc } from '../../stack/lib/request-doctor.ts';

export interface Answer {
  status?: number;
  body: unknown;
}

export interface Scene {
  /** The page, as the site serves it: "/requests/". */
  path: string;
  /** "GET /api/requests" → its answer. Any other /api/ or /live/ call fails the scene. */
  api?: Record<string, Answer>;
  /** What to do once the page has loaded: click, wait for a state. */
  steps?: (page: Page) => Promise<void>;
  /** A selector: the picture is that element only. Without one, the whole page. */
  clip?: string;
}

/** The pages' clock: every scene sees this moment, so "3 days ago" never moves. */
export const NOW = Date.parse('2026-10-29T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const GIB = 1024 ** 3;

// ─── /requests/ ───────────────────────────────────────────────────────────────

const base: Pick<RequestReport, 'requestedBy' | 'seasons' | 'releases' | 'canAnalyse'> = {
  requestedBy: 'owner',
  seasons: [],
  releases: null,
  canAnalyse: false,
};

export const REQUESTS: RequestReport[] = [
  {
    ...base,
    id: 101,
    type: 'movie',
    app: 'radarr',
    title: 'The Glass Orchard',
    year: 2025,
    requestedAt: daysAgo(6),
    profile: 'UHD Bluray + WEB',
    verdict: {
      code: 'size-cap',
      level: 'degraded',
      summary:
        'The best release is over the size cap: 62.4 GB is 412 MB/min for a 155-minute runtime, and Bluray-2160p is capped at 200.',
      details: [
        'Searched 2 hours ago: 128 results, 19 for this title.',
        '7 × Size (e.g. “62.4 GB is over the maximum allowed 30.3 GB”)',
        'Refused for size: The.Glass.Orchard.2025.2160p.UHD.BluRay.x265',
      ],
      next: "Raise Bluray-2160p's cap in stack/lib/arr-policy.ts (SIZE_CAPS), then task arr:configure; or wait for a smaller release.",
    },
    releases: {
      searchedAt: NOW - 2 * 3_600_000,
      total: 128,
      matched: 19,
      approved: 0,
      byResolution: { '2160': 7, '1080': 12 },
      reasons: [{ kind: 'size', label: 'Size', count: 7, example: '62.4 GB is over the maximum allowed 30.3 GB' }],
      best: {
        title: 'The.Glass.Orchard.2025.2160p.UHD.BluRay.x265',
        quality: 'Bluray-2160p',
        size: 62.4 * GIB,
        seeders: 31,
        indexer: 'Example',
      },
      oversize: {
        title: 'The.Glass.Orchard.2025.2160p.UHD.BluRay.x265',
        quality: 'Bluray-2160p',
        size: 62.4 * GIB,
        mbPerMin: 412,
        cap: 200,
      },
    },
    canAnalyse: true,
  },
  {
    ...base,
    id: 105,
    type: 'movie',
    app: 'radarr',
    title: 'Northbound Static',
    year: 2025,
    requestedAt: daysAgo(3),
    profile: '4K HDR or 1080p',
    verdict: {
      code: 'failed',
      level: 'down',
      summary: "The last download could not be imported: Invalid video file, unsupported extension: '.7z'",
      details: ['Northbound.Static.2025.1080p.WEB-DL.H264, 3 hours ago'],
      next: 'Radarr blocklists a failed release and searches again; Analyse to see what is left.',
    },
    canAnalyse: true,
  },
  {
    ...base,
    id: 102,
    type: 'tv',
    app: 'sonarr',
    title: 'Lighthouse Keepers',
    year: 2024,
    requestedAt: daysAgo(2),
    profile: 'WEB-1080p',
    seasons: [2],
    verdict: {
      code: 'unmonitored',
      level: 'degraded',
      summary: '3 missing episodes are unmonitored in Sonarr: never searched.',
      details: ['S02E04', 'S02E05', 'S02E06'],
      next: 'Monitor them in Sonarr.',
    },
  },
  {
    ...base,
    id: 103,
    type: 'movie',
    app: 'radarr',
    title: 'Paper Moons',
    year: 2026,
    requestedAt: daysAgo(1),
    profile: 'UHD Bluray + WEB',
    verdict: {
      code: 'not-analysed',
      level: 'unknown',
      summary: 'Searched when it was added, and nothing was grabbed.',
      details: [],
      next: 'Analyse: search the indexers now and see why each release was refused.',
    },
    canAnalyse: true,
  },
  {
    ...base,
    id: 104,
    type: 'movie',
    app: 'radarr',
    title: 'Saltwater Radio',
    year: 2026,
    requestedAt: daysAgo(0),
    profile: 'UHD Bluray + WEB',
    verdict: {
      code: 'downloading',
      level: 'ok',
      summary: 'Downloading: 42% of 18.6 GB, about 00:18:00 left',
      details: ['Saltwater.Radio.2026.2160p.WEB-DL.DV.HDR.H265'],
      next: null,
    },
  },
];

export const REQUESTS_DOC: RequestsDoc = {
  generatedAt: new Date(NOW - 60_000).toISOString(),
  open: REQUESTS,
  available: 37,
  errors: [],
};

// ─── /requests/ with Ask AI (PR 83) ───────────────────────────────────────────

const AI: AiInfo = {
  models: [
    { id: 'ollama/qwen2.5:3b', provider: 'ollama', model: 'qwen2.5:3b' },
    { id: 'ollama/llama3.2:3b', provider: 'ollama', model: 'llama3.2:3b' },
  ],
  default: 'ollama/qwen2.5:3b',
};

const ADVICE_TEXT = [
  'Radarr found 19 releases of The Glass Orchard, but none fits: every 2160p one is a full Bluray encode of about 62 GB, twice the size cap for a 155-minute film.',
  'Nothing is broken; the releases are just big. A WEB release is usually a third of that size and tends to appear a few weeks after the Bluray.',
  'Next step: wait a week for a WEB release, or pick "4K HDR or 1080p" for it in Seerr to get a 1080p copy now.',
].join('\n\n');

const withAdvice = REQUESTS.map((r) =>
  r.id === 101
    ? {
        ...r,
        advice: {
          text: ADVICE_TEXT,
          provider: 'ollama',
          model: 'qwen2.5:3b',
          at: new Date(NOW - 4 * 60_000).toISOString(),
          seconds: 142,
        },
      }
    : r,
);

const asking = { id: 103, model: 'qwen2.5:3b', startedAt: new Date(NOW - 83_000).toISOString() };

// ─── the scenes ───────────────────────────────────────────────────────────────

export const SCENES: Record<string, Scene> = {
  requests: {
    path: '/requests/',
    api: { 'GET /api/requests': { body: REQUESTS_DOC } },
    steps: (page) => page.locator('[data-request]').first().waitFor(),
    clip: '.req',
  },
  'quality-profiles': { path: '/quality-profiles/' },
  'requests-all-ok': {
    path: '/requests/',
    api: {
      'GET /api/requests': {
        body: { ...REQUESTS_DOC, open: REQUESTS.filter((r) => r.verdict.level === 'ok'), ai: null },
      },
    },
    steps: (page) => page.locator('[data-request]').first().waitFor(),
    clip: '.req',
  },
  'requests-ai': {
    path: '/requests/',
    api: { 'GET /api/requests': { body: { ...REQUESTS_DOC, open: withAdvice, ai: AI, advising: null } } },
    steps: (page) => page.locator('.req-advice').waitFor(),
    clip: '.req',
  },
  'requests-asking': {
    path: '/requests/',
    api: {
      'GET /api/requests': { body: { ...REQUESTS_DOC, ai: AI, advising: asking } },
      'GET /api/requests/103/advise': { body: { state: 'running', job: asking } },
    },
    steps: (page) => page.getByText('Asking… 1:23').waitFor(),
    clip: '[data-request="103"]',
  },
  'requests-one-model': {
    path: '/requests/',
    api: {
      'GET /api/requests': {
        body: {
          ...REQUESTS_DOC,
          open: REQUESTS.slice(0, 1),
          ai: { models: AI.models.slice(0, 1), default: 'ollama/qwen2.5:3b' },
        },
      },
    },
    steps: (page) => page.locator('[data-request]').first().waitFor(),
    clip: '.req',
  },
  'requests-not-set-up': {
    path: '/requests/',
    api: {
      'GET /api/requests': { body: { ...REQUESTS_DOC, open: REQUESTS.slice(0, 1) } },
      'POST /api/requests/101/advise': { status: 404, body: { error: 'not found' } },
    },
    steps: async (page) => {
      await page.getByRole('button', { name: 'Ask AI' }).first().click();
      await page.getByText('AI advice is not set up on this stack-api yet.').waitFor();
    },
    clip: '[data-request="101"]',
  },
};
