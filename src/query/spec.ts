import { z } from 'zod';

/**
 * What a client may ask for. Every string that ends up inside SQL text --
 * property keys, event names in identifiers -- is validated here to a
 * conservative alphabet; everything else travels as a bound parameter.
 */

export const BUCKETS = ['hour', 'day', 'week', 'month'] as const;
export type Bucket = (typeof BUCKETS)[number];

const eventName = z.string().min(1).max(200);
const propertyKey = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'property keys are [A-Za-z0-9_.-], up to 64 characters');
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const instant = z.string().datetime({ offset: true });

export const rangeSchema = z.object({
  /** A local date in the project zone (inclusive) or an instant. */
  from: z.union([localDate, instant]),
  /** A local date in the project zone (inclusive) or an instant (exclusive). */
  to: z.union([localDate, instant]),
});
export type RangeInput = z.infer<typeof rangeSchema>;

/** Equality filters on top-level properties, ANDed. */
export const filterSchema = z.record(propertyKey, z.union([z.string(), z.number(), z.boolean()])).default({});

export const seriesSchema = z.object({
  metric: z.enum(['count', 'unique']),
  event: eventName,
  range: rangeSchema,
  bucket: z.enum(BUCKETS).default('day'),
  filter: filterSchema,
  groupBy: propertyKey.optional(),
});
export type SeriesSpec = z.infer<typeof seriesSchema>;

export const funnelSchema = z.object({
  metric: z.literal('funnel'),
  steps: z.array(eventName).min(2).max(10),
  range: rangeSchema,
  /** How long after step 1 the later steps may occur. */
  windowDays: z.number().int().min(1).max(90).default(7),
  filter: filterSchema,
});
export type FunnelSpec = z.infer<typeof funnelSchema>;

export const retentionSchema = z.object({
  metric: z.literal('retention'),
  /** The event whose first occurrence puts a person in a cohort. */
  start: eventName,
  /** The event that counts as "came back". */
  returning: eventName,
  range: rangeSchema,
  periods: z.number().int().min(1).max(26).default(8),
});
export type RetentionSpec = z.infer<typeof retentionSchema>;

export const querySchema = z.discriminatedUnion('metric', [
  seriesSchema.extend({ metric: z.literal('count') }),
  seriesSchema.extend({ metric: z.literal('unique') }),
  funnelSchema,
  retentionSchema,
]);
export type QuerySpec = z.infer<typeof querySchema>;
