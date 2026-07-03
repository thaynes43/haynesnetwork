// DESIGN-003 D-06/D-07/D-11 — users router (admin roster + direct grants + family
// designation). All writes delegate to @hnet/domain single-writer helpers.
import { z } from 'zod';
import { asc } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { tags, userAppGrants, users, userTags } from '@hnet/db';
import { grantApp, revokeApp, setFamilyDesignation } from '@hnet/domain';
import { mapDomainErrors, router } from '../trpc';
import { adminProcedure } from '../middleware/role';

export const usersRouter = router({
  /**
   * R-15/R-22 admin roster: id, displayName, email, role, isFamily (direct
   * designation), createdAt, tags {id,name}[], directGrants {appId}[]. Feeds /admin
   * and /admin/users/[id] — provenance is recomputed client-side from this +
   * catalog.adminList + tags.list, so there is no getById (D-09). Three flat queries
   * grouped in memory beat N+1 per user at household scale.
   */
  list: adminProcedure.query(async ({ ctx }) => {
    const userRows = await ctx.db
      .select({
        id: users.id,
        displayName: users.displayName,
        email: users.email,
        role: users.role,
        isFamily: users.isFamily,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(asc(users.displayName), asc(users.email));
    const tagRows = await ctx.db
      .select({ userId: userTags.userId, tagId: tags.id, tagName: tags.name })
      .from(userTags)
      .innerJoin(tags, eq(tags.id, userTags.tagId))
      .orderBy(asc(tags.name));
    const grantRows = await ctx.db
      .select({ userId: userAppGrants.userId, appId: userAppGrants.appId })
      .from(userAppGrants);

    const tagsByUser = new Map<string, Array<{ id: string; name: string }>>();
    for (const row of tagRows) {
      const list = tagsByUser.get(row.userId) ?? [];
      list.push({ id: row.tagId, name: row.tagName });
      tagsByUser.set(row.userId, list);
    }
    const grantsByUser = new Map<string, Array<{ appId: string }>>();
    for (const row of grantRows) {
      const list = grantsByUser.get(row.userId) ?? [];
      list.push({ appId: row.appId });
      grantsByUser.set(row.userId, list);
    }

    return userRows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(), // D-03: ISO-8601 strings on the wire
      tags: tagsByUser.get(row.id) ?? [],
      directGrants: grantsByUser.get(row.id) ?? [],
    }));
  }),

  /**
   * DIRECT family designation (Actors table; feeds R-26 in Phase 3; effective family
   * also flows from tags — DESIGN-001 D-11). Idempotent (D-11): the already-held state
   * is a no-op with no audit row. Audits 'set_family'/'unset_family'.
   */
  setFamily: adminProcedure
    .input(z.object({ userId: z.uuid(), isFamily: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(() =>
        setFamilyDesignation({ db: ctx.db, ...input, actorId: ctx.user.id }),
      );
    }),

  /** R-15 direct per-user app grant. Idempotent (D-11). Audits 'grant_app'. */
  grantApp: adminProcedure
    .input(z.object({ userId: z.uuid(), appId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(() => grantApp({ db: ctx.db, ...input, actorId: ctx.user.id }));
    }),

  /** R-15 direct per-user app revoke. Idempotent (D-11). Audits 'revoke_app'. */
  revokeApp: adminProcedure
    .input(z.object({ userId: z.uuid(), appId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(() => revokeApp({ db: ctx.db, ...input, actorId: ctx.user.id }));
    }),
});
