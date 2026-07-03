import {
  appCatalog,
  permissionAudit,
  tagAppGrants,
  tags,
  userTags,
  users,
  type DbClient,
  type Transaction,
} from '@hnet/db';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { NotFoundError, TagNameConflictError, isPostgresUniqueViolation } from './errors';
import { inTransaction } from './db-client';

/** A tag's permission bundle (DESIGN-003 TagBundleInput; replace-whole-bundle semantics). */
export interface TagBundle {
  appIds: string[];
  isFamily: boolean;
}

export interface CreateTagInput {
  db?: DbClient;
  name: string;
  description?: string | null;
  bundle?: Partial<TagBundle>;
  actorId: string | null;
}

export interface UpdateTagInput {
  db?: DbClient;
  tagId: string;
  name?: string;
  description?: string | null;
  /** When provided, replaces the whole bundle (app set + isFamily). */
  bundle?: TagBundle;
  actorId: string | null;
}

export interface DeleteTagInput {
  db?: DbClient;
  tagId: string;
  actorId: string | null;
}

export interface ApplyTagInput {
  db?: DbClient;
  tagId: string;
  userId: string;
  actorId: string | null;
}

export type RemoveTagInput = ApplyTagInput;

async function bundleAppRefs(
  tx: Transaction,
  appIds: string[],
): Promise<Array<{ id: string; slug: string }>> {
  if (appIds.length === 0) return [];
  const rows = await tx
    .select({ id: appCatalog.id, slug: appCatalog.slug })
    .from(appCatalog)
    .where(inArray(appCatalog.id, appIds));
  if (rows.length !== new Set(appIds).size) {
    const found = new Set(rows.map((r) => r.id));
    const missing = appIds.filter((id) => !found.has(id));
    throw new NotFoundError(`Catalog app(s) not found: ${missing.join(', ')}`);
  }
  return rows;
}

/**
 * DESIGN-001 D-07/D-12 — create a tag (+ its tag_app_grants bundle) and the
 * 'create_tag' audit row in ONE transaction. Duplicate name → TagNameConflictError.
 */
export async function createTag(input: CreateTagInput): Promise<{ tagId: string }> {
  return inTransaction(input.db, async (tx) => {
    const appIds = input.bundle?.appIds ?? [];
    const isFamily = input.bundle?.isFamily ?? false;
    const apps = await bundleAppRefs(tx, appIds);

    let tagRow: { id: string } | undefined;
    try {
      [tagRow] = await tx
        .insert(tags)
        .values({
          name: input.name,
          description: input.description ?? null,
          isFamily,
        })
        .returning({ id: tags.id });
    } catch (err) {
      if (isPostgresUniqueViolation(err)) {
        throw new TagNameConflictError(`A tag named '${input.name}' already exists`);
      }
      throw err;
    }
    if (!tagRow) {
      throw new Error('tag insert returned no row');
    }

    if (apps.length > 0) {
      await tx
        .insert(tagAppGrants)
        .values(apps.map((app) => ({ tagId: tagRow.id, appId: app.id })));
    }

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'create_tag',
      tagId: tagRow.id,
      detail: { tag_name: input.name, is_family: isFamily, apps },
    });

    return { tagId: tagRow.id };
  });
}

/**
 * DESIGN-001 D-07/D-08/D-12 — update a tag (name/description and/or whole-bundle
 * replacement) + one 'update_tag' audit row carrying the before/after delta.
 */
export async function updateTag(input: UpdateTagInput): Promise<{ changed: boolean }> {
  return inTransaction(input.db, async (tx) => {
    const [before] = await tx
      .select({
        name: tags.name,
        description: tags.description,
        isFamily: tags.isFamily,
      })
      .from(tags)
      .where(eq(tags.id, input.tagId))
      .for('update');
    if (!before) {
      throw new NotFoundError(`Tag ${input.tagId} not found`);
    }

    const beforeApps = await tx
      .select({ id: tagAppGrants.appId, slug: appCatalog.slug })
      .from(tagAppGrants)
      .innerJoin(appCatalog, eq(appCatalog.id, tagAppGrants.appId))
      .where(eq(tagAppGrants.tagId, input.tagId))
      .orderBy(asc(appCatalog.slug));

    if (input.name !== undefined && input.name !== before.name) {
      const [conflict] = await tx
        .select({ id: tags.id })
        .from(tags)
        .where(and(eq(tags.name, input.name), ne(tags.id, input.tagId)));
      if (conflict) {
        throw new TagNameConflictError(`A tag named '${input.name}' already exists`);
      }
    }

    const afterName = input.name ?? before.name;
    const afterDescription =
      input.description === undefined ? before.description : input.description;
    const afterIsFamily = input.bundle?.isFamily ?? before.isFamily;
    const afterApps = input.bundle ? await bundleAppRefs(tx, input.bundle.appIds) : beforeApps;

    await tx
      .update(tags)
      .set({
        name: afterName,
        description: afterDescription,
        isFamily: afterIsFamily,
        updatedAt: sql`now()`,
      })
      .where(eq(tags.id, input.tagId));

    if (input.bundle) {
      // Replace-whole-bundle semantics (DESIGN-003 D-06).
      await tx.delete(tagAppGrants).where(eq(tagAppGrants.tagId, input.tagId));
      if (afterApps.length > 0) {
        await tx
          .insert(tagAppGrants)
          .values(afterApps.map((app) => ({ tagId: input.tagId, appId: app.id })));
      }
    }

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'update_tag',
      tagId: input.tagId,
      detail: {
        before: {
          tag_name: before.name,
          description: before.description,
          is_family: before.isFamily,
          apps: beforeApps,
        },
        after: {
          tag_name: afterName,
          description: afterDescription,
          is_family: afterIsFamily,
          apps: afterApps,
        },
      },
    });

    return { changed: true };
  });
}

