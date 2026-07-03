import { db, type Database, type DbClient, type Transaction } from '@hnet/db';

/**
 * Resolve the executor a helper should run against: an explicitly injected
 * db/transaction (tests, composed transactions) or the lazy default client.
 * The cast is safe — Database and Transaction expose the same query surface, and
 * calling .transaction() on an open transaction opens a savepoint.
 */
export function resolveDb(executor?: DbClient): Database {
  return (executor ?? db) as Database;
}

export async function inTransaction<T>(
  executor: DbClient | undefined,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return resolveDb(executor).transaction(fn);
}
