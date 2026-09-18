import { Temporal } from 'temporal-polyfill';

import type { RangeInput } from './spec.js';

/** A half-open interval of instants, [from, to). */
export interface Range {
  readonly from: string;
  readonly to: string;
}

/**
 * Local dates become instants in the project zone: `from` is the start of
 * that day and `to` is the start of the *following* day, so a request for
 * `2026-03-29` to `2026-03-29` covers the whole of that day -- 23 hours long
 * in Berlin, because the clocks go forward -- and nothing else. Instants are
 * taken as given.
 */
export function resolveRange(input: RangeInput, timeZone: string): Range {
  const from = isLocalDate(input.from) ? startOfDay(input.from, timeZone) : Temporal.Instant.from(input.from).toString();
  const to = isLocalDate(input.to) ? startOfDay(Temporal.PlainDate.from(input.to).add({ days: 1 }).toString(), timeZone) : Temporal.Instant.from(input.to).toString();
  if (Temporal.Instant.compare(Temporal.Instant.from(from), Temporal.Instant.from(to)) >= 0) throw new RangeError('range is empty: from must be before to');
  const days = Temporal.Instant.from(from).until(Temporal.Instant.from(to), { largestUnit: 'hours' }).hours / 24;
  if (days > 400) throw new RangeError('range is longer than 400 days');
  return { from, to };
}

function isLocalDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function startOfDay(isoDate: string, timeZone: string): string {
  return Temporal.PlainDate.from(isoDate).toZonedDateTime(timeZone).toInstant().toString();
}

/** The local calendar day, in `timeZone`, that an instant falls on. */
export function localDay(instant: string | Date, timeZone: string): string {
  const iso = instant instanceof Date ? instant.toISOString() : instant;
  return Temporal.Instant.from(iso).toZonedDateTimeISO(timeZone).toPlainDate().toString();
}

/** Every local day in [from, to), in order. */
export function localDays(range: Range, timeZone: string): string[] {
  const last = Temporal.Instant.from(range.to).subtract({ nanoseconds: 1 }).toZonedDateTimeISO(timeZone).toPlainDate();
  let cursor = Temporal.Instant.from(range.from).toZonedDateTimeISO(timeZone).toPlainDate();
  const days: string[] = [];
  while (Temporal.PlainDate.compare(cursor, last) <= 0) {
    days.push(cursor.toString());
    cursor = cursor.add({ days: 1 });
  }
  return days;
}

/** True when the range starts and ends exactly on local-day boundaries. */
export function isWholeDays(range: Range, timeZone: string): boolean {
  const onBoundary = (instant: string): boolean => {
    const local = Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone);
    return local.hour === 0 && local.minute === 0 && local.second === 0 && local.millisecond === 0;
  };
  return onBoundary(range.from) && onBoundary(range.to);
}
