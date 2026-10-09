// The dashboard's service list, from the files that own each fact:
//
//   apps/<app>/compose.yaml     which apps exist, and the port each publishes
//   site/src/data/services.yml  what each one is, its web path, and the port of
//                               an app on the host network (Plex)
//
// Pure (strings in, data out) so `task site:test` runs it under plain node.
// Anything that disagrees throws, and a throw fails `astro build`: the page
// never lists a service that does not exist, or misses one that does.

import { parse } from 'yaml';
import { z } from 'astro/zod';

export interface Service {
  id: string;
  label: string;
  role: string;
  /** The host port to link to; null for an app with no web page on the LAN. */
  port: number | null;
  path: string;
}

const Entry = z.strictObject({
  label: z.string().min(1),
  role: z.string().min(1),
  path: z.string().startsWith('/').default('/'),
  port: z.number().int().min(1).max(65535).optional(),
});
const ServicesFile = z.strictObject({ apps: z.record(z.string(), Entry) });

const ComposeService = z.looseObject({
  network_mode: z.string().optional(),
  ports: z.array(z.union([z.string(), z.number()])).optional(),
});
const ComposeFile = z.looseObject({ services: z.record(z.string(), ComposeService) });

export interface Published {
  /** Host side of the first TCP mapping, or null when nothing is published. */
  port: number | null;
  hostNetwork: boolean;
  /** The first TCP mapping is bound to 127.0.0.1: unreachable from the LAN. */
  loopback: boolean;
}

/** What one apps/<app>/compose.yaml publishes for its service of the same name. */
export function published(id: string, composeText: string): Published {
  const file = ComposeFile.parse(parse(composeText));
  const svc = file.services[id];
  if (!svc) throw new Error(`apps/${id}/compose.yaml has no service named "${id}"`);
  const hostNetwork = svc.network_mode === 'host';
  for (const raw of svc.ports ?? []) {
    const spec = String(raw);
    if (spec.endsWith('/udp')) continue;
    // [ip:]host:container[/tcp]
    const parts = spec.replace(/\/tcp$/, '').split(':');
    if (parts.length < 2) continue; // a bare container port publishes a random host port
    const host = Number(parts[parts.length - 2]);
    const ip = parts.length > 2 ? parts.slice(0, -2).join(':') : '';
    return { port: host, hostNetwork, loopback: ip === '127.0.0.1' || ip === 'localhost' };
  }
  return { port: null, hostNetwork, loopback: false };
}

/** composeById: apps/<id>/compose.yaml text by id. In services.yml order. */
export function buildServices(composeById: Record<string, string>, servicesText: string): Service[] {
  const { apps } = ServicesFile.parse(parse(servicesText));
  const ids = Object.keys(composeById).sort();
  const listed = Object.keys(apps);
  const missing = ids.filter((id) => !(id in apps));
  if (missing.length) throw new Error(`services.yml has no entry for apps/${missing.join(', apps/')}`);
  const extra = listed.filter((id) => !(id in composeById));
  if (extra.length) throw new Error(`services.yml lists ${extra.join(', ')}, which has no apps/<app>/compose.yaml`);

  return listed.map((id) => {
    const e = apps[id];
    const pub = published(id, composeById[id]);
    if (pub.loopback) {
      throw new Error(`apps/${id}/compose.yaml binds its port to 127.0.0.1: the LAN cannot reach it`);
    }
    if (pub.port !== null && e.port !== undefined) {
      throw new Error(`${id}: the port is in both compose.yaml (${pub.port}) and services.yml (${e.port}); keep compose's`);
    }
    if (pub.hostNetwork && e.port === undefined) {
      throw new Error(`${id} runs on the host network: give its port in services.yml`);
    }
    return { id, label: e.label, role: e.role, port: pub.port ?? e.port ?? null, path: e.path };
  });
}
