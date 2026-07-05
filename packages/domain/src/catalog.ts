import { appCatalog, permissionAudit, type DbClient } from '@hnet/db';
import { asc, eq, sql } from 'drizzle-orm';
import { NotFoundError, ReorderMismatchError } from './errors';
import { assertCatalogUrl } from './url-assert';
import { inTransaction } from './db-client';

export interface CreateAppInput {
  db?: DbClient;
  slug: string;
  name: string;
  description?: string | null;
  url: string;
  icon?: string | null;
  sortOrder?: number;
  actorId: string | null;
}

export interface UpdateAppPatch {
  name?: string;
  description?: string | null;
  url?: string;
  icon?: string | null;
  sortOrder?: number;
}

export interface UpdateAppInput {
  db?: DbClient;
  appId: string;
  patch: UpdateAppPatch;
  actorId: string | null;
}

export interface DeleteAppInput {
  db?: DbClient;
  appId: string;
  actorId: string | null;
}

export interface ReorderCatalogInput {
  db?: DbClient;
  /** The COMPLETE catalog id set in the new display order. */
  orderedIds: string[];
  actorId: string | null;
}

/**
 * DESIGN-001 D-05/D-12 — create a catalog entry + its 'create_app' audit row in ONE
 * transaction. Normalizes the URL (ADR-013 arbitrary-URL normalization) so the DB +
 * audit rows store the canonical form; the scheme-only DB CHECK is the final backstop.
 */
export async function createApp(input: CreateAppInput): Promise<{ appId: string }> {
  const url = assertCatalogUrl(input.url);
  return inTransaction(input.db, async (tx) => {
    const [row] = await tx
      .insert(appCatalog)
      .values({
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        url,
        icon: input.icon ?? null,
        sortOrder: input.sortOrder ?? 0,
      })
      .returning({ id: appCatalog.id });
    if (!row) {
      throw new Error('app_catalog insert returned no row');
    }

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'create_app',
      appId: row.id,
      detail: {
        app_slug: input.slug,
        app_name: input.name,
        url,
      },
    });

    return { appId: row.id };
  });
}

/**
 * DESIGN-001 D-05/D-12 — update a catalog entry + one 'update_app' audit row with a
 * before/after snapshot of the patched fields (a URL edit is permission-relevant —
 * DESIGN-003 D-08). Slug is immutable (the stable machine key). A patched URL is
 * normalized (ADR-013 arbitrary-URL normalization) so DB + audit store the canonical form.
 */
export async function updateApp(input: UpdateAppInput): Promise<{ changed: boolean }> {
  if (input.patch.url !== undefined) {
    input.patch.url = assertCatalogUrl(input.patch.url);
  }
  return inTransaction(input.db, async (tx) => {
    const [before] = await tx
      .select()
      .from(appCatalog)
      .where(eq(appCatalog.id, input.appId))
      .for('update');
    if (!before) {
      throw new NotFoundError(`Catalog app ${input.appId} not found`);
    }

    const patchedKeys = (
      ['name', 'description', 'url', 'icon', 'sortOrder'] as const
    ).filter((key) => input.patch[key] !== undefined);
    if (patchedKeys.length === 0) {
      return { changed: false };
    }

    await tx
      .update(appCatalog)
      .set({ ...input.patch, updatedAt: sql`now()` })
      .where(eq(appCatalog.id, input.appId));

    const snapshot = (source: { [K in (typeof patchedKeys)[number]]?: unknown }) =>
      Object.fromEntries(patchedKeys.map((key) => [key, source[key]]));

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'update_app',
      appId: input.appId,
      detail: {
        app_slug: before.slug,
        before: snapshot(before),
        after: snapshot(input.patch),
      },
    });

    return { changed: true };
  });
}

/**
 * DESIGN-001 D-05/D-12 — delete a catalog entry + its 'delete_app' audit row in ONE
 * transaction. Dependent grants cascade away; the audit row is written BEFORE the
 * delete so its app_id FK is SET NULL by the cascade while the jsonb detail keeps the
 * snapshot (D-10 rule 2).
 */
export async function deleteApp(input: DeleteAppInput): Promise<void> {
  return inTransaction(input.db, async (tx) => {
    const [app] = await tx
      .select({ slug: appCatalog.slug, name: appCatalog.name, url: appCatalog.url })
      .from(appCatalog)
      .where(eq(appCatalog.id, input.appId))
      .for('update');
    if (!app) {
      throw new NotFoundError(`Catalog app ${input.appId} not found`);
    }

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'delete_app',
      appId: input.appId,
      detail: { app_slug: app.slug, app_name: app.name, url: app.url },
    });

    await tx.delete(appCatalog).where(eq(appCatalog.id, input.appId));
  });
}

/**
 * DESIGN-003 D-06 — total reordering: the client sends the complete id set in the new
 * order; sort_order is reassigned in gaps of 10 (10, 20, …) matching the seed
 * convention. A stale/partial/duplicated set throws ReorderMismatchError. Audited as a
 * single 'update_app' row (app_id null, detail = full before/after ordering — D-08).
 */
export async function reorderCatalog(input: ReorderCatalogInput): Promise<{ changed: boolean }> {
  return inTransaction(input.db, async (tx) => {
    const current = await tx
      .select({ id: appCatalog.id, slug: appCatalog.slug })
      .from(appCatalog)
      .orderBy(asc(appCatalog.sortOrder), asc(appCatalog.name))
      .for('update');

    const currentIds = new Set(current.map((row) => row.id));
    const requestedIds = new Set(input.orderedIds);
    const isCompletePermutation =
      requestedIds.size === input.orderedIds.length &&
      requestedIds.size === currentIds.size &&
      input.orderedIds.every((id) => currentIds.has(id));
    if (!isCompletePermutation) {
      throw new ReorderMismatchError(
        'orderedIds must be the complete catalog id set with no duplicates (stale data? refetch and retry)',
      );
    }

    const slugById = new Map(current.map((row) => [row.id, row.slug]));
    for (const [index, id] of input.orderedIds.entries()) {
      await tx
        .update(appCatalog)
        .set({ sortOrder: (index + 1) * 10, updatedAt: sql`now()` })
        .where(eq(appCatalog.id, id));
    }

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'update_app',
      appId: null,
      detail: {
        reorder: true,
        before: current.map((row) => ({ id: row.id, slug: row.slug })),
        after: input.orderedIds.map((id) => ({ id, slug: slugById.get(id) })),
      },
    });

    return { changed: true };
  });
}
