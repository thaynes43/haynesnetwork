import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

/**
 * ADR-010 / CLAUDE.md hard rule 1: tests run against a REAL embedded Postgres 16 binary
 * (no Docker in this WSL distro, never SQLite/MySQL substitution). This replaces the
 * donor repo's Testcontainers-based `startPostgres` with the same API shape.
 */
export interface StartedPostgres {
  connectionString: string;
  stop: () => Promise<void>;
}

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const PG_DATABASE = 'hnet_test';
const START_ATTEMPTS = 3;
const STOP_DEADLINE_MS = 15_000;

/**
 * Stop an embedded server without ever hanging. `EmbeddedPostgres.stop()` sends SIGINT and then waits
 * for the child's `exit` event, but if the postgres process has ALREADY exited (the classic case: the
 * free port picked by `getFreePort` was taken by a sibling test process before postgres bound it, so
 * postgres died at startup and `start()` rejected) that event has already fired and `stop()` awaits it
 * forever. That turned one lost port race into a 60 s test / 240 s hook timeout instead of the retry
 * below. So: skip `stop()` for a dead process, and put a deadline on a live one.
 */
async function stopQuietly(pg: EmbeddedPostgres): Promise<void> {
  const proc = (pg as unknown as { process?: ChildProcess }).process;
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pg.stop(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          proc.kill('SIGKILL');
          resolve();
        }, STOP_DEADLINE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/**
 * Boot an embedded PostgreSQL 16 server on a free localhost port with a throwaway data
 * directory (initdb → start → createdb). Returns the connection string and an
 * idempotent `stop()` that shuts the server down and removes the data dir.
 */
export async function startPostgres(): Promise<StartedPostgres> {
  let lastError: unknown;
  for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
    const port = await getFreePort();
    const dataDir = await mkdtemp(join(tmpdir(), 'hnet-pg-'));
    const pg = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: PG_USER,
      password: PG_PASSWORD,
      port,
      persistent: false,
      onLog: () => {}, // keep initdb/server chatter out of test output
    });
    try {
      await pg.initialise();
      await pg.start();
      await pg.createDatabase(PG_DATABASE);
      let stopped = false;
      return {
        connectionString: `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${port}/${PG_DATABASE}`,
        stop: async () => {
          if (stopped) return;
          stopped = true;
          await stopQuietly(pg);
          await rm(dataDir, { recursive: true, force: true });
        },
      };
    } catch (err) {
      // Port race or startup hiccup — clean up and retry on a fresh port/data dir.
      lastError = err;
      try {
        await stopQuietly(pg);
      } catch {
        // best effort — the server may never have started
      }
      await rm(dataDir, { recursive: true, force: true });
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`embedded Postgres failed to start after ${START_ATTEMPTS} attempts`);
}
