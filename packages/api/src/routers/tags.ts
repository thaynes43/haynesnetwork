// DESIGN-003 D-05/D-06/D-12 — tags router. Tags grant BY REFERENCE, not by copy:
// applying a tag creates only the user↔tag association; effective permissions are
// computed at read time (AC-06, R-21). All writes delegate to @hnet/domain helpers.
import { z } from 'zod';
import { asc, count, eq } from 'drizzle-orm';
import { tagAppGrants, tags, userTags } from '@hnet/db';
import { applyTag, createTag, deleteTag, removeTag, updateTag } from '@hnet/domain';
import { authedProcedure, mapDomainErrors, router } from '../trpc';
import { adminProcedure } from '../middleware/role';
import { TagBundleInput } from '../schemas';

export const tagsRouter = router({
  /**
   * D-12 — authed, role-scoped in the resolver (the one non-admin tags procedure):
   * - Admin  → all tags with full bundles and tagged-user counts (feeds /admin/tags).
   * - Member → only tags applied to the caller, projected to {id,name,description} —
   *   no bundle contents, no other users. (Tag names are member-visible: Q-03.)
   */
  list: authedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role !== 'Admin') {
      const own = await ctx.db
        .select({ id: tags.id, name: tags.name, description: tags.description })
        .from(userTags)
        .innerJoin(tags, eq(tags.id, userTags.tagId))
        .where(eq(userTags.userId, ctx.user.id))
        .orderBy(asc(tags.name));
      return { scope: 'member' as const, tags: own };
    }

    const tagRows = await ctx.db
      .select({
        id: tags.id,
        name: tags.name,
        description: tags.description,
        isFamily: tags.isFamily,
      })
      .from(tags)
      .orderBy(asc(tags.name));
    const bundleRows = await ctx.db
      .select({ tagId: tagAppGrants.tagId, appId: tagAppGrants.appId })
      .from(tagAppGrants);
    const countRows = await ctx.db
      .select({ tagId: userTags.tagId, taggedUsers: count(userTags.id) })
      .from(userTags)
      .groupBy(userTags.tagId);

    const appIdsByTag = new Map<string, string[]>();
    for (const row of bundleRows) {
      const list = appIdsByTag.get(row.tagId) ?? [];
      list.push(row.appId);
      appIdsByTag.set(row.tagId, list);
    }
    const countByTag = new Map(countRows.map((row) => [row.tagId, Number(row.taggedUsers)]));

    return {
      scope: 'admin' as const,
      tags: tagRows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        bundle: { appIds: appIdsByTag.get(row.id) ?? [], isFamily: row.isFamily },
        taggedUserCount: countByTag.get(row.id) ?? 0,
      })),
    };
  }),

  create: adminProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(48),
        description: z.string().trim().max(280).default(''),
        bundle: TagBundleInput,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Audits 'create_tag'; duplicate name → TAG_NAME_CONFLICT (D-13).
      return mapDomainErrors(() => createTag({ db: ctx.db, ...input, actorId: ctx.user.id }));
    }),

  update: adminProcedure
    .input(
      z.object({
        id: z.uuid(),
        name: z.string().trim().min(1).max(48).optional(),
        description: z.string().trim().max(280).optional(),
        bundle: TagBundleInput.optional(), // replace-whole-bundle semantics
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      // Audits 'update_tag' with the bundle delta in permission_audit.detail
      // (DESIGN-001 D-08, R-21 — bundle edits change every tagged user's effective set).
      return mapDomainErrors(() =>
        updateTag({ db: ctx.db, tagId: id, ...patch, actorId: ctx.user.id }),
      );
    }),

  delete: adminProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    // Audits 'delete_tag'; user_tags/tag_app_grants rows cascade (DESIGN-001 D-07..D-09).
    return mapDomainErrors(() => deleteTag({ db: ctx.db, tagId: input.id, actorId: ctx.user.id }));
  }),

  /** R-21 apply. By-reference semantics (D-05). Idempotent (D-11). Audits 'apply_tag'. */
  applyToUser: adminProcedure
    .input(z.object({ tagId: z.uuid(), userId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(() => applyTag({ db: ctx.db, ...input, actorId: ctx.user.id }));
    }),

  /** R-21 remove — removes exactly the tag-derived permissions (AC-06). Idempotent. */
  removeFromUser: adminProcedure
    .input(z.object({ tagId: z.uuid(), userId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(() => removeTag({ db: ctx.db, ...input, actorId: ctx.user.id }));
    }),
});
