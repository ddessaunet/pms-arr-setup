// stack/lib/net.ts — the box's own LAN addresses.
//
// lan_ips in the bash scripts: every IPv4 address `hostname -I` lists, minus
// loopback and Docker's bridges (172.16.0.0/12). These are what the apps must
// list as allowed hosts (trap 18).
//
// Reading interfaces takes netlink. A job whose unit restricts address
// families (RestrictAddressFamilies) without AF_NETLINK gets none: call this
// only from scripts that may, or add the family to the unit on purpose.

import { networkInterfaces } from 'node:os';

/** The addresses in a list that count as LAN addresses, in order. */
export function lanAddresses(addresses: readonly string[]): string[] {
  return addresses.filter(
    (ip) => !ip.includes(':') && !ip.startsWith('127.') && !/^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip),
  );
}

/** Every address of every interface, as hostname -I lists them (loopback aside). */
export function interfaceAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((list) =>
    (list ?? []).filter((a) => !a.internal).map((a) => a.address),
  );
}

/** The box's LAN IPv4 addresses. */
export function lanIps(addresses: () => readonly string[] = interfaceAddresses): string[] {
  return lanAddresses(addresses());
}