/**
 * DESIGN-001 D-07/D-12 — delete a tag + its 'delete_tag' audit row in ONE transaction.
 * The audit row is written BEFORE the delete so its tag_id FK is SET NULL by the
 * cascade while the jsonb detail keeps the human-readable snapshot (D-10 rule 2).
 * user_tags / tag_app_grants rows cascade away.
 */
export async function deleteTag(input: DeleteTagInput): Promise<void> {
  return inTransaction(input.db, async (tx) => {
    const [tag] = await tx
      .select({ name: tags.name, isFamily: tags.isFamily })
      .from(tags)
      .where(eq(tags.id, input.tagId))
      .for('update');
    if (!tag) {
      throw new NotFoundError(`Tag ${input.tagId} not found`);
    }
    const apps = await tx
      .select({ id: tagAppGrants.appId, slug: appCatalog.slug })
      .from(tagAppGrants)
      .innerJoin(appCatalog, eq(appCatalog.id, tagAppGrants.appId))
      .where(eq(tagAppGrants.tagId, input.tagId));

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'delete_tag',
      tagId: input.tagId,
      detail: { tag_name: tag.name, is_family: tag.isFamily, apps },
    });

    await tx.delete(tags).where(eq(tags.id, input.tagId));
  });
}

/**
 * DESIGN-001 D-09/D-12 — apply a tag to a user (R-21, by reference — never copies
 * grants) + 'apply_tag' audit row. Idempotent: already applied → no-op, no audit row.
 */
export async function applyTag(input: ApplyTagInput): Promise<{ changed: boolean }> {
  return inTransaction(input.db, async (tx) => {
    const [tag] = await tx.select({ name: tags.name }).from(tags).where(eq(tags.id, input.tagId));
    if (!tag) {
      throw new NotFoundError(`Tag ${input.tagId} not found`);
    }
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId));
    if (!user) {
      throw new NotFoundError(`User ${input.userId} not found`);
    }

    const [existing] = await tx
      .select({ id: userTags.id })
      .from(userTags)
      .where(and(eq(userTags.userId, input.userId), eq(userTags.tagId, input.tagId)));
    if (existing) {
      return { changed: false };
    }

    await tx.insert(userTags).values({
      userId: input.userId,
      tagId: input.tagId,
      appliedBy: input.actorId,
    });

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'apply_tag',
      subjectUserId: input.userId,
      tagId: input.tagId,
      detail: { tag_name: tag.name },
    });

    return { changed: true };
  });
}

/**
 * DESIGN-001 D-09/D-12 — remove a tag from a user + 'remove_tag' audit row. Removes
 * exactly the tag-derived permissions (AC-06). Idempotent: not applied → no-op.
 */
export async function removeTag(input: RemoveTagInput): Promise<{ changed: boolean }> {
  return inTransaction(input.db, async (tx) => {
    const [tag] = await tx.select({ name: tags.name }).from(tags).where(eq(tags.id, input.tagId));
    if (!tag) {
      throw new NotFoundError(`Tag ${input.tagId} not found`);
    }

    const deleted = await tx
      .delete(userTags)
      .where(and(eq(userTags.userId, input.userId), eq(userTags.tagId, input.tagId)))
      .returning({ id: userTags.id });
    if (deleted.length === 0) {
      return { changed: false };
    }

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'remove_tag',
      subjectUserId: input.userId,
      tagId: input.tagId,
      detail: { tag_name: tag.name },
    });

    return { changed: true };
  });
}
