import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import QueryStream from 'pg-query-stream';
import { z } from 'zod';

import { db } from '../db/pool.js';
import { erasePerson } from '../erasure.js';
import { batchSchema, ingest } from '../ingest.js';
import { csvLine, resultToCsv } from '../query/csv.js';
import { resolveRange } from '../query/range.js';
import { runQuery } from '../query/run.js';
import { querySchema, rangeSchema } from '../query/spec.js';
import { authenticate, type Principal } from './auth.js';

type Env = { Variables: { principal: Principal } };

export function buildApp(): Hono<Env> {
  const app = new Hono<Env>();

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/health') return next();
    const header = c.req.header('authorization') ?? '';
    const principal = await authenticate(header.startsWith('Bearer ') ? header.slice(7) : undefined);
    if (principal === null) return c.json({ error: 'unauthorized' }, 401);
    c.set('principal', principal);
    return next();
  });

  app.post('/api/events', async (c) => {
    const parsed = batchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid', issues: issues(parsed.error) }, 400);
    const { projectId, timeZone } = c.get('principal');
    const result = await ingest(projectId, timeZone, parsed.data.events);
    return c.json(result, result.rejected.length > 0 ? 207 : 202);
  });

  /**
   * Event names seen for the project: everything with a rollup row plus
   * anything raw in the last two days that the worker has not folded in
   * yet. The union keeps this cheap on the raw table (index on project,
   * name, time) while never omitting a name that was just introduced.
   */
  app.get('/api/event-names', async (c) => {
    const { projectId } = c.get('principal');
    const result = await db().query<{ name: string }>(
      `select name from event_daily where project_id = $1
       union
       select distinct name from events where project_id = $1 and occurred_at >= now() - interval '2 days'
       order by name`,
      [projectId],
    );
    return c.json({ names: result.rows.map((r) => r.name) });
  });

  app.post('/api/query', async (c) => {
    const parsed = querySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid', issues: issues(parsed.error) }, 400);
    const { projectId, timeZone } = c.get('principal');
    let result;
    try {
      result = await runQuery(db(), { id: projectId, timeZone }, parsed.data);
    } catch (error) {
      if (error instanceof RangeError) return c.json({ error: 'invalid', issues: [error.message] }, 400);
      throw error;
    }
    if (c.req.query('format') === 'csv') {
      c.header('content-type', 'text/csv; charset=utf-8');
      c.header('content-disposition', `attachment; filename="${parsed.data.metric}.csv"`);
      return c.body(resultToCsv(result));
    }
    return c.json(result);
  });

  /**
   * Raw events as CSV, streamed with a server-side cursor: memory is bounded
   * by the cursor batch, not by the size of the export. This is the one
   * endpoint that returns distinct_id, so it is what an operator would use
   * to answer an access request (Article 15) for a given person.
   */
  app.get('/api/events/export', (c) => {
    const params = rangeSchema.extend({ event: z.string().min(1).max(200).optional(), distinctId: z.string().min(1).max(200).optional() }).safeParse(c.req.query());
    if (!params.success) return c.json({ error: 'invalid', issues: issues(params.error) }, 400);
    const { projectId, timeZone } = c.get('principal');
    let range;
    try {
      range = resolveRange(params.data, timeZone);
    } catch (error) {
      if (error instanceof RangeError) return c.json({ error: 'invalid', issues: [error.message] }, 400);
      throw error;
    }

    const values: unknown[] = [projectId, range.from, range.to];
    let where = 'project_id = $1 and occurred_at >= $2 and occurred_at < $3';
    if (params.data.event !== undefined) where += ` and name = $${values.push(params.data.event)}`;
    if (params.data.distinctId !== undefined) where += ` and distinct_id = $${values.push(params.data.distinctId)}`;

    c.header('content-type', 'text/csv; charset=utf-8');
    c.header('content-disposition', 'attachment; filename="events.csv"');
    return stream(c, async (out) => {
      const client = await db().connect();
      try {
        await out.write(csvLine(['event_id', 'name', 'distinct_id', 'occurred_at', 'properties']));
        const cursor = client.query(new QueryStream(`select event_id, name, distinct_id, occurred_at, properties from events where ${where} order by occurred_at`, values, { batchSize: 500 }));
        for await (const row of cursor as AsyncIterable<{ event_id: string; name: string; distinct_id: string; occurred_at: Date; properties: unknown }>) {
          await out.write(csvLine([row.event_id, row.name, row.distinct_id, row.occurred_at.toISOString(), JSON.stringify(row.properties)]));
        }
      } finally {
        client.release();
      }
    });
  });

  app.delete('/api/persons/:distinctId', async (c) => {
    const { projectId, timeZone } = c.get('principal');
    const result = await erasePerson(projectId, timeZone, c.req.param('distinctId'));
    return c.json(result);
  });

  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: 'internal' }, 500);
  });

  return app;
}

function issues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}
