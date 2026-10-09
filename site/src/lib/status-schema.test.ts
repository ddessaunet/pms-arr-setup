// The job and the page agree on the documents: the job's own golden
// status.json (jobs/stack-status/testdata, written by its test) parses with the
// schema, and with the page's parseStatus.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { StatusSchema } from './status-schema.ts';
import { parseStatus } from './status-view.ts';

const golden = JSON.parse(
  readFileSync(new URL('../../../jobs/stack-status/testdata/status.golden.json', import.meta.url), 'utf8'),
);

test('the job’s golden status.json matches the schema', () => {
  const r = StatusSchema.safeParse(golden);
  assert.ok(r.success, r.success ? '' : JSON.stringify(r.error.issues.slice(0, 3)));
});

test('…and the page can read it', () => {
  const s = parseStatus(golden);
  assert.ok(s);
  assert.equal(s.apps.length, 11);
  assert.ok(s.host.some((h) => h.id === 'lan'));
});
