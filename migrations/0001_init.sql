-- Projects and API keys -----------------------------------------------------

create table projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  -- IANA zone. Every day/week/month bucket a query produces is computed in
  -- this zone, so "Monday" means the project's Monday.
  time_zone   text not null default 'UTC',
  created_at  timestamptz not null default now()
);

create table api_keys (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  -- SHA-256 of the key. The key itself is shown once at creation and never
  -- stored; a database read cannot recover it.
  key_hash    bytea not null unique,
  label       text not null,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

-- Events ---------------------------------------------------------------------

-- Range-partitioned by month on occurred_at. Partitions are created on
-- demand by the ingest path and ahead of time by the worker; retention is
-- a partition drop, which is instant and reclaims space without a vacuum.
--
-- The primary key must contain the partition key, so an event is identified
-- by (project, event_id, occurred_at). A client that resends an event with
-- the same id and time is deduplicated; one that changes the time creates a
-- second event. That is the documented contract.
create table events (
  project_id   uuid not null,
  event_id     uuid not null,
  name         text not null,
  -- Pseudonymous. The service does not know or care what it maps to.
  distinct_id  text not null,
  occurred_at  timestamptz not null,
  received_at  timestamptz not null default now(),
  properties   jsonb not null default '{}'::jsonb,
  primary key (project_id, event_id, occurred_at)
) partition by range (occurred_at);

-- Every query filters by project and name and ranges over time.
create index events_project_name_time on events (project_id, name, occurred_at);
-- Per-person paths: erasure, and the funnel's "did this person do step N
-- after step N-1" lookups.
create index events_project_person on events (project_id, distinct_id, name, occurred_at);

-- Daily rollups -----------------------------------------------------------------

-- Per project, per local calendar day, per event name. `uniques` is exact
-- within the day and cannot be summed across days; the query planner knows.
create table event_daily (
  project_id   uuid not null references projects(id) on delete cascade,
  day          date not null,
  name         text not null,
  count        bigint not null,
  uniques      bigint not null,
  computed_at  timestamptz not null default now(),
  primary key (project_id, day, name)
);

-- A day whose raw events changed since its rollup was computed. Ingest and
-- erasure insert here; the rollup worker deletes as it recomputes. A query
-- that touches a dirty day is answered from the raw table instead.
create table rollup_dirty (
  project_id   uuid not null references projects(id) on delete cascade,
  day          date not null,
  marked_at    timestamptz not null default now(),
  primary key (project_id, day)
);

-- Erasure log ---------------------------------------------------------------

-- Evidence that an erasure happened, without keeping what was erased: the
-- hash of the distinct_id is enough to answer "was X erased, and when?"
-- for anyone who still knows X, and nothing to anyone who does not.
create table erasures (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references projects(id) on delete cascade,
  distinct_id_hash bytea not null,
  events_deleted   bigint not null,
  erased_at        timestamptz not null default now()
);
