# eventgrain

Self-hosted product analytics for a team that wants its event data in its
own Postgres, in its own time zone, with a delete button that actually
deletes. Batched ingest, month-partitioned storage, four query types
(count, unique, funnel, retention) bucketed in local time, daily rollups
that are used only when they are provably the same as the raw answer,
per-person erasure, retention by partition drop, and streamed CSV export.

It is the reporting layer a SaaS product needs before it needs a data
warehouse, and it is built so the numbers it produces can be explained.

## What it does

- **Ingest.** `POST /api/events` with up to 1,000 events. Idempotent on
  `(event id, time)`; events more than a day in the future are rejected
  individually and reported by index. One insert per batch; the month
  partition is created on demand.
- **Query.** `POST /api/query` with a typed spec:
  - `count` / `unique` of an event, bucketed by hour, day, week or month,
    with equality filters on properties and an optional group-by.
  - `funnel`: ordered steps, a window measured from step 1, counts and
    conversion per step.
  - `retention`: weekly cohorts by first occurrence of one event, returning
    on another, as a matrix.
  - `?format=csv` on any of them.
- **Event names.** `GET /api/event-names` lists what the project has
  recorded, for a UI to offer instead of a free-text field.
- **Local time.** Every bucket and every cohort week is computed in the
  project's IANA zone. A Berlin Sunday in October is 25 hours long and
  the test suite says so.
- **Rollups.** Daily per-event counts and uniques, recomputed by a worker
  for days marked dirty by ingest or erasure. The planner serves a query
  from rollups only under conditions that make the answer identical to
  raw, and every response reports `source: "rollup" | "raw"`.
- **Erasure.** `DELETE /api/persons/:distinctId` removes a person's raw
  events, invalidates the rollups for the days they touched, and logs the
  erasure by hash.
- **Retention.** A nightly job drops event partitions older than
  `RETENTION_MONTHS`. Aggregates are kept; raw events are not.
- **Export.** `GET /api/events/export` streams raw events as CSV through
  a server-side cursor, filterable by event and person — the shape of an
  Article 15 access request.

## Running it

    docker compose up -d --wait        # Postgres 17 on :5436, Redis on :6381
    cp .env.example .env
    npm install
    npm run db:migrate
    npm run cli -- project create "My product" --tz Europe/Berlin
    npm run dev                        # API on :4200
    npm run worker                     # rollups every minute; partitions and retention nightly

Or as containers — one image, three roles:

    docker build -t eventgrain .
    docker run --rm -e DATABASE_URL=... eventgrain node dist/db/migrate.js
    docker run --rm -e DATABASE_URL=... eventgrain node dist/cli/main.js project create "My product" --tz Europe/Berlin
    docker run -d -p 4200:4200 -e DATABASE_URL=... eventgrain                          # api
    docker run -d -e DATABASE_URL=... -e REDIS_URL=... eventgrain node dist/worker/main.js

The CLI prints an API key once. Send it as `Authorization: Bearer eg_…`.

    curl -s localhost:4200/api/events -H "authorization: Bearer $KEY" \
      -H 'content-type: application/json' \
      -d '{"events":[{"id":"<uuid>","name":"signup","distinctId":"u-1","occurredAt":"2026-09-10T08:00:00Z","properties":{"plan":"pro"}}]}'

    curl -s localhost:4200/api/query -H "authorization: Bearer $KEY" \
      -H 'content-type: application/json' \
      -d '{"metric":"count","event":"signup","range":{"from":"2026-09-01","to":"2026-09-30"},"bucket":"week"}'

## Checks

    npm run typecheck
    npm run lint
    npm test                           # range/DST arithmetic, SQL builders, CSV: 21 tests
    npm run test:integration           # against Postgres: 14 tests with hand-computed expectations

The integration fixture straddles the 26 October 2025 clock change in
Berlin: repeated 02:00 bucket, a person whose 23:30Z event is Monday
locally, uniques that must not be summed across days, a funnel where step
order and a half-open window both matter, cohorts where a Sunday-night
signup belongs to the week that is ending.

## Design notes

1. [Plain SQL and month partitions](docs/adr/0001-plain-sql-and-month-partitions.md)
   — why there is no ORM here, and what the partition key costs.
2. [Rollups served only when provably equal](docs/adr/0002-rollups-served-only-when-provably-equal.md)
   — the four conditions, and why uniques over a week come from raw.
3. [Local-time bucketing](docs/adr/0003-local-time-bucketing.md)
   — what a bucket label means and what happens on the DST nights.

## What it deliberately does not do

- **No UI.** It is an API; the dashboards it feeds are the client's.
  A small one would be a good next repository, not a feature of this one.
- **No sketches.** Uniques across days are exact and come from the raw
  table. HyperLogLog would make them cheap and approximate; the ADR says
  where it would go.
- **No per-property rollups.** Filtered and grouped queries always read
  raw. Rolling up by property value is a cardinality bet.
- **No admin API.** Projects and keys are created at a shell with
  database access. An HTTP surface for them would need its own
  authentication story.
- **No rate limiting or request size limit** beyond the 1,000-event batch
  cap. Both belong to the reverse proxy in front of this.
- **Funnel scale.** Each step is a correlated lookup per person on the
  `(project, person, name, time)` index. Fine for tens of thousands of
  entrants per query; past that, a single-pass window-function formulation
  is the known replacement.
- **One zone per project**, fixed at creation. See ADR 3 for why changing
  it is not offered.

## Licence

Business Source License 1.1. Free for evaluation, development and
non-commercial use; production use needs a commercial licence. Converts to
Apache 2.0 on 2030-09-17. See [LICENSE](LICENSE).
