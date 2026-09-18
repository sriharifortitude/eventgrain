import '../env.js';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { closeDb, db } from './pool.js';

/**
 * Plain SQL migrations, applied in filename order, each in its own
 * transaction, recorded in `schema_migrations`. There is no ORM here
 * because the schema uses declarative partitioning and partial indexes,
 * which every ORM's migration DSL either cannot express or expresses as an
 * escape hatch to raw SQL anyway. Better to write the SQL and own it.
 *
 * A migration that has been applied is never re-run; editing an applied
 * file is a mistake the checksum column will catch.
 */

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations');

export async function migrate(): Promise<string[]> {
  const pool = db();
  await pool.query(`
    create table if not exists schema_migrations (
      name text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Map<string, string>();
  for (const row of (await pool.query<{ name: string; checksum: string }>('select name, checksum from schema_migrations')).rows) {
    applied.set(row.name, row.checksum);
  }

  const ran: string[] = [];
  for (const file of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = await sha256(sql);
    const previous = applied.get(file);
    if (previous !== undefined) {
      if (previous !== checksum) throw new Error(`${file} was edited after being applied (checksum ${previous} → ${checksum})`);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (name, checksum) values ($1, $2)', [file, checksum]);
      await client.query('commit');
      ran.push(file);
    } catch (error) {
      await client.query('rollback');
      throw new Error(`${file} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      client.release();
    }
  }
  return ran;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Buffer.from(digest).toString('hex');
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  migrate()
    .then((ran) => {
      process.stdout.write(ran.length === 0 ? 'up to date\n' : `applied ${ran.join(', ')}\n`);
      return closeDb();
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
      return closeDb();
    });
}
