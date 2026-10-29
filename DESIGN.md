---
name: Pacman
colors:
  primary: "#2A3FE5"
  primary-text: "#AAB4FF"
  secondary: "#F4B9B0"
  success: "#16A34A"
  success-text: "#6EE79A"
  warning: "#D97706"
  warning-text: "#FBBF5A"
  danger: "#DC2626"
  danger-text: "#FCA5A5"
  plex: "#E5A00D"
  surface: "#080A1C"
  surface-raised: "#0C0F24"
  text: "#C5C9E2"
  text-strong: "#F7F7FB"
  text-muted: "#9097C0"
  neutral: "#080A1C"
typography:
  h1:
    fontFamily: "Press Start 2P"
    fontSize: clamp(1.35rem, 1rem + 1.6vw, 2.1rem)
  h2:
    fontFamily: "Press Start 2P"
    fontSize: clamp(1rem, 0.85rem + 0.6vw, 1.25rem)
  body-md:
    fontFamily: "Space Grotesk"
    fontSize: 1rem
  label-caps:
    fontFamily: "Space Mono"
    fontSize: 0.75rem
  sourceScale: "desktop-first expressive scale"
  weights: "Press Start 2P 400 only; Space Grotesk 300–700; Space Mono 400, 700"
rounded:
  sm: 4px
  md: 8px
spacing:
  sm: 8px
  md: 16px
  sourceScale: "8pt baseline grid"
---

## Overview

Retro arcade-inspired design with pixel fonts, dotted borders, playful high-contrast colors,
and 8-bit game aesthetics, kept readable for a reference site: the pixel font is for
headings, prose is in a plain sans. Implemented in `site/src/styles/pacman.css` (the docs
website, `apps/docs`).

## Style Foundations

- **Visual style:** high-contrast, playful, dotted borders. Cards and question boxes are maze
  walls (a double blue border); connectors and heading rules are rows of pellets (dotted).
- **Typography scale:** desktop-first expressive scale, smaller steps for the pixel font,
  which is wide and tall.
- **Typography fonts:** headings and the site title = Press Start 2P; body = Space Grotesk;
  labels, numbers and code = Space Mono. All self-hosted (`@fontsource`): the site is LAN-only.
- **Color palette:** primary, secondary, success, warning, danger on a navy-tinted dark
  surface. One theme: dark.
- **Spacing scale:** 8pt baseline grid.

## Colors

Contrast is WCAG, against `surface`.

- **Primary (#2A3FE5):** maze blue. Walls, borders and fills only: 2.75:1, too low for text.
- **Primary text (#AAB4FF):** links and blue text, 10:1.
- **Secondary (#F4B9B0):** Pinky. Section headings, the pellet trail, focus rings. 11.6:1.
- **Success (#16A34A) / text (#6EE79A):** the default profile's role colour. 12.7:1 as text.
- **Warning (#D97706) / text (#FBBF5A):** the by-hand profile's role colour, and Pac-Man. 11.9:1.
- **Danger (#DC2626) / text (#FCA5A5):** errors and the dashboard's DOWN. The token itself is
  4.1:1 on the surface, under 4.5:1, so it draws borders only; text uses danger-text, 10.3:1.
- **Plex (#E5A00D):** Plex gold, for the Plex chevron on the login page. A sprite fill
  only, never text.
- **Surface (#080A1C):** the maze at night, navy-tinted rather than pure black, with a faint
  pellet grid.
- **Text (#C5C9E2):** body, 12:1. **Text strong (#F7F7FB):** headings, 18.4:1.
  **Text muted (#9097C0):** labels, 6.9:1.
- **Neutral (#080A1C):** derived from the surface token for official format compatibility.

The first draft had text #111827 on surface #000000, which is 1.18:1 and unreadable; the
text and surface tokens above replace it.

## Layout

Starlight's doc layout, drawn as the maze. Starlight shows the sidebar from 50rem and the
contents beside the page from 72rem; below that, a menu button and a bar under the header
stand in for them.

- **Header and sidebar** are walled off: a 3px maze-blue line under the header and along
  the sidebar's edge. The sidebar is 15rem: it holds four short links.
- **Sidebar links are a pellet trail:** each page is a pellet, and the current page is
  Pinky, the pixel ghost (the arcade sprite, one CSS pixel per sprite pixel), its label text-strong on the accent fill (#141C5C, 14.6:1). Labels are Space
  Mono, text on the raised surface (11.6:1); hover turns them Pinky.
- **Contents** ("On this page") hang off a dotted line, on every page. The title is
  label-caps, text-muted; the current entry is Pinky with a Pinky bar. On the
  quality-profiles page they list each profile card too.
- **No previous / next:** the sidebar already links every page.
- **The menu button** (under 50rem) is a small maze cell, its wall Pinky while the menu is
  open.
- **Content width:** 45rem for prose. The dashboard, the requests, the profile map and the
  control page, which lay cards and tables side by side, and the logs, with their long
  lines, get 72rem.

## Status levels

The dashboard (`/`) shows each service and host item at one of these levels. **The level is
always a word and a mark**; colour only reinforces it. Badge text on its fill:

| level | mark | text on fill | contrast |
|---|---|---|---|
| OK | ● | success-text on success-low | 10:1 |
| Degraded | ◐ | warning-text on warning-low | 10:1 |
| Down | ✕ | danger-text on danger-low | 8.9:1 |
| Unknown, N/A | ?, – | text on the raised surface | 11:1 |
| Stale (was …) | as before | text-muted on the raised surface, dashed border | 6.4:1 |

## Controls

Buttons live on the control page (`/control/`), the login page and the header's Sign out.

- **A button is a maze cell:** text-strong in Space Mono on the accent fill (#141C5C,
  14.6:1), a 2px primary wall that turns Pinky under the pointer, and the site's Pinky focus
  ring. While its action runs it says so ("Deploying…") in Pinky; the others are disabled
  (dashed wall, text-muted on gray), since one action runs at a time.
- **Deploy steps are a row of pellets,** each a word and a mark like the levels: waiting ·,
  running ◐ (Pinky wall), done ● (success), failed ✕ (danger wall, danger-text), skipped –
  (dashed).
- **The login page** (`/login/`) is a splash: one double-walled panel (the deploy panel's
  maze wall) with the chase (the Plex chevron as Pac-Man, its open side the mouth,
  chomping a row of pellets with Pinky after it; still under reduced motion), an "Owner
  only" heading in Pinky, and the Sign in with Plex button. Its message line is text-muted, or the level tones' text (danger-text,
  warning-text) on the raised surface when the sign-in failed or expired, always as a
  sentence.
- **Requests** (`/requests/`) are the dashboard's cards: the title in pixels, the
  verdict's level badge (word and mark, as the status levels), its sentence in text-strong,
  then the next step after a Pinky "Next" label, and the search's details as reasons. The
  ones that need something come first. Analyse is a small maze-cell button; while one
  search runs, every Analyse is disabled and the running one says "Searching…". Ask AI
  is the same button under it ("Asking… 1:23" while it is written, one answer at a time); its answer is an inset
  block on the sunken surface with a brand-blue left wall (a border, never text), a
  Pinky label naming the model, the prose in text, and a text-muted line saying a model
  wrote it. The model picker is a form select beside the page's meta line, or a line of
  text-muted when there is one model.
- **Sign out** is a small maze-cell button at the right of the header, on every page but
  the login page.
- **The Mock tag** is warning-text on warning-low with a warning border, as the Degraded
  badge, beside a sentence saying nothing on the page changes the server. It goes when a
  real control backend replaces the mock.
