import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { startPostgres, trackPoolClose } from '@hnet/test-utils';
import { runMigrations } from '@hnet/db/migrate';
import * as schema from '@hnet/db/schema';
import type { Database, DbClient } from '@hnet/db';
import {
  EMPTY_WATCHLIST_KEYS,
  createStaticWatchlistSources,
  refreshWatchlistRegistry,
  silentDomainLogger,
  syncPlexMatches,
  upsertMediaItemsBatch,
  upsertPlexLibraries,
  type DeleteWatchlistSnapshot,
  type StaticWatchlistFixture,
  type UpsertMediaItemsBatchInput,
  type UpsertMediaItemsBatchResult,
  type WatchlistRegistryRefreshReport,
  type WatchlistSnapshot,
} from '../src/index';

export interface TestDb {
  db: Database;
  pool: Pool;
  stop: () => Promise<void>;
}

/** Boot an embedded Postgres 16, apply the @hnet/db migrations, hand back a typed client. */
export async function bootMigratedDb(): Promise<TestDb> {
  const started = await startPostgres();
  await runMigrations({ databaseUrl: started.connectionString });
  const pool = new Pool({ connectionString: started.connectionString });
  const closePool = trackPoolClose(pool);
  const db = drizzle(pool, { schema }) as Database;
  return {
    db,
    pool,
    stop: async () => {
      await closePool();
      await started.stop();
    },
  };
}

let emailSeq = 0;

/** Insert a plain user row (user creation is Better Auth's job, not a guarded write). */
export async function createUser(
  db: Database,
  overrides: Partial<typeof schema.users.$inferInsert> = {},
): Promise<typeof schema.users.$inferSelect> {
  const [row] = await db
    .insert(schema.users)
    .values({
      email: overrides.email ?? `user-${++emailSeq}@example.com`,
      displayName: overrides.displayName ?? `User ${emailSeq}`,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('user insert returned no row');
  return row;
}

// ---------------------------------------------------------------------------
// ADR-093 / DESIGN-052 (PLAN-072) — the Watchlist Registry for the Trash tests. Every delete path now takes the
// Registry Gate (D-07), so a test that expedites or sweeps first records a VERIFIED registry run through the real
// single writer, over in-memory sources (no live API, ADR-010). The default fixture is the owner with an empty list:
// nothing is watchlisted and every pool item is evaluable.
// ---------------------------------------------------------------------------

/** A `display` snapshot with nothing listed (walls, shape checks). */
export const TEST_DISPLAY_SNAPSHOT: WatchlistSnapshot = {
  purpose: 'display',
  keys: EMPTY_WATCHLIST_KEYS,
  runId: 'test',
};

/** A verified `delete` snapshot with nothing listed (a direct delete-path helper call). */
export const TEST_DELETE_SNAPSHOT: DeleteWatchlistSnapshot = {
  purpose: 'delete',
  verified: true,
  keys: EMPTY_WATCHLIST_KEYS,
  runId: 'test',
  overlaySince: new Date(0),
};

/** Record a verified registry run now (default: the owner, nothing listed). */
export async function seedVerifiedWatchlistRegistry(
  db: Database,
  fixture: Partial<StaticWatchlistFixture> = {},
): Promise<WatchlistRegistryRefreshReport> {
  const { sources } = createStaticWatchlistSources({ ownerId: '1', ...fixture });
  const report = await refreshWatchlistRegistry({
    db,
    sources,
    trigger: 'manual',
    logger: silentDomainLogger,
    sleep: async () => {},
  });
  if (report.status !== 'ok') throw new Error(`seed registry run failed: ${report.status}`);
  return report;
}

/**
 * ADR-119 — a ledger item with no Plex match is `unknown` (kept). Deletion tests were written when
 * that case was `clear`. Stamp each still-unmatched item with a date older than 180 days so the
 * Age Guard can clear it. An item that already has a match, including an undated one, is left as
 * the test set it up.
 */
export async function stampOldPlexMatches(db: DbClient): Promise<void> {
  await upsertPlexLibraries({
    db,
    slug: 'haynesops',
    libraries: [{ sectionKey: 'age-guard-dated', name: 'Age Guard Dated', mediaType: 'movie' }],
  });
  const libs = await db.select().from(schema.plexLibraries);
  const library = libs.find((l) => l.sectionKey === 'age-guard-dated');
  if (!library) throw new Error('age-guard-dated library was not upserted');
  const items = await db.select({ id: schema.mediaItems.id }).from(schema.mediaItems);
  const matched = await db
    .select({ id: schema.mediaPlexMatches.mediaItemId })
    .from(schema.mediaPlexMatches);
  const have = new Set(matched.map((m) => m.id));
  const missing = items.filter((item) => !have.has(item.id));
  if (missing.length === 0) return;
  const old = new Date(Date.now() - 400 * 86_400_000);
  await syncPlexMatches({
    db,
    matches: missing.map((item) => ({
      mediaItemId: item.id,
      plexLibraryId: library.id,
      ratingKey: `old-${item.id}`,
      matchedVia: 'tmdb',
      plexAddedAt: old,
    })),
    scopedLibraryIds: [],
  });
}

/** Insert ledger items, then date any of them the Age Guard would otherwise keep for lack of a match. */
export async function upsertDeletableMediaItems(
  input: UpsertMediaItemsBatchInput,
): Promise<UpsertMediaItemsBatchResult> {
  const result = await upsertMediaItemsBatch(input);
  if (input.db) await stampOldPlexMatches(input.db);
  return result;
}
