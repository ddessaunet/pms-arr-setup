# plex

The media server. It serves the real library, and has since Phase 1b.

## Role

Plex took over from native `plexmediaserver` with a copy of its database, so the server
identity (`f3860770…`) and the watch history carried over. Native Plex is removed (Phase 7b)
and its unit stays masked. Its database is archived in `/root/plexmediaserver-native.tgz`.

## Access

- `:32400` on the host network, the same ports, GDM discovery and LAN detection as the
  native server had.
- Not on the `arr` network. The arrs and Bazarr reach it as `host.docker.internal:32400`.

## Secrets

- `PLEX_CLAIM` (`.env`): only read on a first start with an empty `/config`. Leave it empty
  on a box that already has a config.
- Its token lives in its own `Preferences.xml`. The updater and the configure scripts read
  it there, or from `PLEX_TOKEN`.

## Settings

Set in Plex's own UI, except one: [`configure.sh`](configure.sh) pins **Preferred network
interface** to `eno1`, the wired NIC. The box also has Wi‑Fi on the same subnet, and on
*Any* Plex offered clients both addresses, so some connected to the Wi‑Fi one. The setting
names the interface, not an address, so it holds across the DHCP moves. Its config is
`/opt/appdata/plex`.

## Tasks

| task | does |
|---|---|
| `task plex:logs` / `plex:ps` | Follow its logs / show its container. |
| `task plex:up` | Recreate it from `compose.yaml`, to apply a compose edit. |
| `task plex:configure` / `plex:check` | Pin it to `eno1` / report drift. |
| `task plex:update` / `plex:update:dry` | Update now through the weekly updater, which waits while anyone streams. |

## Traps

- **`/opt/appdata/plex` is the live database**, not a cache. `docker compose down` is safe,
  but deleting or re-seeding that folder loses the library and the watch history. A
  container that comes up with an identity other than `f3860770…` has started on a fresh
  config.
- **The library is mounted at its host path** (`/mnt/data/streaming`), because the
  database stores absolute paths. Don't "tidy" it to `/data`.
- **The library is read-write** on purpose: "Allow media deletion" needs it, and
  [`arr-reclaim`](../../jobs/arr-reclaim/README.md) frees the torrent behind what is
  deleted here.
- **Change the network interface here, not in Plex's UI**: `configure.sh` owns it, and
  `task plex:check` (and the dashboard's hourly drift) reports any other value. It refuses
  to apply if Plex doesn't list `eno1` (`PLEX_IFACE` overrides the name).
- **Don't unmask `plexmediaserver`.** A reinstall would fight the container for `:32400`.
- **No GPU**: the GTX 560 is too old for NVENC, so transcoding runs on the CPU.
- **Downloading subtitles inside Plex is not a permissions problem.** It stores them in its
  database, and `Got a subtitle of 99 bytes` is its subtitle server failing upstream.
  [Bazarr](../bazarr/README.md) writes sidecar `.srt` files instead.
