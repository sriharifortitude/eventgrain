# 2. Daily rollups, used only when the answer is provably the same as raw

Status: accepted — 2026-09-18

## Context

Counting events for a month from the raw table is a scan of the month.
Pre-aggregated daily counts make that a scan of thirty rows. The usual
cost is staleness: a dashboard that says "as of the last rollup", or
worse, one that does not say.

## Decision

`event_daily` holds `(project, local day, event name) → count, uniques`.
Ingest and erasure record every local day they touch in `rollup_dirty`;
the worker recomputes dirty days from the raw table and clears the mark
— but only if the mark is still the one it read, so a day re-dirtied
during recomputation stays dirty.

The query planner serves a series from rollups only when:

1. the range is whole local days;
2. there is no property filter and no group-by;
3. the metric is `count` at a bucket of a day or coarser, **or** `unique`
   at exactly a day bucket;
4. no day in the range is dirty.

Otherwise it reads the raw table. Every response says which source
answered it.

## Consequences

- A rollup answer is never stale or approximate: the four conditions are
  exactly the conditions under which the rollup sum equals the raw
  aggregate. The integration suite asserts this by running the same query
  before and after the worker and comparing values.
- Uniques across several days come from raw. `count(distinct)` is not
  additive, and the honest options are raw, or a sketch (HyperLogLog) with
  an error bound. A sketch is the right next step if raw uniques over long
  ranges become slow; it would be a second column, not a redesign.
- Filtered and grouped queries always hit raw. Rolling up per property
  value is a cardinality bet that goes wrong on the first
  high-cardinality property; it is deliberately not made.
- A day stays dirty for up to a minute after ingest (the scheduler
  interval), during which queries on it are answered from raw. Correct,
  slightly slower, and visible in the `source` field.
- Rollups survive retention: dropping a raw partition does not remove its
  daily rows. Aggregates per event name per day are not personal data.
  Erasure, by contrast, does invalidate the rollups for the days a person
  touched, because a unique count of one is a fact about one person.
