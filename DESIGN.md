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
- **Danger (#DC2626):** errors.
- **Surface (#080A1C):** the maze at night, navy-tinted rather than pure black, with a faint
  pellet grid.
- **Text (#C5C9E2):** body, 12:1. **Text strong (#F7F7FB):** headings, 18.4:1.
  **Text muted (#9097C0):** labels, 6.9:1.
- **Neutral (#080A1C):** derived from the surface token for official format compatibility.

The first draft had text #111827 on surface #000000, which is 1.18:1 and unreadable; the
text and surface tokens above replace it.
