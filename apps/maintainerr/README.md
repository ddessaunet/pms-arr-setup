# maintainerr

"Leaving soon" shelves on the Plex home screen for old and unwatched titles, with Telegram
alerts (Library cleanup in [docs/phases.md](../../docs/phases.md)).

## Role

Its rules read Plex's watch history, which is the owner's (nobody else watches), and fill
three collections. Each one is a row on the Plex home screen with a red "Leaving {date}"
pill on its posters:

| collection | holds | action, once on |
|---|---|---|
| Leaving Soon - Unwatched Movies | films in the library over 120 days, never played | delete the film |
| Leaving Soon - Watched Movies | films last played over 180 days ago | delete the film |
| Leaving Soon - Watched Seasons | seasons fully watched, the last episode over 60 days ago | delete and unmonitor the season; the show stays monitored for new ones |

A title sits on its shelf for 14 days before its action is due. **Every action is "Do
nothing" for now** (`ACTIONS_ON` in [`configure.ts`](configure.ts)). Maintainerr then skips
those collections when it handles them, so nothing is deleted. The shelves, the dates on
the posters and the alerts all still show what *would* go and when: a date passes and
the title stays.

Once the actions are on, a delete goes through Radarr or Sonarr, never on disk. Radarr
deletes the files, [`arr-reclaim`](../../jobs/arr-reclaim/README.md) frees the torrent and
its data, and Maintainerr clears the Seerr request, so the title can be requested again. No
Radarr import-list exclusion is added.

## Access

- It has **no login**: anyone who reaches it can delete the library. So it publishes no
  LAN port. The browser gets it at **`http://10.0.0.50:8088/maintainerr/`**, through the
  docs nginx and its Plex owner sign-in (`BASE_PATH=/maintainerr`), which is why `docs` is
  on the `arr` network.
- `127.0.0.1:6246/maintainerr/` on the box itself is for `configure.sh` and `stack-status`.
- It reaches Radarr, Sonarr and Seerr by name on the `arr` network, and Plex through the
  host gateway.

## Secrets

- `PLEX_TOKEN`, `RADARR_API_KEY` and `SONARR_API_KEY` from `.env`, and Seerr's own key from
  `/opt/appdata/seerr/settings.json`. No browser sign-in is needed.
- `MAINTAINERR_TELEGRAM_BOT_TOKEN` and `MAINTAINERR_TELEGRAM_CHAT_ID` (optional, both or
  neither):
  1. In Telegram, message **@BotFather**, send `/newbot`, and keep the token it gives you.
  2. Send your new bot any message.
  3. Open `https://api.telegram.org/bot<token>/getUpdates`; `"chat":{"id":…}` is the chat id.

  With neither set, there are no alerts, and the script removes an agent it made earlier.

## Settings

Owned by [`configure.ts`](configure.ts) (`configure.sh` launches it):

- Plex (host, port, name and token), Radarr, Sonarr and Seerr;
- the overlays switched on, with the default poster template ("Classic Pill");
- the Telegram agent `Telegram (pms)`: *about to be handled* 3 days before, *handled*, and
  rule and collection failures;
- the three rule groups and their collections (the table above);
- `KEEP`: titles never put on a shelf, as global exclusions.

What it doesn't own is left alone, and `check` lists it: a rule group or a notification
agent made in the WebUI. Rules belong in `configure.ts`. One edited in the WebUI is drift,
and the next `configure` puts it back.

Switching the actions on is one line, `ACTIONS_ON = true`, and its test is pinned to the
off state, so the change is a deliberate commit:

1. Edit `ACTIONS_ON` and the pinned test in `configure.test.ts`.
2. Run `task lint test`, commit, and `task deploy`.
3. Run `task maintainerr:configure`.

## Tasks

| task | does |
|---|---|
| `task maintainerr:configure` | Apply its settings, then check its Plex, Radarr, Sonarr and Seerr connections. |
| `task maintainerr:check` | Report drift. Changes nothing. |
| `task maintainerr:logs` / `ps` / `up` | The standard app tasks. No `update`: the image is pinned. |

In its WebUI, running the rules from the Rules page fills the collections now, rather than
at the next scheduled run, and the Telegram agent's Test button in its notification
settings sends a test message.

## Traps

- **Never give it a LAN port.** It has no login (CLAUDE.md trap 21).
- **Pinned on purpose.** A release can change what a rule matches: 3.13.0 turned a section
  with no operator from AND into OR. Read the release notes, bump the tag in
  `compose.yaml`, and run `task maintainerr:check` before the next handling run.
- **A PUT of a rule group must be the whole group.** It saves rules only when `useRules`
  is sent, and omitting `notifications` unlinks every agent. `wantGroup` always sends both.
- **Changing a group's library or type wipes its collection** (and its exclusions).
  Maintainerr rebuilds it on the next run, with every title's 14 days starting over.
- **Never use the media-server switch** (*Settings → Media server*). It clears every
  collection and exclusion. The script sets Plex with a plain settings write instead.
- **Taking a title out of `KEEP` doesn't lift its exclusion**, because Maintainerr can't
  list every exclusion. Remove it in the WebUI too.
- **Failures come back as HTTP 200 with `{code: 0}`.** The script checks the body.
