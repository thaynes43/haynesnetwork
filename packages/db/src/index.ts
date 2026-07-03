import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

let _pool: Pool | undefined;
let _db: DrizzleDb | undefined;

function getDb(): DrizzleDb {
  if (!_db) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required');
    }
    _pool = new Pool({ connectionString: process.env.DATABASE_URL });
    _db = drizzle(_pool, { schema });
  }
  return _db;
}

/**
 * Lazy Drizzle client over a pg Pool created from DATABASE_URL on first property
 * access (donor pattern) — importing @hnet/db never connects at module load, so CI
 * builds and unit tests that don't touch the DB need no DATABASE_URL.
 */
export const db = new Proxy({} as DrizzleDb, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
});

export function getPool(): Pool {
  void getDb();
  return _pool!;
}

export type Database = DrizzleDb;
/** A Drizzle transaction over this schema (the `tx` inside db.transaction()). */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything the domain helpers accept as an executor: the db, or an open transaction. */
export type DbClient = Database | Transaction;

export * from './schema';
