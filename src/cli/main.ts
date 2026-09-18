import '../env.js';
import { closeDb, db } from '../db/pool.js';
import { dropExpiredPartitions, ensurePartitionsAhead, listPartitions } from '../db/partitions.js';
import { createApiKey, createProject } from '../api/auth.js';
import { recomputeDirtyDays } from '../worker/rollups.js';

/**
 * Operator commands. There is no admin API: creating a project and minting
 * a key are things an operator does at a shell with database access, and
 * an HTTP surface for them would need its own authentication.
 */

const usage = `usage:
  cli project create <name> [--tz <IANA zone>]
  cli key create <projectId> <label>
  cli partitions [--ahead N] [--drop-older-than-months N]
  cli rollups`;

async function main(argv: string[]): Promise<void> {
  const [group, verb, ...rest] = argv;
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(`--${name}`);
    return i === -1 ? undefined : rest[i + 1];
  };

  if (group === 'project' && verb === 'create' && rest[0] !== undefined) {
    const { id, key } = await createProject(db(), rest[0], flag('tz') ?? 'UTC');
    console.log(`project ${id}\napi key  ${key}\n\nThe key is not stored and will not be shown again.`);
    return;
  }
  if (group === 'key' && verb === 'create' && rest[0] !== undefined && rest[1] !== undefined) {
    const { id, key } = await createApiKey(db(), rest[0], rest[1]);
    console.log(`key ${id}\napi key ${key}`);
    return;
  }
  if (group === 'partitions') {
    const ahead = flag('ahead');
    const older = flag('drop-older-than-months');
    if (ahead !== undefined) await ensurePartitionsAhead(db(), Number(ahead));
    if (older !== undefined) console.log('dropped', await dropExpiredPartitions(db(), Number(older)));
    for (const p of await listPartitions(db())) console.log(p.name);
    return;
  }
  if (group === 'rollups') {
    const done = await recomputeDirtyDays(1000);
    console.log(`recomputed ${done.length} day(s)`);
    return;
  }
  console.log(usage);
  process.exitCode = 1;
}

main(process.argv.slice(2))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
