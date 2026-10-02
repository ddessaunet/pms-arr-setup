# arr-reclaim

When media that Radarr or Sonarr imported is deleted, in Plex or in Radarr/Sonarr with its
files, this job removes its torrent and data from [qBittorrent](../../apps/qbittorrent/README.md).
The space comes back right away instead of after the seeding limit. It is pms-local's
`plex-watch`, ported for the `:8081` instance.

## Role

It removes a torrent only when all three of these hold:

1. **Radarr/Sonarr imported it.** Its hash is, or was, in their import history
   (`eventType=3`).
2. **Every file it imported is gone.**
3. **No other link remains.** A file that was moved or renamed is still linked somewhere, so
   it keeps its torrent.

If only some of a torrent's imports are gone (one episode of a season pack), it is
`partial`: reported and kept.

Deleting a title in Radarr/Sonarr wipes its history, so the imports it has seen are kept in
`/opt/appdata/.arr-reclaim.imports`, recorded every minute, and it decides from both.

## Schedule

Always running: `arr-reclaim.service` watches the library and reclaims after each burst of
deletions. [`arr-reclaim.service`](arr-reclaim.service) runs
[`arr-reclaim.sh`](arr-reclaim.sh) `watch` from the main clone. `task deploy` installs,
enables and restarts it on every run, because a change to the script alone doesn't show in
the unit file.

## Tasks

| task | does |
|---|---|
| `task arr-reclaim:audit` | What it would remove right now. Changes nothing. |
| `task arr-reclaim:status` / `arr-reclaim:logs` | The unit's state / its journal. |

## Traps

- **Don't loosen the rule to "it's in the category".** A finished but not yet imported
  download has no library link either.
- **Don't replace the record of imports with a post-import category.** Radarr and Sonarr
  only list their own category, so *Remove Completed* would stop seeing imported torrents.
- **It only removes what was imported.** [Decluttarr](../../apps/decluttarr/README.md)
  only removes what wasn't, so the two never meet.
- **Torrents moved over from native qBittorrent** aren't in the import history, so it never
  reclaims them.
