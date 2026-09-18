import { Temporal } from 'temporal-polyfill';

import type { Queryable } from '../db/pool.js';
import { transaction } from '../db/pool.js';

/**
 * Recompute rollups for dirty (project, day) pairs, oldest marking first.
 *
 * The dirty row is deleted only if its `marked_at` is still the one we
 * read: if ingest re-marked the day while we were computing, the newer
 * mark survives and the day is recomputed again on the next pass. That is
 * what makes "no dirty days in range" a sound precondition for the query
 * planner to trust the rollup.
 */
export async function recomputeDirtyDays(limit = 50): Promise<Array<{ projectId: string; day: string }>> {
  const done: Array<{ projectId: string; day: string }> = [];
  // marked_at is read back as text: a JavaScript Date keeps milliseconds,
  // Postgres keeps microseconds, and the equality below must be exact.
  const dirty = await transaction((client) => client.query<{ project_id: string; day: string; marked_at: string; time_zone: string }>('select d.project_id, d.day, d.marked_at::text as marked_at, p.time_zone from rollup_dirty d join projects p on p.id = d.project_id order by d.marked_at limit $1', [limit]));

  for (const row of dirty.rows) {
    await transaction(async (client) => {
      await recomputeDay(client, row.project_id, row.day, row.time_zone);
      await client.query('delete from rollup_dirty where project_id = $1 and day = $2 and marked_at = $3::timestamptz', [row.project_id, row.day, row.marked_at]);
    });
    done.push({ projectId: row.project_id, day: row.day });
  }
  return done;
}

/** Replace the rollup rows for one local day from the raw table. */
export async function recomputeDay(q: Queryable, projectId: string, day: string, timeZone: string): Promise<void> {
  const start = Temporal.PlainDate.from(day).toZonedDateTime(timeZone);
  const from = start.toInstant().toString();
  const to = start.add({ days: 1 }).toInstant().toString();
  await q.query('delete from event_daily where project_id = $1 and day = $2', [projectId, day]);
  await q.query(
    `insert into event_daily (project_id, day, name, count, uniques)
     select $1, $2::date, name, count(*), count(distinct distinct_id)
     from events where project_id = $1 and occurred_at >= $3 and occurred_at < $4
     group by name`,
    [projectId, day, from, to],
  );
}
