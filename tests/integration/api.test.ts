import { randomUUID } from 'node:crypto';

import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/api/app.js';
import { createProject } from '../../src/api/auth.js';
import { dropExpiredPartitions, ensurePartition, listPartitions } from '../../src/db/partitions.js';
import { closeDb, db } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import type { FunnelResult, RetentionResult, SeriesResult } from '../../src/query/run.js';
import { recomputeDirtyDays } from '../../src/worker/rollups.js';

/**
 * Against the real database. One project in Europe/Berlin; every expected
 * number below was worked out by hand from the events ingested, and the
 * dates are chosen to straddle the October 2025 clock change.
 */

const app = buildApp();
let projectId: string;
let key: string;

const NOW = Temporal.Instant.from('2025-11-15T12:00:00Z');

function ev(name: string, distinctId: string, occurredAt: string, properties: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: randomUUID(), name, distinctId, occurredAt, properties };
}

async function post<T>(path: string, body: unknown, auth = key): Promise<{ status: number; body: T }> {
  const response = await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as T };
}

async function query<T>(spec: unknown): Promise<T> {
  const { status, body } = await post<T>('/api/query', spec);
  expect(status).toBe(200);
  return body;
}

beforeAll(async () => {
  await migrate();
  const project = await createProject(db(), 'Integration', 'Europe/Berlin');
  projectId = project.id;
  key = project.key;
});

afterAll(async () => {
  await db().query('delete from events where project_id = $1', [projectId]);
  await db().query('delete from projects where id = $1', [projectId]);
  await closeDb();
});

describe('authentication', () => {
  it('rejects a missing, malformed or revoked key', async () => {
    expect((await app.request('/api/query', { method: 'POST' })).status).toBe(401);
    expect((await post('/api/query', {}, 'eg_nope')).status).toBe(401);
    await db().query('update api_keys set revoked_at = now() where project_id = $1', [projectId]);
    expect((await post('/api/query', {}, key)).status).toBe(401);
    await db().query('update api_keys set revoked_at = null where project_id = $1', [projectId]);
  });
});

describe('ingest', () => {
  it('creates the month partition on demand, deduplicates, rejects the future, marks days dirty', async () => {
    const before = (await listPartitions(db())).map((p) => p.name);
    const dup = ev('pageview', 'p1', '2025-10-25T10:00:00Z');
    const first = await post<{ accepted: number; duplicates: number; rejected: unknown[] }>('/api/events', { events: [dup, ev('pageview', 'p2', '2025-10-25T11:00:00Z')] });
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ accepted: 2, duplicates: 0, rejected: [] });

    const second = await post<{ accepted: number; duplicates: number; rejected: unknown[] }>('/api/events', { events: [dup, ev('pageview', 'p3', '2099-01-01T00:00:00Z')] });
    expect(second.status).toBe(207);
    expect(second.body).toEqual({ accepted: 0, duplicates: 1, rejected: [{ index: 1, reason: 'occurredAt is more than 24 hours in the future' }] });

    const after = (await listPartitions(db())).map((p) => p.name);
    expect(after).toContain('events_y2025m10');
    expect(after.length).toBeGreaterThanOrEqual(before.length);

    const dirty = await db().query<{ day: string }>('select day from rollup_dirty where project_id = $1 order by day', [projectId]);
    expect(dirty.rows.map((r) => r.day)).toEqual(['2025-10-25']);
  });

  it('validates the batch shape', async () => {
    const r = await post<{ issues: string[] }>('/api/events', { events: [{ id: 'not-a-uuid', name: '', distinctId: 'x', occurredAt: 'yesterday' }] });
    expect(r.status).toBe(400);
    expect(r.body.issues.join('\n')).toMatch(/events\.0\.id/);
    expect(r.body.issues.join('\n')).toMatch(/events\.0\.occurredAt/);
  });
});

