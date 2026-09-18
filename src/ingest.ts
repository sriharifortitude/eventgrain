import { Temporal } from 'temporal-polyfill';
import { z } from 'zod';

import { ensurePartition, monthOf } from './db/partitions.js';
import { transaction } from './db/pool.js';
import { localDay } from './query/range.js';

export const eventSchema = z.object({
  /** Client-generated. Resending the same id and time is a no-op. */
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  distinctId: z.string().min(1).max(200),
  occurredAt: z.string().datetime({ offset: true }),
  properties: z.record(z.string().max(64), z.union([z.string().max(1000), z.number(), z.boolean(), z.null()])).default({}),
});
export type IncomingEvent = z.infer<typeof eventSchema>;

export const batchSchema = z.object({ events: z.array(eventSchema).min(1).max(1000) });

export interface IngestResult {
  readonly accepted: number;
  readonly duplicates: number;
  readonly rejected: ReadonlyArray<{ index: number; reason: string }>;
}

/**
 * Batched, idempotent ingest. One multi-row insert per batch, one
 * partition check per distinct month in the batch, one dirty-day marking
 * statement -- all in a transaction, so a batch is either fully recorded or
 * not at all.
 *
 * Events more than a day in the future are rejected: they are almost
 * always a client clock bug, and they would otherwise sit in a partition
 * nothing queries until the calendar catches up.
 */
export async function ingest(projectId: string, timeZone: string, events: readonly IncomingEvent[], now = Temporal.Now.instant()): Promise<IngestResult> {
  const horizon = now.add({ hours: 24 });
  const rejected: Array<{ index: number; reason: string }> = [];
  const accepted: IncomingEvent[] = [];
  events.forEach((event, index) => {
    if (Temporal.Instant.compare(Temporal.Instant.from(event.occurredAt), horizon) > 0) rejected.push({ index, reason: 'occurredAt is more than 24 hours in the future' });
    else accepted.push(event);
  });
  if (accepted.length === 0) return { accepted: 0, duplicates: 0, rejected };

  const inserted = await transaction(async (client) => {
    const months = new Map(accepted.map((e) => [monthOf(e.occurredAt).toString(), monthOf(e.occurredAt)]));
    for (const month of months.values()) await ensurePartition(client, month);

    const result = await client.query<{ occurred_at: Date }>(
      `insert into events (project_id, event_id, name, distinct_id, occurred_at, properties)
       select $1, * from unnest($2::uuid[], $3::text[], $4::text[], $5::timestamptz[], $6::jsonb[])
       on conflict do nothing
       returning occurred_at`,
      [projectId, accepted.map((e) => e.id), accepted.map((e) => e.name), accepted.map((e) => e.distinctId), accepted.map((e) => e.occurredAt), accepted.map((e) => JSON.stringify(e.properties))],
    );

    const days = [...new Set(result.rows.map((row) => localDay(row.occurred_at, timeZone)))];
    if (days.length > 0) {
      await client.query('insert into rollup_dirty (project_id, day) select $1, unnest($2::date[]) on conflict do nothing', [projectId, days]);
    }
    return result.rowCount ?? 0;
  });

  return { accepted: inserted, duplicates: accepted.length - inserted, rejected };
}
