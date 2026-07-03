import { drizzle } from 'drizzle-orm/node-postgres';
import { and, asc, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { getErrorShape, TRPCError } from '@trpc/server';
import { startPostgres } from '@hnet/test-utils';
import { runMigrations } from '@hnet/db/migrate';
import * as schema from '@hnet/db/schema';
import type { Database } from '@hnet/db';
import type { SessionUser } from '@hnet/auth';
import {
  upsertMediaItemsBatch,
  type ArrClientBundle,
  type MediaItemSyncFields,
} from '@hnet/domain';
import { appRouter } from '../src/routers/index';
import { createCallerFactory, type TRPCContext } from '../src/trpc';

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
  const db = drizzle(pool, { schema }) as Database;
  return {
    db,
    pool,
    stop: async () => {
      await pool.end();
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

/** The fake SessionUser the tests hand to the context (no HTTP, no Better Auth). */
export function sessionUser(row: typeof schema.users.$inferSelect): SessionUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    isFamily: row.isFamily,
  };
}

export function makeCtx(
  db: Database,
  user: SessionUser | null,
  arr?: ArrClientBundle,
): TRPCContext {
  return { db, user, ...(arr !== undefined ? { arr } : {}) };
}

let arrItemSeq = 500;

/**
 * Seed a media_items row through the D-12 single writer (upsertMediaItemsBatch —
 * direct inserts are forbidden by the no-direct-writes guard) and return the row.
 */
export async function seedMediaItem(
  db: Database,
  arrKind: schema.ArrKind,
  fields: Partial<MediaItemSyncFields> & { title: string },
): Promise<typeof schema.mediaItems.$inferSelect> {
  const arrItemId = fields.arrItemId ?? ++arrItemSeq;
  const item: MediaItemSyncFields = {
    title: fields.title,
    arrItemId,
    tvdbId: arrKind === 'sonarr' ? (fields.tvdbId ?? 100_000 + arrItemId) : (fields.tvdbId ?? null),
    tmdbId: arrKind === 'radarr' ? (fields.tmdbId ?? 200_000 + arrItemId) : (fields.tmdbId ?? null),
    musicbrainzArtistId:
      arrKind === 'lidarr'
        ? (fields.musicbrainzArtistId ??
          `00000000-0000-0000-0000-${String(arrItemId).padStart(12, '0')}`)
        : (fields.musicbrainzArtistId ?? null),
    sortTitle: fields.sortTitle ?? fields.title.toLowerCase(),
    year: fields.year ?? 2020,
    monitored: fields.monitored ?? true,
    qualityProfileId: fields.qualityProfileId ?? 1,
    qualityProfileName: fields.qualityProfileName ?? 'Any',
    metadataProfileId: fields.metadataProfileId ?? null,
    metadataProfileName: fields.metadataProfileName ?? null,
    rootFolder: fields.rootFolder ?? '/data/haynestower/Media/TV Shows',
    arrTags: fields.arrTags ?? [],
    onDiskFileCount: fields.onDiskFileCount ?? 1,
    expectedFileCount: fields.expectedFileCount ?? 1,
    sizeOnDisk: fields.sizeOnDisk ?? 1000,
    arrAttrs: fields.arrAttrs ?? {},
  };
  await upsertMediaItemsBatch({ db, arrKind, items: [item] });
  const [row] = await db
    .select()
    .from(schema.mediaItems)
    .where(and(eq(schema.mediaItems.arrKind, arrKind), eq(schema.mediaItems.arrItemId, arrItemId)));
  if (!row) throw new Error('seeded media item not found');
  return row;
}

const callerFactory = createCallerFactory(appRouter);
export type Caller = ReturnType<typeof callerFactory>;

export function caller(ctx: TRPCContext): Caller {
  return callerFactory(ctx);
}

/**
 * A Database stand-in for ladder tests that never reach a resolver: any access is a
 * test failure (the UNAUTHORIZED/FORBIDDEN gate must fire before any query runs).
 */
export function forbidDbAccess(): Database {
  return new Proxy({} as Database, {
    get(_target, prop) {
      throw new Error(
        `unexpected ctx.db access (.${String(prop)}) — the ladder should reject first`,
      );
    },
  });
}

/** permission_audit rows for one subject/app/tag combination, oldest first (reads are unguarded). */
export async function auditRows(db: Database, action: schema.PermissionAuditAction) {
  return db
    .select({
      actorId: schema.permissionAudit.actorId,
      action: schema.permissionAudit.action,
      subjectUserId: schema.permissionAudit.subjectUserId,
      appId: schema.permissionAudit.appId,
      tagId: schema.permissionAudit.tagId,
      detail: schema.permissionAudit.detail,
    })
    .from(schema.permissionAudit)
    .where(eq(schema.permissionAudit.action, action))
    .orderBy(asc(schema.permissionAudit.createdAt));
}

/**
 * Runs the router's real errorFormatter over a thrown TRPCError — the same code path
 * the HTTP adapter uses to build the wire shape — so tests can assert `data.appCode`
 * (DESIGN-003 D-13) without a server.
 */
export function wireShape(
  error: unknown,
  path: string,
): { message: string; data: { code: string; appCode?: string } } {
  if (!(error instanceof TRPCError)) {
    throw new Error(`expected a TRPCError, got ${String(error)}`);
  }
  return getErrorShape({
    config: appRouter._def._config,
    error,
    type: 'mutation',
    path,
    input: undefined,
    ctx: undefined,
  }) as { message: string; data: { code: string; appCode?: string } };
}
