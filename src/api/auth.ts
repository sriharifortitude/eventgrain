import { createHash, randomBytes } from 'node:crypto';

import { db, type Queryable } from '../db/pool.js';

export interface Principal {
  readonly projectId: string;
  readonly timeZone: string;
  readonly keyId: string;
}

const PREFIX = 'eg_';

function hash(key: string): Buffer {
  return createHash('sha256').update(key).digest();
}

/**
 * Keys are 32 random bytes, shown once. Only the SHA-256 is stored, so a
 * key can be checked but not read back. There is no need for a slow hash:
 * the input has 256 bits of entropy, which no dictionary covers.
 */
export async function createApiKey(q: Queryable, projectId: string, label: string): Promise<{ id: string; key: string }> {
  const key = PREFIX + randomBytes(32).toString('base64url');
  const result = await q.query<{ id: string }>('insert into api_keys (project_id, key_hash, label) values ($1, $2, $3) returning id', [projectId, hash(key), label]);
  return { id: result.rows[0]!.id, key };
}

export async function createProject(q: Queryable, name: string, timeZone: string): Promise<{ id: string; key: string }> {
  // Rejects an unknown zone before anything is stored against it.
  new Intl.DateTimeFormat('en', { timeZone });
  const project = await q.query<{ id: string }>('insert into projects (name, time_zone) values ($1, $2) returning id', [name, timeZone]);
  const id = project.rows[0]!.id;
  const { key } = await createApiKey(q, id, 'initial');
  return { id, key };
}

export async function authenticate(bearer: string | undefined): Promise<Principal | null> {
  if (bearer === undefined || !bearer.startsWith(PREFIX)) return null;
  const result = await db().query<{ id: string; project_id: string; time_zone: string }>(
    'select k.id, k.project_id, p.time_zone from api_keys k join projects p on p.id = k.project_id where k.key_hash = $1 and k.revoked_at is null',
    [hash(bearer)],
  );
  const row = result.rows[0];
  return row === undefined ? null : { projectId: row.project_id, timeZone: row.time_zone, keyId: row.id };
}