describe('series across the fall-back weekend (Berlin, 26 Oct 2025)', () => {
  beforeAll(async () => {
    // Saturday 25th: 2 pageviews already ingested at 12:00 and 13:00 local.
    // Sunday 26th: the repeated hour. 00:30Z is 02:30 CEST, 01:30Z is 02:30 CET.
    // Monday 27th: one more, 09:00 CET = 08:00Z.
    await post('/api/events', {
      events: [
        ev('pageview', 'p1', '2025-10-26T00:30:00Z', { country: 'DE' }),
        ev('pageview', 'p1', '2025-10-26T01:30:00Z', { country: 'DE' }),
        ev('pageview', 'p4', '2025-10-26T01:45:00Z', { country: 'FR' }),
        ev('pageview', 'p4', '2025-10-26T22:30:00Z', { country: 'FR' }), // 23:30 CET Sunday -- still the 26th locally
        ev('pageview', 'p5', '2025-10-26T23:30:00Z', { country: 'DE' }), // 00:30 CET Monday
        ev('pageview', 'p1', '2025-10-27T08:00:00Z', { country: 'DE' }),
      ],
    });
  });

  it('day buckets are local days; the answer comes from raw while days are dirty', async () => {
    const r = await query<SeriesResult>({ metric: 'count', event: 'pageview', range: { from: '2025-10-25', to: '2025-10-27' }, bucket: 'day' });
    expect(r.source).toBe('raw');
    expect(r.series).toEqual([
      { bucket: '2025-10-25T00:00:00', value: 2 },
      { bucket: '2025-10-26T00:00:00', value: 4 },
      { bucket: '2025-10-27T00:00:00', value: 2 },
    ]);
  });

  it('after the rollup worker runs the same query is served from rollups with identical values', async () => {
    const done = await recomputeDirtyDays();
    expect(done.map((d) => d.day).sort()).toEqual(['2025-10-25', '2025-10-26', '2025-10-27']);

    const r = await query<SeriesResult>({ metric: 'count', event: 'pageview', range: { from: '2025-10-25', to: '2025-10-27' }, bucket: 'day' });
    expect(r.source).toBe('rollup');
    expect(r.series.map((p) => p.value)).toEqual([2, 4, 2]);

    // Uniques per day from rollups: Sat p1,p2; Sun p1,p4; Mon p5,p1 (p5's 23:30Z is 00:30 CET Monday).
    const u = await query<SeriesResult>({ metric: 'unique', event: 'pageview', range: { from: '2025-10-25', to: '2025-10-27' }, bucket: 'day' });
    expect(u.source).toBe('rollup');
    expect(u.series.map((p) => p.value)).toEqual([2, 2, 2]);
  });

  it('uniques over a week bucket are not additive, so they come from raw', async () => {
    const r = await query<SeriesResult>({ metric: 'unique', event: 'pageview', range: { from: '2025-10-20', to: '2025-10-26' }, bucket: 'week' });
    expect(r.source).toBe('raw');
    // Week of 20 Oct: p1, p2, p4 distinct. p5 is Monday the 27th, next week.
    expect(r.series).toEqual([{ bucket: '2025-10-20T00:00:00', value: 3 }]);
  });

  it('hour buckets merge the repeated 02:00 and a partial-day range is answered from raw', async () => {
    const r = await query<SeriesResult>({ metric: 'count', event: 'pageview', range: { from: '2025-10-26T00:00:00Z', to: '2025-10-26T03:00:00Z' }, bucket: 'hour' });
    expect(r.source).toBe('raw');
    // 00:00Z=02:00 CEST, 01:00Z=02:00 CET (same label), 02:00Z=03:00 CET.
    expect(r.series).toEqual([
      { bucket: '2025-10-26T02:00:00', value: 3 },
      { bucket: '2025-10-26T03:00:00', value: 0 },
    ]);
  });

  it('filters and group-by force raw and zero-fill every group', async () => {
    const r = await query<SeriesResult>({ metric: 'count', event: 'pageview', range: { from: '2025-10-26', to: '2025-10-27' }, bucket: 'day', groupBy: 'country' });
    expect(r.source).toBe('raw');
    expect(r.series).toEqual([
      { bucket: '2025-10-26T00:00:00', group: 'DE', value: 2 },
      { bucket: '2025-10-26T00:00:00', group: 'FR', value: 2 },
      { bucket: '2025-10-27T00:00:00', group: 'DE', value: 2 },
      { bucket: '2025-10-27T00:00:00', group: 'FR', value: 0 },
    ]);
    const f = await query<SeriesResult>({ metric: 'unique', event: 'pageview', range: { from: '2025-10-25', to: '2025-10-27' }, bucket: 'month', filter: { country: 'FR' } });
    expect(f.series).toEqual([{ bucket: '2025-10-01T00:00:00', value: 1 }]);
  });

  it('exports as CSV', async () => {
    const response = await app.request('/api/query?format=csv', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ metric: 'count', event: 'pageview', range: { from: '2025-10-25', to: '2025-10-27' } }) });
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(await response.text()).toBe('bucket,count\r\n2025-10-25T00:00:00,2\r\n2025-10-26T00:00:00,4\r\n2025-10-27T00:00:00,2\r\n');
  });
});

describe('funnel', () => {
  beforeAll(async () => {
    await post('/api/events', {
      events: [
        // A: view -> cart -> purchase, all inside 3 days.
        ev('view', 'A', '2025-11-02T10:00:00Z'), ev('cart', 'A', '2025-11-03T10:00:00Z'), ev('purchase', 'A', '2025-11-04T10:00:00Z'),
        // B: view -> purchase with no cart: counts for step 1 only (steps are ordered).
        ev('view', 'B', '2025-11-02T10:00:00Z'), ev('purchase', 'B', '2025-11-02T11:00:00Z'),
        // C: cart arrives after the window from the first view.
        ev('view', 'C', '2025-11-02T10:00:00Z'), ev('cart', 'C', '2025-11-06T10:00:00Z'),
        // D: cart before view does not count; no cart after.
        ev('cart', 'D', '2025-11-02T09:00:00Z'), ev('view', 'D', '2025-11-02T10:00:00Z'),
        // E: view then cart, but the purchase is exactly at the window edge (excluded, half-open).
        ev('view', 'E', '2025-11-02T10:00:00Z'), ev('cart', 'E', '2025-11-02T12:00:00Z'), ev('purchase', 'E', '2025-11-05T10:00:00Z'),
      ],
    });
  });

  it('counts people who did each step in order within the window of step 1', async () => {
    const r = await query<FunnelResult>({ metric: 'funnel', steps: ['view', 'cart', 'purchase'], range: { from: '2025-11-01', to: '2025-11-08' }, windowDays: 3 });
    expect(r.steps).toEqual([
      { event: 'view', count: 5, conversion: 1 },
      { event: 'cart', count: 2, conversion: 0.4 }, // A and E
      { event: 'purchase', count: 1, conversion: 0.2 }, // A only
    ]);
  });
});

