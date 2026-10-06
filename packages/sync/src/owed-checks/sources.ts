// DESIGN-053 D-04 — the read-only sources an automated owed check may query. Every one is read-only by construction,
// not by convention:
//   app-db      the app's Postgres through the `-ro` service (a hot standby), in a session with
//               default_transaction_read_only=on, each query inside BEGIN READ ONLY ... ROLLBACK, 30 s statement timeout;
//   ll-db       LazyLibrarian's SQLite opened SQLITE_OPEN_READONLY (`mode=ro`) with PRAGMA query_only;
//   loki        the HTTP instant-query API (GET);
//   prometheus  the HTTP instant-query API (GET).
// The two SQL sources also refuse anything but one SELECT / WITH statement before it reaches the database.
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import type { Observation } from './evaluate';
import type { OwedCheckSource } from './tracker';

export interface SourceConfig {
  /** Postgres connection string for app-db (the CronJob points it at postgres16-ro). */
  databaseUrl?: string;
  /** Path to LazyLibrarian's database file for ll-db. */
  llDbPath?: string;
  lokiUrl?: string;
  prometheusUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface QueryRequest {
  source: OwedCheckSource;
  query: string;
  /** Evaluation instant (ms) for loki / prometheus. */
  at: number;
}

export interface Sources {
  run(req: QueryRequest): Promise<Observation>;
  close(): Promise<void>;
}

/** One statement that only reads: SELECT or WITH, no second statement. Comments and a trailing `;` are allowed. */
export function assertSingleSelect(sql: string): void {
  const stripped = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()
    .replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(stripped)) throw new Error('only a SELECT or WITH query may run');
  if (stripped.includes(';')) throw new Error('only one statement may run');
}

/** Sum an instant-query answer (Loki and Prometheus share the shape). An empty vector is 0. */
export function sumInstantResult(body: unknown): number {
  const data =
    (body as { status?: string; data?: { resultType?: string; result?: unknown } }) ?? {};
  if (data.status !== 'success' || !data.data)
    throw new Error(`query failed: ${JSON.stringify(body).slice(0, 200)}`);
  const { resultType, result } = data.data;
  if (resultType === 'scalar') return Number((result as [number, string])[1]);
  if (resultType === 'vector') {
    return (result as { value: [number, string] }[]).reduce(
      (sum, s) => sum + Number(s.value[1]),
      0,
    );
  }
  throw new Error(
    `a ${resultType ?? 'unknown'} answer: use a metric query that returns one number`,
  );
}

async function instantQuery(
  base: string | undefined,
  path: string,
  query: string,
  at: number,
  fetchImpl: typeof fetch,
): Promise<number> {
  if (!base) throw new Error('source not configured in this runner');
  const url = new URL(path, base);
  url.searchParams.set('query', query);
  url.searchParams.set('time', (at / 1000).toFixed(3));
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return sumInstantResult(JSON.parse(text));
}

/**
 * Postgres, read-only three ways (the -ro service, the session default, the explicit read-only transaction). A
 * connection the server drops between queries (a standby's recovery conflict, a failover) is recorded by the `error`
 * listener instead of crashing the process; `broken()` then tells the caller to reconnect.
 */
export async function openAppDb(
  databaseUrl: string,
  applicationName = 'owed-checks',
): Promise<{
  query(sql: string): Promise<Record<string, unknown>[]>;
  broken(): boolean;
  close(): Promise<void>;
}> {
  const client = new pg.Client({
    connectionString: databaseUrl,
    options: '-c default_transaction_read_only=on -c statement_timeout=30000',
    application_name: applicationName,
  });
  let lost: Error | null = null;
  client.on('error', (error) => {
    lost = error;
  });
  try {
    await client.connect();
    const ro = await client.query<{ default_transaction_read_only: string }>(
      'SHOW default_transaction_read_only',
    );
    if (ro.rows[0]?.default_transaction_read_only !== 'on') {
      throw new Error('app-db session is not read-only; refusing to run checks');
    }
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
  return {
    async query(sql) {
      if (lost) throw new Error(`app-db connection lost: ${(lost as Error).message}`);
      await client.query('BEGIN READ ONLY');
      try {
        return (await client.query(sql)).rows as Record<string, unknown>[];
      } finally {
        // Never let a failed ROLLBACK (a dead connection) replace the query's own error.
        await client.query('ROLLBACK').catch(() => {});
      }
    },
    broken: () => lost !== null,
    close: () => client.end(),
  };
}

/** LazyLibrarian's SQLite, opened read-only (SQLITE_OPEN_READONLY) with writes refused again by query_only. */
export function openLlDb(path: string): {
  query(sql: string): Record<string, unknown>[];
  close(): void;
} {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  db.exec('PRAGMA query_only = ON');
  return {
    query: (sql) => db.prepare(sql).all() as Record<string, unknown>[],
    close: () => db.close(),
  };
}

/** The sources a runner has, opened lazily on first use and closed once at the end. */
export function createSources(config: SourceConfig): Sources {
  const fetchImpl = config.fetchImpl ?? fetch;
  let appDb: Awaited<ReturnType<typeof openAppDb>> | null = null;
  let llDb: ReturnType<typeof openLlDb> | null = null;
  return {
    async run(req) {
      switch (req.source) {
        case 'app-db': {
          assertSingleSelect(req.query);
          if (!config.databaseUrl) throw new Error('source not configured in this runner');
          if (appDb?.broken()) {
            await appDb.close().catch(() => {});
            appDb = null;
          }
          appDb ??= await openAppDb(config.databaseUrl);
          return { kind: 'rows', rows: await appDb.query(req.query) };
        }
        case 'll-db': {
          assertSingleSelect(req.query);
          if (!config.llDbPath) throw new Error('source not configured in this runner');
          llDb ??= openLlDb(config.llDbPath);
          return { kind: 'rows', rows: llDb.query(req.query) };
        }
        case 'loki':
          return {
            kind: 'value',
            value: await instantQuery(
              config.lokiUrl,
              '/loki/api/v1/query',
              req.query,
              req.at,
              fetchImpl,
            ),
          };
        case 'prometheus':
          return {
            kind: 'value',
            value: await instantQuery(
              config.prometheusUrl,
              '/api/v1/query',
              req.query,
              req.at,
              fetchImpl,
            ),
          };
      }
    },
    async close() {
      llDb?.close();
      await appDb?.close().catch(() => {});
    },
  };
}
