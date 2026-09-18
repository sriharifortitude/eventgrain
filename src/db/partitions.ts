import { Temporal } from 'temporal-polyfill';

import type { Queryable } from './pool.js';

/**
 * Month partitions of `events`, named events_yYYYYmMM and bounded in UTC.
 * Partition bounds are about storage layout, not reporting, so UTC months
 * are fine: a query for a Berlin day near a month boundary touches two
 * partitions at most, and the planner prunes the rest.
 */

export function partitionName(month: Temporal.PlainYearMonth): string {
  return `events_y${month.year}m${String(month.month).padStart(2, '0')}`;
}

export function monthOf(instant: string | Date): Temporal.PlainYearMonth {
  const iso = instant instanceof Date ? instant.toISOString() : instant;
  return Temporal.Instant.from(iso).toZonedDateTimeISO('UTC').toPlainDate().toPlainYearMonth();
}

/** Idempotent. Safe to call from every ingest batch; a no-op after the first time. */
export async function ensurePartition(q: Queryable, month: Temporal.PlainYearMonth): Promise<void> {
  const from = month.toPlainDate({ day: 1 }).toString();
  const to = month.add({ months: 1 }).toPlainDate({ day: 1 }).toString();
  // Identifiers cannot be parameters; the name is built from two integers.
  await q.query(`create table if not exists ${partitionName(month)} partition of events for values from ('${from}T00:00:00Z') to ('${to}T00:00:00Z')`);
}

/** Create partitions for this month and the next `ahead` months. */
export async function ensurePartitionsAhead(q: Queryable, ahead: number, now = Temporal.Now.instant()): Promise<void> {
  const current = monthOf(now.toString());
  for (let i = 0; i <= ahead; i += 1) await ensurePartition(q, current.add({ months: i }));
}

export async function listPartitions(q: Queryable): Promise<Array<{ name: string; month: Temporal.PlainYearMonth }>> {
  const result = await q.query<{ relname: string }>(`
    select c.relname from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    join pg_class p on p.oid = i.inhparent
    where p.relname = 'events' order by c.relname`);
  return result.rows.map((row) => {
    const match = /^events_y(\d{4})m(\d{2})$/.exec(row.relname);
    if (match === null) throw new Error(`unexpected partition name ${row.relname}`);
    return { name: row.relname, month: Temporal.PlainYearMonth.from({ year: Number(match[1]), month: Number(match[2]) }) };
  });
}

/**
 * Drop every partition whose month ended more than `retentionMonths` ago.
 * Returns what was dropped. Rollups are untouched: they are aggregates, not
 * personal data, and the point of retention is to stop holding the latter.
 */
export async function dropExpiredPartitions(q: Queryable, retentionMonths: number, now = Temporal.Now.instant()): Promise<string[]> {
  const cutoff = monthOf(now.toString()).subtract({ months: retentionMonths });
  const dropped: string[] = [];
  for (const partition of await listPartitions(q)) {
    if (Temporal.PlainYearMonth.compare(partition.month, cutoff) < 0) {
      await q.query(`drop table ${partition.name}`);
      dropped.push(partition.name);
    }
  }
  return dropped;
}
