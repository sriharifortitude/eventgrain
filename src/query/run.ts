import type { Queryable } from '../db/pool.js';
import { bucketLabels, labelFromPg } from './buckets.js';
import { isWholeDays, localDays, resolveRange, type Range } from './range.js';
import type { FunnelSpec, QuerySpec, RetentionSpec, SeriesSpec } from './spec.js';
import { funnel, retention, seriesFromRaw, seriesFromRollup } from './sql.js';

export interface Project {
  readonly id: string;
  readonly timeZone: string;
}

export interface SeriesResult {
  readonly metric: 'count' | 'unique';
  readonly event: string;
  readonly bucket: SeriesSpec['bucket'];
  readonly timeZone: string;
  readonly range: Range;
  /** Where the answer came from. Rollups are only used when provably equal to raw. */
  readonly source: 'rollup' | 'raw';
  readonly series: ReadonlyArray<{ bucket: string; group?: string | null; value: number }>;
}

export interface FunnelResult {
  readonly metric: 'funnel';
  readonly range: Range;
  readonly windowDays: number;
  readonly steps: ReadonlyArray<{ event: string; count: number; conversion: number }>;
}

export interface RetentionResult {
  readonly metric: 'retention';
  readonly range: Range;
  readonly timeZone: string;
  readonly cohorts: ReadonlyArray<{ cohort: string; size: number; periods: number[] }>;
}

export type QueryResult = SeriesResult | FunnelResult | RetentionResult;

export async function runQuery(q: Queryable, project: Project, spec: QuerySpec): Promise<QueryResult> {
  const range = resolveRange(spec.range, project.timeZone);
  switch (spec.metric) {
    case 'count':
    case 'unique':
      return runSeries(q, project, spec, range);
    case 'funnel':
      return runFunnel(q, project, spec, range);
    case 'retention':
      return runRetention(q, project, spec, range);
  }
}

/**
 * The planner. Rollups answer a series only when the answer is provably the
 * same as the raw table would give:
 *
 *   - the range is whole local days (rollups have no finer resolution);
 *   - no property filter or group-by (rollups are per event name only);
 *   - counts at any bucket of a day or coarser (sums of daily counts), or
 *     uniques at exactly the day bucket (a unique across two days is not the
 *     sum of two daily uniques);
 *   - no day in the range is dirty, i.e. waiting for the worker.
 *
 * Anything else reads the raw table. The response says which was used.
 */
async function runSeries(q: Queryable, project: Project, spec: SeriesSpec, range: Range): Promise<SeriesResult> {
  const rollupShape = isWholeDays(range, project.timeZone) && Object.keys(spec.filter).length === 0 && spec.groupBy === undefined && spec.bucket !== 'hour' && (spec.metric === 'count' || spec.bucket === 'day');
  const source = rollupShape && !(await anyDirty(q, project.id, range, project.timeZone)) ? 'rollup' : 'raw';

  const sql = source === 'rollup' ? seriesFromRollup(project.id, spec, range, project.timeZone) : seriesFromRaw(project.id, spec, range, project.timeZone);
  const rows = (await q.query<{ bucket: string; group?: string | null; value: number }>(sql.text, sql.values)).rows;

  const labels = bucketLabels(range, spec.bucket, project.timeZone);
  if (spec.groupBy === undefined) {
    const byLabel = new Map(rows.map((row) => [labelFromPg(row.bucket), row.value]));
    return { metric: spec.metric, event: spec.event, bucket: spec.bucket, timeZone: project.timeZone, range, source, series: labels.map((bucket) => ({ bucket, value: byLabel.get(bucket) ?? 0 })) };
  }
  // Grouped: zero-fill every group across every bucket so each group is a complete line.
  const groups = [...new Set(rows.map((row) => row.group ?? null))];
  const byKey = new Map(rows.map((row) => [`${labelFromPg(row.bucket)}|${row.group ?? ''}`, row.value]));
  const series = labels.flatMap((bucket) => groups.map((group) => ({ bucket, group, value: byKey.get(`${bucket}|${group ?? ''}`) ?? 0 })));
  return { metric: spec.metric, event: spec.event, bucket: spec.bucket, timeZone: project.timeZone, range, source, series };
}

async function anyDirty(q: Queryable, projectId: string, range: Range, timeZone: string): Promise<boolean> {
  const days = localDays(range, timeZone);
  const result = await q.query<{ n: number }>('select count(*)::bigint as n from rollup_dirty where project_id = $1 and day >= $2 and day <= $3', [projectId, days[0], days[days.length - 1]]);
  return (result.rows[0]?.n ?? 0) > 0;
}

async function runFunnel(q: Queryable, project: Project, spec: FunnelSpec, range: Range): Promise<FunnelResult> {
  const sql = funnel(project.id, spec, range);
  const row = (await q.query<Record<string, number>>(sql.text, sql.values)).rows[0] ?? {};
  const entered = row['step1'] ?? 0;
  return {
    metric: 'funnel',
    range,
    windowDays: spec.windowDays,
    steps: spec.steps.map((event, i) => {
      const count = row[`step${i + 1}`] ?? 0;
      return { event, count, conversion: entered === 0 ? 0 : count / entered };
    }),
  };
}

async function runRetention(q: Queryable, project: Project, spec: RetentionSpec, range: Range): Promise<RetentionResult> {
  const { sizes, matrix } = retention(project.id, spec, range, project.timeZone);
  const sizeRows = (await q.query<{ cohort: string; size: number }>(sizes.text, sizes.values)).rows;
  const cells = (await q.query<{ cohort: string; period: number; users: number }>(matrix.text, matrix.values)).rows;
  const byCohort = new Map<string, number[]>();
  for (const row of sizeRows) byCohort.set(row.cohort, Array.from({ length: spec.periods + 1 }, () => 0));
  for (const cell of cells) {
    const periods = byCohort.get(cell.cohort);
    if (periods !== undefined) periods[cell.period] = cell.users;
  }
  return {
    metric: 'retention',
    range,
    timeZone: project.timeZone,
    cohorts: sizeRows.map((row) => ({ cohort: row.cohort, size: row.size, periods: byCohort.get(row.cohort) ?? [] })),
  };
}
