import { describe, expect, it } from 'vitest';

import { csvLine, resultToCsv } from '../../src/query/csv.js';
import { funnel, retention, seriesFromRaw, seriesFromRollup } from '../../src/query/sql.js';
import { querySchema } from '../../src/query/spec.js';

const P = '11111111-1111-1111-1111-111111111111';
const range = { from: '2026-08-31T22:00:00Z', to: '2026-09-30T22:00:00Z' };

describe('SQL builders keep every request value out of the SQL text', () => {
  it('series from raw: names, filters and the group key are parameters', () => {
    const spec = querySchema.parse({ metric: 'unique', event: "signup'); drop table events; --", range: { from: '2026-09-01', to: '2026-09-30' }, bucket: 'week', filter: { plan: 'pro', trial: true }, groupBy: 'country' });
    if (spec.metric !== 'unique') throw new Error();
    const sql = seriesFromRaw(P, spec, range, 'Europe/Berlin');
    expect(sql.text).toBe('select date_trunc($6, occurred_at at time zone $5) as bucket, properties ->> $8 as "group", count(distinct distinct_id)::bigint as value from events where project_id = $1 and name = $2 and occurred_at >= $3 and occurred_at < $4 and properties @> $7::jsonb group by 1, 2 order by 1, 2');
    expect(sql.values).toEqual([P, "signup'); drop table events; --", range.from, range.to, 'Europe/Berlin', 'week', '{"plan":"pro","trial":true}', 'country']);
    expect(sql.text).not.toContain('drop');
  });

  it('series from rollup sums counts and converts the instant bounds to local dates', () => {
    const spec = querySchema.parse({ metric: 'count', event: 'pageview', range: { from: '2026-09-01', to: '2026-09-30' }, bucket: 'month' });
    if (spec.metric !== 'count') throw new Error();
    const sql = seriesFromRollup(P, spec, range, 'Europe/Berlin');
    expect(sql.text).toContain('sum(count)::bigint as value from event_daily');
    expect(sql.text).toContain('day >= ($3::timestamptz at time zone $5)::date and day < ($4::timestamptz at time zone $5)::date');
    expect(sql.values).toEqual([P, 'pageview', range.from, range.to, 'Europe/Berlin', 'month']);
  });

  it('a property key outside the allowed alphabet is rejected by the schema, not escaped', () => {
    const result = querySchema.safeParse({ metric: 'count', event: 'x', range: { from: '2026-09-01', to: '2026-09-30' }, groupBy: "a' or 1=1" });
    expect(result.success).toBe(false);
  });

  it('funnel chains one CTE per step with the window anchored on step 1', () => {
    const spec = querySchema.parse({ metric: 'funnel', steps: ['view', 'add_to_cart', 'purchase'], range: { from: '2026-09-01', to: '2026-09-30' }, windowDays: 3 });
    if (spec.metric !== 'funnel') throw new Error();
    const sql = funnel(P, spec, range);
    expect(sql.values).toEqual([P, range.from, range.to, '3 days', 'view', 'add_to_cart', 'purchase']);
    expect(sql.text).toMatch(/^with s1 as \(select distinct_id, min\(occurred_at\) as t, min\(occurred_at\) as t1 from events where project_id = \$1 and name = \$5/);
    expect(sql.text).toContain('s2 as (select s1.distinct_id, (select min(e.occurred_at) from events e where e.project_id = $1 and e.distinct_id = s1.distinct_id and e.name = $6 and e.occurred_at > s1.t and e.occurred_at < s1.t1 + $4::interval) as t, s1.t1 from s1 where s1.t is not null)');
    expect(sql.text).toContain('s3 as (select s2.distinct_id, (select min(e.occurred_at) from events e where e.project_id = $1 and e.distinct_id = s2.distinct_id and e.name = $7 and e.occurred_at > s2.t and e.occurred_at < s2.t1 + $4::interval) as t, s2.t1 from s2 where s2.t is not null)');
    expect(sql.text).toMatch(/select \(select count\(t\) from s1\)::bigint as step1, \(select count\(t\) from s2\)::bigint as step2, \(select count\(t\) from s3\)::bigint as step3$/);
  });

  it('retention floors the period so a return before the cohort week is negative, not zero', () => {
    const spec = querySchema.parse({ metric: 'retention', start: 'signup', returning: 'session', range: { from: '2026-09-01', to: '2026-09-30' }, periods: 4 });
    if (spec.metric !== 'retention') throw new Error();
    const { sizes, matrix } = retention(P, spec, range, 'Europe/Berlin');
    expect(sizes.values).toEqual([P, 'signup', range.from, range.to, 'Europe/Berlin']);
    expect(matrix.values).toEqual([P, 'signup', range.from, range.to, 'Europe/Berlin', 'session', '5 weeks', 4]);
    expect(matrix.text).toContain("floor((date_trunc('week', e.occurred_at at time zone $5)::date - c.cohort) / 7.0)::int as period");
    expect(matrix.text).toContain('where period between 0 and $8');
  });
});

describe('CSV', () => {
  it('quotes, doubles quotes, and neutralises formula injection', () => {
    expect(csvLine(['plain', 'has,comma', 'has "quote"', '=SUM(A1)', '+1', null, 7])).toBe('plain,"has,comma","has ""quote""",\'=SUM(A1),\'+1,,7\r\n');
  });

  it('renders each result shape with a header', () => {
    expect(resultToCsv({ metric: 'count', event: 'x', bucket: 'day', timeZone: 'UTC', range, source: 'raw', series: [{ bucket: '2026-09-01T00:00:00', value: 3 }] })).toBe('bucket,count\r\n2026-09-01T00:00:00,3\r\n');
    expect(resultToCsv({ metric: 'funnel', range, windowDays: 7, steps: [{ event: 'a', count: 10, conversion: 1 }, { event: 'b', count: 4, conversion: 0.4 }] })).toBe('step,event,count,conversion\r\n1,a,10,1.0000\r\n2,b,4,0.4000\r\n');
    expect(resultToCsv({ metric: 'retention', range, timeZone: 'UTC', cohorts: [{ cohort: '2026-08-31', size: 5, periods: [5, 2, 1] }] })).toBe('cohort,size,week_0,week_1,week_2\r\n2026-08-31,5,5,2,1\r\n');
  });
});
