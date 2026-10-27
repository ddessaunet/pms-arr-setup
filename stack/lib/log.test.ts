// stack/lib/log.test.ts — strftime against date(1)'s formats, in two time zones.

import { afterEach, describe, expect, test } from 'bun:test';
import { stamped, strftime } from './log.ts';

const savedTz = process.env.TZ;
afterEach(() => {
  process.env.TZ = savedTz;
});

// 2026-10-23 21:04:05 UTC
const T = new Date(Date.UTC(2026, 9, 23, 21, 4, 5));

describe('strftime', () => {
  test('UTC', () => {
    process.env.TZ = 'UTC';
    expect(strftime('%F %T', T)).toBe('2026-10-23 21:04:05');
    expect(strftime('%Y-%m-%dT%H:%M:%S%z', T)).toBe('2026-10-23T21:04:05+0000');
  });

  test('Buenos Aires (the box), a negative offset', () => {
    process.env.TZ = 'America/Argentina/Buenos_Aires';
    expect(strftime('%F %T', T)).toBe('2026-10-23 18:04:05');
    expect(strftime('%z', T)).toBe('-0300');
  });

  test('a half-hour offset', () => {
    process.env.TZ = 'Asia/Kolkata';
    expect(strftime('%T%z', T)).toBe('02:34:05+0530');
  });

  test('the date rolls over in local time', () => {
    process.env.TZ = 'America/Argentina/Buenos_Aires';
    expect(strftime('%F', new Date(Date.UTC(2026, 0, 1, 1, 0, 0)))).toBe('2025-12-31');
  });

  test('%a: the weekday in local time, as jq prints it', () => {
    process.env.TZ = 'UTC';
    expect(strftime('%a %H:%M', T)).toBe('Fri 21:04');
    process.env.TZ = 'Asia/Kolkata';
    expect(strftime('%a', T)).toBe('Sat');
    expect(strftime('%a', T)).toBe(
      Bun.spawnSync(['date', '-d', '@' + T.getTime() / 1000, '+%a'], { env: { ...process.env, LC_ALL: 'C' } })
        .stdout.toString()
        .trim(),
    );
  });

  test('%s, %% and unknown letters', () => {
    expect(strftime('%s', T)).toBe(String(T.getTime() / 1000));
    expect(strftime('100%% %q', T)).toBe('100% %q');
  });

  test('matches date(1) now', () => {
    for (const tz of ['UTC', 'America/Argentina/Buenos_Aires']) {
      process.env.TZ = tz;
      const now = new Date(Math.floor(Date.now() / 1000) * 1000);
      const r = Bun.spawnSync(['date', '-d', `@${now.getTime() / 1000}`, '+%F %T %z'], {
        env: { ...process.env, TZ: tz },
      });
      expect(strftime('%F %T %z', now)).toBe(r.stdout.toString().trim());
    }
  });
});

describe('stamped', () => {
  test('stamps, then the prefix', () => {
    process.env.TZ = 'UTC';
    const lines: string[] = [];
    stamped(
      'reclaim: ',
      (l) => lines.push(l),
      () => T,
    )('removed x');
    expect(lines).toEqual(['[2026-10-23 21:04:05] reclaim: removed x']);
  });
});
