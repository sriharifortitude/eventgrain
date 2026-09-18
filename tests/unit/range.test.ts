import { describe, expect, it } from 'vitest';

import { bucketLabels } from '../../src/query/buckets.js';
import { isWholeDays, localDay, localDays, resolveRange } from '../../src/query/range.js';

describe('resolveRange', () => {
  it('turns local dates into a half-open instant interval in the project zone', () => {
    // Berlin is UTC+2 in September: local midnight is 22:00Z the evening before.
    expect(resolveRange({ from: '2026-09-01', to: '2026-09-30' }, 'Europe/Berlin')).toEqual({ from: '2026-08-31T22:00:00Z', to: '2026-09-30T22:00:00Z' });
  });

  it('a single spring-forward day is 23 hours long', () => {
    const r = resolveRange({ from: '2026-03-29', to: '2026-03-29' }, 'Europe/Berlin');
    // 29 March 2026: 00:00 CET is 23:00Z on the 28th; 00:00 CEST on the 30th is 22:00Z on the 29th.
    expect(r).toEqual({ from: '2026-03-28T23:00:00Z', to: '2026-03-29T22:00:00Z' });
  });

  it('a single fall-back day is 25 hours long', () => {
    const r = resolveRange({ from: '2026-10-25', to: '2026-10-25' }, 'Europe/Berlin');
    expect(r).toEqual({ from: '2026-10-24T22:00:00Z', to: '2026-10-25T23:00:00Z' });
  });

  it('normalises instants to UTC and passes them through', () => {
    expect(resolveRange({ from: '2026-01-01T10:00:00Z', to: '2026-01-01T12:00:00+01:00' }, 'UTC')).toEqual({ from: '2026-01-01T10:00:00Z', to: '2026-01-01T11:00:00Z' });
  });

  it('rejects from >= to', () => {
    expect(() => resolveRange({ from: '2026-01-02', to: '2026-01-01' }, 'UTC')).toThrow(RangeError);
    expect(() => resolveRange({ from: '2026-01-01T10:00:00Z', to: '2026-01-01T10:00:00Z' }, 'UTC')).toThrow(RangeError);
  });

  it('rejects ranges over 400 days', () => {
    expect(() => resolveRange({ from: '2025-01-01', to: '2026-03-01' }, 'UTC')).toThrow(/400 days/);
  });
});

describe('localDay and localDays', () => {
  it('assigns an instant to the calendar day of the zone', () => {
    expect(localDay('2026-09-01T22:30:00Z', 'Europe/Berlin')).toBe('2026-09-02');
    expect(localDay('2026-09-01T22:30:00Z', 'UTC')).toBe('2026-09-01');
    expect(localDay('2026-09-02T03:30:00Z', 'America/New_York')).toBe('2026-09-01');
  });

  it('enumerates the days a range covers, not one more', () => {
    expect(localDays({ from: '2026-08-31T22:00:00Z', to: '2026-09-02T22:00:00Z' }, 'Europe/Berlin')).toEqual(['2026-09-01', '2026-09-02']);
  });
});

describe('isWholeDays', () => {
  it('is true only for local-midnight bounds', () => {
    expect(isWholeDays({ from: '2026-08-31T22:00:00Z', to: '2026-09-30T22:00:00Z' }, 'Europe/Berlin')).toBe(true);
    expect(isWholeDays({ from: '2026-09-01T00:00:00Z', to: '2026-09-30T22:00:00Z' }, 'Europe/Berlin')).toBe(false);
    expect(isWholeDays({ from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }, 'UTC')).toBe(true);
  });
});

describe('bucketLabels', () => {
  const berlin = 'Europe/Berlin';

  it('day buckets are local dates at midnight', () => {
    expect(bucketLabels({ from: '2026-08-31T22:00:00Z', to: '2026-09-03T22:00:00Z' }, 'day', berlin)).toEqual(['2026-09-01T00:00:00', '2026-09-02T00:00:00', '2026-09-03T00:00:00']);
  });

  it('week buckets start on the Monday of the first day, even if the range starts mid-week', () => {
    // 2026-09-03 is a Thursday; its week's Monday is 08-31.
    expect(bucketLabels({ from: '2026-09-02T22:00:00Z', to: '2026-09-15T22:00:00Z' }, 'week', berlin)).toEqual(['2026-08-31T00:00:00', '2026-09-07T00:00:00', '2026-09-14T00:00:00']);
  });

  it('month buckets', () => {
    expect(bucketLabels({ from: '2026-01-15T00:00:00Z', to: '2026-03-02T00:00:00Z' }, 'month', 'UTC')).toEqual(['2026-01-01T00:00:00', '2026-02-01T00:00:00', '2026-03-01T00:00:00']);
  });

  it('hour buckets skip the missing hour on spring-forward', () => {
    const labels = bucketLabels({ from: '2026-03-29T00:00:00Z', to: '2026-03-29T03:00:00Z' }, 'hour', berlin);
    // 00:00Z = 01:00 CET, 01:00Z = 03:00 CEST (02:00 does not exist), 02:00Z = 04:00 CEST.
    expect(labels).toEqual(['2026-03-29T01:00:00', '2026-03-29T03:00:00', '2026-03-29T04:00:00']);
  });

  it('hour buckets show the repeated hour once on fall-back', () => {
    const labels = bucketLabels({ from: '2026-10-24T23:00:00Z', to: '2026-10-25T02:00:00Z' }, 'hour', berlin);
    // 23:00Z = 01:00 CEST, 00:00Z = 02:00 CEST, 01:00Z = 02:00 CET (again), 02:00Z = 03:00 CET.
    expect(labels).toEqual(['2026-10-25T01:00:00', '2026-10-25T02:00:00']);
  });
});
