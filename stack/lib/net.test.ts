// stack/lib/net.test.ts — which addresses count as the box's LAN addresses.

import { describe, expect, test } from 'bun:test';
import { interfaceAddresses, lanAddresses, lanIps } from './net.ts';

describe('lanAddresses (lan_ips)', () => {
  test('IPv6, loopback and Docker bridges are dropped; order is kept', () => {
    expect(
      lanAddresses(['10.0.0.50', '172.17.0.1', '172.18.0.1', 'fe80::1', '127.0.0.1', '192.168.0.86', '172.31.255.1']),
    ).toEqual(['10.0.0.50', '192.168.0.86']);
  });
  test('172 outside 16–31 stays', () => {
    expect(lanAddresses(['172.15.0.1', '172.32.0.1', '172.1.0.1'])).toEqual(['172.15.0.1', '172.32.0.1', '172.1.0.1']);
  });
});

test('lanIps reads the given source', () => {
  expect(lanIps(() => ['172.17.0.1', '10.0.0.50'])).toEqual(['10.0.0.50']);
});

test('this machine has no loopback among its interface addresses', () => {
  expect(interfaceAddresses()).not.toContain('127.0.0.1');
});