describe('retention', () => {
  beforeAll(async () => {
    // Cohort week Mon 2025-11-03: r1, r2, r3 sign up. Cohort week 2025-11-10: r4.
    await post('/api/events', {
      events: [
        ev('signup', 'r1', '2025-11-04T10:00:00Z'), ev('signup', 'r2', '2025-11-05T10:00:00Z'), ev('signup', 'r3', '2025-11-09T22:30:00Z'), // 23:30 CET Sunday -- still week of the 3rd
        ev('signup', 'r4', '2025-11-11T10:00:00Z'),
        ev('session', 'r1', '2025-11-04T11:00:00Z'), ev('session', 'r1', '2025-11-12T10:00:00Z'), ev('session', 'r1', '2025-11-19T10:00:00Z'),
        ev('session', 'r2', '2025-11-13T10:00:00Z'),
        ev('session', 'r3', '2025-10-31T10:00:00Z'), // before their cohort: period -1, ignored
        ev('session', 'r4', '2025-11-18T10:00:00Z'),
      ],
    });
  });

  it('builds a weekly cohort matrix in local weeks', async () => {
    const r = await query<RetentionResult>({ metric: 'retention', start: 'signup', returning: 'session', range: { from: '2025-11-03', to: '2025-11-16' }, periods: 2 });
    expect(r.cohorts).toEqual([
      { cohort: '2025-11-03', size: 3, periods: [1, 2, 1] }, // wk0: r1; wk1: r1, r2; wk2: r1
      { cohort: '2025-11-10', size: 1, periods: [0, 1, 0] }, // r4 returns the following week
    ]);
  });
});

describe('erasure and export', () => {
  it('streams raw events for one person as CSV, then erases them everywhere', async () => {
    const exportFor = async (): Promise<string> => (await app.request('/api/events/export?from=2025-10-25&to=2025-10-27&distinctId=p4', { headers: { authorization: `Bearer ${key}` } })).text();
    const before = (await exportFor()).split('\r\n').filter(Boolean);
    expect(before[0]).toBe('event_id,name,distinct_id,occurred_at,properties');
    expect(before).toHaveLength(3);
    expect(before[1]).toMatch(/,pageview,p4,2025-10-26T01:45:00.000Z,"{""country"":""FR""}"$/);

    await recomputeDirtyDays();
    const response = await app.request('/api/persons/p4', { method: 'DELETE', headers: { authorization: `Bearer ${key}` } });
    expect(await response.json()).toEqual({ eventsDeleted: 2 });

    expect((await exportFor()).split('\r\n').filter(Boolean)).toHaveLength(1);

    // The day is dirty again, so the series is answered from raw and no longer counts p4: only p1 is left on Sunday...
    const raw = await query<SeriesResult>({ metric: 'unique', event: 'pageview', range: { from: '2025-10-26', to: '2025-10-26' } });
    expect(raw.source).toBe('raw');
    expect(raw.series[0]?.value).toBe(1);
    // ...and once recomputed, the rollup agrees.
    await recomputeDirtyDays();
    const rolled = await query<SeriesResult>({ metric: 'unique', event: 'pageview', range: { from: '2025-10-26', to: '2025-10-26' } });
    expect(rolled.source).toBe('rollup');
    expect(rolled.series[0]?.value).toBe(1);

    const log = await db().query<{ events_deleted: number; distinct_id_hash: Buffer }>('select events_deleted, distinct_id_hash from erasures where project_id = $1', [projectId]);
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]!.events_deleted).toBe(2);
    expect(log.rows[0]!.distinct_id_hash.toString('hex')).not.toContain('p4');
  });
});

describe('retention by partition drop', () => {
  it('drops only partitions older than the retention window', async () => {
    await ensurePartition(db(), Temporal.PlainYearMonth.from('2023-01'));
    await ensurePartition(db(), Temporal.PlainYearMonth.from('2024-11'));
    const dropped = await dropExpiredPartitions(db(), 12, NOW); // cutoff: 2024-11; strictly older is dropped
    expect(dropped).toEqual(['events_y2023m01']);
    const names = (await listPartitions(db())).map((p) => p.name);
    expect(names).toContain('events_y2024m11');
    expect(names).toContain('events_y2025m10');
    await db().query('drop table events_y2024m11');
  });
});
