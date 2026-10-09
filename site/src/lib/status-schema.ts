// The contract between jobs/stack-status/stack-status.sh (bash + jq) and the
// dashboard. Used by the tests only, so zod stays out of the page's script:
// status-schema.test.ts parses the job's golden status.json with it.

import { z } from 'astro/zod';

const Level = z.enum(['ok', 'degraded', 'down', 'unknown', 'n/a']);
const Reason = z.strictObject({ level: z.enum(['down', 'degraded', 'notice']), text: z.string() });
const Item = z.looseObject({
  id: z.string(),
  level: Level,
  summary: z.string(),
  reasons: z.array(Reason),
  facts: z.record(z.string(), z.unknown()),
});

export const StatusSchema = z.strictObject({
  schema: z.literal(1),
  generatedAt: z.string(),
  generatedAtEpoch: z.number().int(),
  runSeconds: z.number().int().min(0),
  staleAfterSeconds: z.number().int().positive(),
  overall: Level,
  counts: z.record(z.string(), z.number().int()),
  notes: z.array(z.string()),
  lan: z.array(z.strictObject({ iface: z.string(), addr: z.string() })),
  apps: z.array(Item),
  host: z.array(Item.extend({ kind: z.string(), label: z.string() })),
});
