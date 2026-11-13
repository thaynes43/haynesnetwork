import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
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
 * that case was `clear`. Stamp each item that has no fitting match with a date older than 180 days
 * so the Age Guard can clear it. ADR-123 deletes a cross-type row inside `syncPlexMatches`, so a show
 * stamped into a movie library would not survive; each kind is stamped into the library type that fits
 * it. An item that already has a fitting match, including an undated one, is left as the test set it up.
 */
export async function stampOldPlexMatches(db: DbClient): Promise<void> {
  const libraries = [
    { sectionKey: 'age-guard-dated-movie', name: 'Age Guard Movies', mediaType: 'movie' as const },
    { sectionKey: 'age-guard-dated-show', name: 'Age Guard Shows', mediaType: 'show' as const },
    { sectionKey: 'age-guard-dated-artist', name: 'Age Guard Music', mediaType: 'artist' as const },
  ];
  await upsertPlexLibraries({ db, slug: 'haynesops', libraries });
  const libs = await db.select().from(schema.plexLibraries);
  const byType = new Map(
    libs
      .filter((l) => l.sectionKey.startsWith('age-guard-dated-'))
      .map((l) => [l.mediaType, l.id] as const),
  );
  const typeForKind = (kind: string): 'movie' | 'show' | 'artist' | undefined => {
    if (kind === 'radarr') return 'movie';
    if (kind === 'sonarr') return 'show';
    if (kind === 'lidarr') return 'artist';
    return undefined;
  };
  const items = await db
    .select({ id: schema.mediaItems.id, arrKind: schema.mediaItems.arrKind })
    .from(schema.mediaItems);
  const kindById = new Map(items.map((item) => [item.id, item.arrKind]));
  const matched = await db
    .select({
      mediaItemId: schema.mediaPlexMatches.mediaItemId,
      mediaType: schema.plexLibraries.mediaType,
    })
    .from(schema.mediaPlexMatches)
    .innerJoin(
      schema.plexLibraries,
      eq(schema.plexLibraries.id, schema.mediaPlexMatches.plexLibraryId),
    );
  const haveFitting = new Set(
    matched
      .filter((row) => typeForKind(kindById.get(row.mediaItemId) ?? '') === row.mediaType)
      .map((row) => row.mediaItemId),
  );
  const missing = items.filter((item) => {
    const type = typeForKind(item.arrKind);
    return type !== undefined && byType.has(type) && !haveFitting.has(item.id);
  });
  if (missing.length === 0) return;
  const old = new Date(Date.now() - 400 * 86_400_000);
  await syncPlexMatches({
    db,
    matches: missing.map((item) => ({
      mediaItemId: item.id,
      plexLibraryId: byType.get(typeForKind(item.arrKind)!)!,
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
