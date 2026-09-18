import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';

import { db, closeDb } from '../db/pool.js';
import { dropExpiredPartitions, ensurePartitionsAhead } from '../db/partitions.js';
import { recomputeDirtyDays } from './rollups.js';

/**
 * Three repeatable maintenance jobs on one queue. BullMQ's repeat keys make
 * "exactly one schedule per job name" true across restarts and across
 * multiple worker processes, which is the only reason a queue is used for
 * something a cron line could otherwise do.
 */

const QUEUE = 'eventgrain-maintenance';
const redisUrl = process.env['REDIS_URL'];
if (redisUrl === undefined) throw new Error('REDIS_URL is not set');
const retentionMonths = Number(process.env['RETENTION_MONTHS'] ?? 13);

const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const queue = new Queue(QUEUE, { connection });

await queue.upsertJobScheduler('rollups', { every: 60_000 }, { name: 'rollups' });
await queue.upsertJobScheduler('partitions', { pattern: '15 0 * * *' }, { name: 'partitions' });
await queue.upsertJobScheduler('retention', { pattern: '30 0 * * *' }, { name: 'retention' });

const worker = new Worker(
  QUEUE,
  async (job) => {
    switch (job.name) {
      case 'rollups': {
        const done = await recomputeDirtyDays(200);
        if (done.length > 0) console.log(`rollups: recomputed ${done.length} day(s)`);
        return;
      }
      case 'partitions':
        await ensurePartitionsAhead(db(), 2);
        return;
      case 'retention': {
        const dropped = await dropExpiredPartitions(db(), retentionMonths);
        if (dropped.length > 0) console.log(`retention: dropped ${dropped.join(', ')}`);
        return;
      }
      default:
        throw new Error(`unknown job ${job.name}`);
    }
  },
  { connection, concurrency: 1 },
);

worker.on('failed', (job, error) => console.error(`${job?.name ?? '?'} failed:`, error.message));
console.log('eventgrain worker running');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void worker.close().then(() => queue.close()).then(() => closeDb()).then(() => { connection.disconnect(); process.exit(0); });
  });
}
