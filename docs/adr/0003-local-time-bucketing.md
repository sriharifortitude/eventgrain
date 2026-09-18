# 3. Buckets are local wall-clock time in the project's zone

Status: accepted — 2026-09-18

## Context

"Signups per day" means calendar days where the business is, not UTC
days. A Berlin team looking at last Sunday wants the 25 hours it actually
had, and a bucket labelled "2 am" should mean the hour they lived through
— twice, on the fall-back night.

## Decision

- Each project has one IANA zone. Every range given as local dates is
  resolved to instants in that zone (`resolveRange`), and every bucket is
  `date_trunc(unit, occurred_at at time zone $zone)`: a `timestamp
  without time zone` that is the local wall-clock label.
- Bucket labels are returned as ISO local date-times with no offset
  (`2025-10-26T02:00:00`) alongside the zone. They are labels, not
  instants, and the response says so by not attaching an offset.
- Missing buckets are zero-filled by enumerating labels in the zone with
  Temporal: hours are stepped in exact time and truncated (so the skipped
  hour is absent and the repeated hour appears once, matching Postgres),
  days, weeks and months on the calendar.
- Weeks start on Monday, because `date_trunc('week')` does and because
  the market this is built for expects it.

## Consequences

- A single spring-forward day is 23 hours and a fall-back day is 25; the
  tests pin the instant bounds for both.
- Events at 00:30Z and 01:30Z on 26 October 2025 land in the same
  `02:00:00` hour bucket in Berlin. That is the correct answer to "what
  happened at 2 am", and the test asserts it. A client that wants
  unambiguous hours should query in instants and bucket by hour in UTC,
  which the API also supports (instant range bounds, project zone UTC).
- Requests always use the project's zone. Per-request zones would be easy
  to add — one more parameter through `runQuery` — but every rollup is
  keyed by local day in the project zone, so a request in another zone
  would always be served from raw. Not offering it keeps that trade-off
  out of the API surface until someone needs it.
- Dates in `rollup_dirty` and `event_daily` are local dates. Changing a
  project's zone would invalidate every rollup; the CLI does not offer a
  way to change it, and that is deliberate.
