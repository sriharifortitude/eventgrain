import type { Range } from './range.js';
import type { FunnelSpec, RetentionSpec, SeriesSpec } from './spec.js';

/**
 * SQL text plus bound values. Nothing from a request is ever interpolated
 * into the text: event names, filter values, zones and bucket units are all
 * parameters. Property keys appear inside a `->>` operand only after the
 * schema has restricted them to [A-Za-z0-9_.-], and even then as a
 * parameter, because `properties ->> $n` is valid SQL.
 */
export interface Sql {
  readonly text: string;
  readonly values: unknown[];
}

class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

// -- Series: count / unique, bucketed ------------------------------------------

/** Answer from the raw events table. Always correct; the fallback for everything. */
export function seriesFromRaw(projectId: string, spec: SeriesSpec, range: Range, timeZone: string): Sql {
  const p = new Params();
  const project = p.add(projectId);
  const name = p.add(spec.event);
  const from = p.add(range.from);
  const to = p.add(range.to);
  const tz = p.add(timeZone);
  const unit = p.add(spec.bucket);

  const aggregate = spec.metric === 'count' ? 'count(*)' : 'count(distinct distinct_id)';
  const where = [`project_id = ${project}`, `name = ${name}`, `occurred_at >= ${from}`, `occurred_at < ${to}`];
  if (Object.keys(spec.filter).length > 0) where.push(`properties @> ${p.add(JSON.stringify(spec.filter))}::jsonb`);

  const group = spec.groupBy === undefined ? '' : `, properties ->> ${p.add(spec.groupBy)} as "group"`;
  const groupClause = spec.groupBy === undefined ? 'group by 1 order by 1' : 'group by 1, 2 order by 1, 2';

  return {
    text: `select date_trunc(${unit}, occurred_at at time zone ${tz}) as bucket${group}, ${aggregate}::bigint as value from events where ${where.join(' and ')} ${groupClause}`,
    values: p.values,
  };
}

/**
 * Answer from the daily rollups. Only valid when the planner has checked
 * the preconditions (whole days, no filter, no group, no dirty days, and
 * for `unique` a day bucket exactly). Counts are additive so any bucket of
 * a day or coarser is a sum of days.
 */
export function seriesFromRollup(projectId: string, spec: SeriesSpec, range: Range, timeZone: string): Sql {
  const p = new Params();
  const project = p.add(projectId);
  const name = p.add(spec.event);
  // Rollup days are local dates; the range bounds are instants on local
  // midnights, so converting them in the zone gives the exact day bounds.
  const from = p.add(range.from);
  const to = p.add(range.to);
  const tz = p.add(timeZone);
  const unit = p.add(spec.bucket);
  const value = spec.metric === 'count' ? 'sum(count)' : 'sum(uniques)';
  return {
    text: `select date_trunc(${unit}, day::timestamp) as bucket, ${value}::bigint as value from event_daily where project_id = ${project} and name = ${name} and day >= (${from}::timestamptz at time zone ${tz})::date and day < (${to}::timestamptz at time zone ${tz})::date group by 1 order by 1`,
    values: p.values,
  };
}

// -- Funnel ------------------------------------------------------------------

/**
 * Ordered steps. A person enters at their first step-1 event in the range;
 * each later step is the earliest matching event after the previous step
 * and within the window measured from step 1. One CTE per step, chained.
 */
export function funnel(projectId: string, spec: FunnelSpec, range: Range): Sql {
  const p = new Params();
  const project = p.add(projectId);
  const from = p.add(range.from);
  const to = p.add(range.to);
  const window = p.add(`${spec.windowDays} days`);
  const filter = Object.keys(spec.filter).length > 0 ? ` and properties @> ${p.add(JSON.stringify(spec.filter))}::jsonb` : '';

  const ctes: string[] = [];
  const first = p.add(spec.steps[0]);
  ctes.push(`s1 as (select distinct_id, min(occurred_at) as t, min(occurred_at) as t1 from events where project_id = ${project} and name = ${first} and occurred_at >= ${from} and occurred_at < ${to}${filter} group by distinct_id)`);

  for (let i = 1; i < spec.steps.length; i += 1) {
    const step = p.add(spec.steps[i]);
    const prev = `s${i}`;
    ctes.push(
      `s${i + 1} as (select ${prev}.distinct_id, (select min(e.occurred_at) from events e where e.project_id = ${project} and e.distinct_id = ${prev}.distinct_id and e.name = ${step} and e.occurred_at > ${prev}.t and e.occurred_at < ${prev}.t1 + ${window}::interval) as t, ${prev}.t1 from ${prev} where ${prev}.t is not null)`,
    );
  }
  const counts = spec.steps.map((_, i) => `(select count(t) from s${i + 1})::bigint as step${i + 1}`);
  return { text: `with ${ctes.join(', ')} select ${counts.join(', ')}`, values: p.values };
}

// -- Retention ---------------------------------------------------------------

/**
 * Weekly cohorts by first `start` event (local Monday-based weeks). For
 * each cohort and period n, the number of people with a `returning` event
 * in week cohort+n. Two statements: cohort sizes, then the matrix.
 */
export function retention(projectId: string, spec: RetentionSpec, range: Range, timeZone: string): { sizes: Sql; matrix: Sql } {
  const p = new Params();
  const project = p.add(projectId);
  const start = p.add(spec.start);
  const from = p.add(range.from);
  const to = p.add(range.to);
  const tz = p.add(timeZone);
  const cohorts = `cohorts as (select distinct_id, date_trunc('week', min(occurred_at at time zone ${tz}))::date as cohort from events where project_id = ${project} and name = ${start} and occurred_at >= ${from} and occurred_at < ${to} group by distinct_id)`;

  const sizes: Sql = { text: `with ${cohorts} select cohort, count(*)::bigint as size from cohorts group by cohort order by cohort`, values: [...p.values] };

  const returning = p.add(spec.returning);
  const horizon = p.add(`${spec.periods + 1} weeks`);
  const periods = p.add(spec.periods);
  const matrix: Sql = {
    text: `with ${cohorts}, returns as (select c.cohort, c.distinct_id, floor((date_trunc('week', e.occurred_at at time zone ${tz})::date - c.cohort) / 7.0)::int as period from cohorts c join events e on e.project_id = ${project} and e.distinct_id = c.distinct_id and e.name = ${returning} and e.occurred_at >= ${from} and e.occurred_at < ${to}::timestamptz + ${horizon}::interval) select cohort, period, count(distinct distinct_id)::bigint as users from returns where period between 0 and ${periods} group by cohort, period order by cohort, period`,
    values: p.values,
  };
  return { sizes, matrix };
}
