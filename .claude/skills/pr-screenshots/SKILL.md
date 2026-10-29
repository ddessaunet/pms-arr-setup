---
name: pr-screenshots
description: Put screenshots of a UI change in its pull request's description. Use whenever a PR (new or open) changes what the docs site shows — site/src/** (pages, components, client scripts, styles), DESIGN.md or pacman.css — before creating the PR or when updating its description, and when asked for screenshots of the site.
---

# Screenshots in a UI PR

Every PR that changes what the site shows has screenshots of the change in its
description (CLAUDE.md → Conventions). The pictures come from a headless
Chromium on the box with made-up data, never from the live site: the repo is
public, and the live pages show real requests, titles and users.

## When

The diff changes something a person sees on a page: `site/src/**` (an `.astro`
page or component, a `*-client.ts` / `*-view.ts` that renders, `pacman.css`),
`DESIGN.md`, or a site data file that a page shows (`profiles.yml`,
`services.yml`). A change that only touches tests, types or the build is not one.
When unsure, take the screenshot.

## Steps

1. **Scenes.** `site/screenshots/scenes.ts` lists them: a page, its `/api/` and
   `/live/` answers (keyed `"GET /api/requests"`), optional `steps` (click,
   wait for a state) and an optional `clip` selector. Add or extend scenes so
   that each state the change touches is pictured: the normal one, and the
   busy, empty, error or result states it adds. A page without a scene yet gets
   one now, so the next PR has it. The data is made up: fictional titles,
   `owner` as the user, example indexers. Type it with `import type` from the
   module that owns the shape (e.g. `stack/lib/request-doctor.ts`), and check
   it from the repo root with `bun --bun tsc --noEmit -p site` (CI does not
   typecheck `site/`).
   The clock is fixed at `NOW`, and the timezone is UTC.
2. **Shoot.** `task site:screenshot -- <scene>…` builds the site, serves it on a
   loopback port, and writes `site/.screenshots/<scene>.png` (gitignored). A
   scene fails if the page calls an `/api/` or `/live/` path it has no answer
   for, tries to leave the box, or throws. The first time on a machine, run
   `task site:screenshot:install`. Chromium also needs `libasound.so.2`
   (`sudo apt install libasound2t64`, which is the owner's to run).
3. **Look.** Open every PNG with Read and check that it shows the change. Look
   for the right state, readable text, and no "Loading…" or error line you did
   not mean. Shoot again until it does.
4. **Publish.** `stack/pr-screenshots.sh <pr> site/.screenshots/<scene>.png…`
   pushes them to the `pr-screenshots` branch under `pr-<n>/`. It prints one
   `![scene](https://raw.githubusercontent.com/…/<commit>/pr-<n>/<scene>.png)`
   line per image. This push is part of the rule: it needs no separate approval.
   Creating a PR comes first, since the number is in the path.
5. **Describe.** Add a `## Screenshots` section at the end of the PR body:
   - one short line per image saying what state it shows, then the image line
   - a closing line saying it is made-up data, not the live stack
   - write the body to a file and use `gh pr edit <n> --body-file <file>`, or
     `gh pr create … --body-file`, then edit it again once the images are up
   - keep the rest of the body as it was
   - when "Tested" says the change was not tried in a browser, say instead that
     it was rendered headlessly with made-up data

The scenes you add are part of the PR: commit them with the change. When the
scene file isn't on the PR's branch yet (an older branch), shoot from a scratch
worktree of the branch with main merged in (never pushed), and leave the
scenes out of the PR.
