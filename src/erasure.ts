import { createHash } from 'node:crypto';

import { transaction } from './db/pool.js';
import { localDay } from './query/range.js';

/**
 * Article 17. Delete every raw event for a person, mark the days they
 * touched for recomputation so no aggregate still counts them, and log
 * that it happened -- by hash, so the log is not itself a copy of the id.
 *
 * Rollups are not edited here: the worker recomputes dirty days from the
 * raw table, which no longer contains the person. Until it does, queries
 * over those days go to the raw table, which is already correct.
 */
export async function erasePerson(projectId: string, timeZone: string, distinctId: string): Promise<{ eventsDeleted: number }> {
  return transaction(async (client) => {
    const touched = await client.query<{ occurred_at: Date }>('select distinct occurred_at from events where project_id = $1 and distinct_id = $2', [projectId, distinctId]);
    const days = [...new Set(touched.rows.map((row) => localDay(row.occurred_at, timeZone)))];

    const deleted = await client.query('delete from events where project_id = $1 and distinct_id = $2', [projectId, distinctId]);
    const eventsDeleted = deleted.rowCount ?? 0;

    if (days.length > 0) {
      await client.query('insert into rollup_dirty (project_id, day) select $1, unnest($2::date[]) on conflict do nothing', [projectId, days]);
    }
    await client.query('insert into erasures (project_id, distinct_id_hash, events_deleted) values ($1, $2, $3)', [projectId, createHash('sha256').update(distinctId).digest(), eventsDeleted]);
    return { eventsDeleted };
  });
}
