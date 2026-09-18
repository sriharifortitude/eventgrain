import { Temporal } from 'temporal-polyfill';

import type { Range } from './range.js';
import type { Bucket } from './spec.js';

/**
 * The local bucket labels a series should contain for a range, so that a
 * bucket with no events appears as zero rather than being absent. Labels
 * match what Postgres produces for
 * `date_trunc(unit, occurred_at at time zone tz)`: a local wall-clock
 * timestamp with no offset.
 *
 * Hours are stepped in exact time and then truncated, which reproduces the
 * database's behaviour on DST days: the missing 02:00 on spring-forward is
 * absent, and the repeated 02:00 on fall-back appears once. Days, weeks and
 * months are stepped on the calendar.
 */
export function bucketLabels(range: Range, bucket: Bucket, timeZone: string): string[] {
  const start = Temporal.Instant.from(range.from).toZonedDateTimeISO(timeZone);
  const end = Temporal.Instant.from(range.to);
  const labels: string[] = [];
  const seen = new Set<string>();

  let cursor = truncate(start, bucket);
  while (Temporal.Instant.compare(cursor.toInstant(), end) < 0) {
    const label = format(truncate(cursor, bucket).toPlainDateTime());
    if (!seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
    cursor = bucket === 'hour' ? cursor.add({ hours: 1 }) : bucket === 'day' ? cursor.add({ days: 1 }) : bucket === 'week' ? cursor.add({ weeks: 1 }) : cursor.add({ months: 1 });
  }
  return labels;
}

function truncate(zdt: Temporal.ZonedDateTime, bucket: Bucket): Temporal.ZonedDateTime {
  switch (bucket) {
    case 'hour':
      return zdt.round({ smallestUnit: 'hour', roundingMode: 'floor' });
    case 'day':
      return zdt.startOfDay();
    case 'week':
      return zdt.subtract({ days: zdt.dayOfWeek - 1 }).startOfDay();
    case 'month':
      return zdt.with({ day: 1 }).startOfDay();
  }
}

/** "2026-03-29T02:00:00" -- what pg returns for a `timestamp` column. */
export function format(local: Temporal.PlainDateTime): string {
  return local.toString({ smallestUnit: 'second' });
}

/** Normalise a pg `timestamp` string ("2026-03-29 02:00:00") to the label form. */
export function labelFromPg(value: string): string {
  return format(Temporal.PlainDateTime.from(value));
}
