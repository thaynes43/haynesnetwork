/** The public pool lifecycle used by test-owned node-postgres pools. No private client list is inspected. */
interface PoolLifecycle {
  on(event: 'connect' | 'remove', listener: (client: unknown) => void): unknown;
  off(event: 'connect' | 'remove', listener: (client: unknown) => void): unknown;
  end(): Promise<void>;
}

/**
 * Register before the pool's first query, then await the returned closer BEFORE stopping embedded PostgreSQL.
 * pg-pool can resolve end() before an idle client's socket-close callback emits remove. Track each connected client
 * until that public event, including a connecting client that finishes while end() is pending. Existing in-flight
 * removals stay tracked too. Errors are never suppressed; a missing close fails within the cleanup deadline.
 */
export function trackPoolClose(pool: PoolLifecycle, timeoutMs = 15_000): () => Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Pool cleanup timeout must be positive');
  const clients = new Set<unknown>();
  let changed = () => {};
  const connected = (client: unknown) => { clients.add(client); changed(); };
  const removed = (client: unknown) => { clients.delete(client); changed(); };
  pool.on('connect', connected);
  pool.on('remove', removed);
  let closing: Promise<void> | undefined;

  async function close(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poolEnded = false;
    const drained = new Promise<void>((resolve) => {
      changed = () => { if (poolEnded && clients.size === 0) resolve(); };
    });
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Postgres pool connections did not close before the cleanup deadline')), timeoutMs);
    });
    try {
      const ended = pool.end().then(() => { poolEnded = true; changed(); });
      await Promise.race([Promise.all([ended, drained]), deadline]);
    } finally {
      clearTimeout(timer);
      changed = () => {};
      pool.off('connect', connected);
      pool.off('remove', removed);
    }
  }
  return () => closing ??= close();
}
