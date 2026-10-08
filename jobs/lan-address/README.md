# lan-address

Applies the apps' settings again when the router gives the box new LAN addresses.

## Role

The box gets its addresses by DHCP, and the router has moved them on reboots: wired
`.86` ↔ `.87`, Wi‑Fi `.66` ↔ `.67`. It can't reserve one, and a static address collides
with whatever DHCP hands it to next (`.2` was the printer, `.3` dropped in and out). Four
apps hold the addresses:

- **qBittorrent** (`web_ui_domain_list`) and **Prowlarr, Radarr, Sonarr** (`allowedHosts`)
  refuse a request to an address they don't list: "Unauthorized", "Invalid Hostname".
- **Seerr** links to Radarr and Sonarr by the first one (`externalUrl`).

Their `configure.sh` scripts list the addresses the box has when they run. This job runs
them again for each app whose recorded addresses (in `/opt/appdata/.lan-address`) are not
the current ones. It runs nothing when nothing changed, because Prowlarr's configure
re-syncs its indexers every time. Bazarr and Plex don't depend on the address.

**To find the stack after a change,** `task lan-address:logs`: each change logs
`Stack now at <addresses>`.

## Schedule

2 minutes after every boot, then every 5 minutes:
[`lan-address.timer`](lan-address.timer) runs [`lan-address.service`](lan-address.service),
which runs [`lan-address.sh`](lan-address.sh) from the main clone. `task deploy` installs
both units and always arms the timer.

## Tasks

| task | does |
|---|---|
| `task lan-address:run` | Apply the apps that are behind, now. |
| `task lan-address:dry` | Say which apps are behind. Changes nothing. |
| `task lan-address:force` | Apply every app's address settings, changed or not. |
| `task lan-address:logs` | The last runs' journal, with each address change. |

## Traps

- **An app that fails is retried every 5 minutes**, and only that one. Right after boot
  that's usually an app still starting. Prowlarr's configure also fails when its indexer
  sync takes over 90 s, after it has already applied the addresses; the retry re-syncs.
- **It re-applies the whole app, not just the addresses.** A setting changed by hand in one
  of those apps is put back to what its `configure.sh` says, as `task <app>:configure`
  would. Settings belong in the configure scripts anyway, not the WebUIs.
- **The unit needs `AF_NETLINK`.** `hostname -I` reads the addresses through netlink.
  Without it the job sees no address and does nothing. The test pins it.
- **Once the router can reserve an address,** this job has nothing to do and can stay.
