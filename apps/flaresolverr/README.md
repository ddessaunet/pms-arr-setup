# flaresolverr

Solves Cloudflare challenges for Prowlarr (Phase 3). It is a headless Chromium, the
heaviest part of that phase.

## Role

Prowlarr sends a search through it only for indexers tagged `flare`. Nothing else talks to
it.

## Access

- Not published. Only `flaresolverr:8191` on the `arr` network.

## Secrets

None.

## Settings

None of its own. Which indexers use it is [Prowlarr](../prowlarr/README.md)'s `flare` tag,
set by `apps/prowlarr/configure.sh`.

## Tasks

| task | does |
|---|---|
| `task flaresolverr:logs` / `ps` / `up` / `update` / `update:dry` | The standard app tasks. |
