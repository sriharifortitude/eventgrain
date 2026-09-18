# 1. Plain SQL with a small migrator; events partitioned by month

Status: accepted — 2026-09-18

## Context

The events table is the only thing in this service that grows without
bound. Everything about it — how it is indexed, how old data is removed,
how a query touches only the months it needs — depends on Postgres
features that ORM migration DSLs either do not model (declarative
partitioning, partial and expression indexes) or model as a string escape
hatch. The earlier projects in this portfolio used Prisma where the schema
was relational and small; here the schema is small but the physical layout
matters.

## Decision

- Migrations are `.sql` files applied in order by `src/db/migrate.ts`,
  which records each file's SHA-256 and refuses to run if an applied file
  has been edited. Forty lines, no dependency.
- Queries use `pg` directly with positional parameters. Row types are
  declared at the call site; there is no generated client.
- `events` is `partition by range (occurred_at)` with one partition per
  UTC month, created on demand by ingest (`create table if not exists …
  partition of`) and ahead of time by the worker.
- Retention is `drop table` on partitions older than the window.

## Consequences

- A query bounded by `occurred_at` is planned against only the partitions
  it overlaps. A Berlin day near a month boundary touches two.
- Deleting a month of events is a metadata operation, not a row-by-row
  delete followed by a vacuum. That is what makes a retention policy
  cheap enough to run nightly.
- The primary key must include the partition column, so an event is
  identified by `(project_id, event_id, occurred_at)`. Resending an event
  with the same id and time is deduplicated; changing its time creates a
  second row. The contract is stated in the schema comment and the README.
- Partition bounds are UTC months even though reporting is in the
  project's zone. Bounds are about storage, not semantics; the alternative
  — one partition scheme per project zone — would be a great deal of
  machinery to save one partition scan a month.
- Without an ORM, the type of each query's rows is asserted, not proven.
  The integration suite is what stands behind those assertions, and it runs
  against a real Postgres in CI.
