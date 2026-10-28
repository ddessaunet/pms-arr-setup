// stack/lib/redact.test.ts — masking literal secrets and secret shapes.
// stack-status.test.ts covers publishing with them (the leak guard, the files).

import { describe, expect, test } from 'bun:test';
import { leaks, mask, REDACTED, redact } from './redact.ts';

describe('mask', () => {
  test('literal secrets, every occurrence', () => {
    expect(mask('key abc123 and abc123', ['abc123'])).toBe(`key ${REDACTED} and ${REDACTED}`);
  });
  test('shapes, without knowing the value', () => {
    expect(mask('GET /x?X-Plex-Token=zzz&a=1', [])).toBe(`GET /x?X-Plex-Token=${REDACTED}&a=1`);
    expect(mask('apikey=deadbeef', [])).toBe(`apikey=${REDACTED}`);
    expect(mask('http://user:pw@host/', [])).toBe(`http://${REDACTED}@host/`);
    expect(mask('Cookie: pms_session=abc', [])).toBe(`Cookie: ${REDACTED}`);
  });
});

describe('redact', () => {
  test('every string in a document; keys and other values kept', () => {
    expect(redact({ a: ['s3cret!', 1, null], b: { c: 's3cret!' } }, ['s3cret!'])).toEqual({
      a: [REDACTED, 1, null],
      b: { c: REDACTED },
    });
  });
});

describe('leaks', () => {
  test('counts what is left, longest match first, without overlaps', () => {
    expect(leaks('aaa abc ab', ['ab', 'abc'])).toBe(2);
    expect(leaks(REDACTED, ['abc'])).toBe(0);
  });
});
