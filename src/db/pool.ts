import pg from 'pg';

/**
 * One pool per process, built lazily so that importing a module that needs
 * the database does not connect to it. Timestamps come back as JavaScript
 * Dates by default; `timestamp without time zone` values (the local
 * wall-clock buckets the queries produce) are returned as strings instead,
 * because a Date would silently reinterpret them in the process's zone.
 */

let pool: pg.Pool | undefined;

// OID 1114 is `timestamp` (without time zone); 1082 is `date`.
pg.types.setTypeParser(1114, (value) => value);
pg.types.setTypeParser(1082, (value) => value);
// int8 comes back as a string by default; counts fit comfortably in a double.
pg.types.setTypeParser(20, (value) => Number(value));

export function db(): pg.Pool {
  if (pool === undefined) {
    const connectionString = process.env['DATABASE_URL'];
    if (connectionString === undefined) throw new Error('DATABASE_URL is not set');
    pool = new pg.Pool({ connectionString, max: 10 });
  }
  return pool;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

/** Run `fn` inside a transaction, committing on return and rolling back on throw. */
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
