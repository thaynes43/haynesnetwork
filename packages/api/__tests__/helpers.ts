import { drizzle } from 'drizzle-orm/node-postgres';
import { and, asc, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { getErrorShape, TRPCError } from '@trpc/server';
import { startPostgres } from '@hnet/test-utils';
import { runMigrations } from '@hnet/db/migrate';
import * as schema from '@hnet/db/schema';
import type { Database } from '@hnet/db';
import { resolvePlexIdentity, type PlexIdentity, type SessionUser } from '@hnet/auth';
import {
  assignRole,
  upsertMediaItemsBatch,
  type ArrClientBundle,
  type MaintainerrClientBundle,
  type MediaItemSyncFields,
  type PlexClientBundle,
} from '@hnet/domain';
import {
  SEEDED_ROLE_IDS,
  SECTION_IDS,
  SECTION_DEFAULT_LEVELS,
  MESSAGE_ACTIONS,
  TRASH_ACTIONS,
  type MessageAction,
  type SectionId,
  type SectionPermissionLevel,
  type TrashAction,
} from '@hnet/db/schema';
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

/**
 * Insert a plain user row (user creation is Better Auth's job, not a guarded write); role_id
 * defaults to the Default role. Pass `admin: true` to promote to the Admin role via the
 * assignRole single-writer (ADR-012). Returns the fresh row (role_id reflects the promotion).
 */
export async function createUser(
  db: Database,
  overrides: Partial<typeof schema.users.$inferInsert> & { admin?: boolean } = {},
): Promise<typeof schema.users.$inferSelect> {
  const { admin, ...userOverrides } = overrides;
  const [row] = await db
    .insert(schema.users)
    .values({
      email: userOverrides.email ?? `user-${++emailSeq}@example.com`,
      displayName: userOverrides.displayName ?? `User ${emailSeq}`,
      ...userOverrides,
    })
    .returning();
  if (!row) throw new Error('user insert returned no row');
  if (!admin) return row;
  await assignRole({
    db,
    userId: row.id,
    toRoleId: SEEDED_ROLE_IDS.admin,
    initiator: { id: null, kind: 'system' },
  });
  const [fresh] = await db.select().from(schema.users).where(eq(schema.users.id, row.id));
  if (!fresh) throw new Error('user vanished after role assignment');
  return fresh;
}

/**
 * The fake SessionUser the tests hand to the context (no HTTP, no Better Auth). The role
 * object is derived from role_id — the two seeded roles have fixed ids (SEEDED_ROLE_IDS).
 */
export function sessionUser(
  row: typeof schema.users.$inferSelect,
  /** ADR-021 — override the caller's section levels (non-admin only; admin is 'edit' everywhere). */
  sectionOverrides?: Partial<Record<SectionId, SectionPermissionLevel>>,
  /** ADR-023 — override the caller's fine-grained Trash action grants (non-admin only; admin ⇒ all). */
  trashActionOverrides?: TrashAction[],
  /** ADR-026 — override the caller's fine-grained Bulletin message action grants (non-admin; admin ⇒ all). */
  messageActionOverrides?: MessageAction[],
  /**
   * fix/plex-identity-mapping — override the caller's resolved Plex identity (the id_token-claim
   * case). Defaults to the row's admin-override columns (plex_email/plex_username), mirroring prod
   * where getSessionExtension resolves claim → override.
   */
  plexIdentity?: PlexIdentity,
): SessionUser {
  const isAdmin = row.roleId === SEEDED_ROLE_IDS.admin;
  const name = isAdmin ? 'Admin' : row.roleId === SEEDED_ROLE_IDS.default ? 'Default' : 'Custom';
  const sectionPermissions = Object.fromEntries(
    SECTION_IDS.map((sid) => [
      sid,
      isAdmin ? 'edit' : (sectionOverrides?.[sid] ?? SECTION_DEFAULT_LEVELS[sid]),
    ]),
  ) as Record<SectionId, SectionPermissionLevel>;
  const grantedSet = new Set(trashActionOverrides ?? []);
  const trashActions: TrashAction[] = isAdmin
    ? [...TRASH_ACTIONS]
    : TRASH_ACTIONS.filter((a) => grantedSet.has(a));
  const messageGrantedSet = new Set(messageActionOverrides ?? []);
  const messageActions: MessageAction[] = isAdmin
    ? [...MESSAGE_ACTIONS]
    : MESSAGE_ACTIONS.filter((a) => messageGrantedSet.has(a));
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: { id: row.roleId, name, isAdmin, sectionPermissions, trashActions, messageActions },
    plexIdentity:
      plexIdentity ??
      resolvePlexIdentity({ overrideEmail: row.plexEmail, overrideUsername: row.plexUsername }),
  };
}

export function makeCtx(
  db: Database,
  user: SessionUser | null,
  arr?: ArrClientBundle,
  plex?: PlexClientBundle,
  maintainerr?: MaintainerrClientBundle,
): TRPCContext {
  return {
    db,
    user,
    ...(arr !== undefined ? { arr } : {}),
    ...(plex !== undefined ? { plex } : {}),
    ...(maintainerr !== undefined ? { maintainerr } : {}),
  };
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

/** permission_audit rows for one action, oldest first (reads are unguarded). */
export async function auditRows(db: Database, action: schema.PermissionAuditAction) {
  return db
    .select({
      actorId: schema.permissionAudit.actorId,
      action: schema.permissionAudit.action,
      subjectUserId: schema.permissionAudit.subjectUserId,
      appId: schema.permissionAudit.appId,
      roleId: schema.permissionAudit.roleId,
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
