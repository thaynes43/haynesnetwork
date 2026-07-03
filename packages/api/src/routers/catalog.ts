// DESIGN-003 D-04..D-08 — catalog router. Reads project with drizzle; every write
// delegates to an @hnet/domain single-writer helper that co-writes its
// permission_audit row in the same transaction (ADR-003, R-04 — the no-direct-writes
// guard test enforces this).
import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import { appCatalog } from '@hnet/db';
import {
  createApp,
  deleteApp,
  effectiveAppsForUser,
  reorderCatalog,
  updateApp,
} from '@hnet/domain';
import { authedProcedure, mapDomainErrors, router } from '../trpc';
import { adminProcedure } from '../middleware/role';
import { CatalogEntryInput, CatalogEntryPatchInput } from '../schemas';

/** Provenance-free tile shape for catalog.myApps (D-05; DESIGN-004 §D-07). */
export interface MyApp {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  url: string;
}

export const catalogRouter = router({
  /**
   * R-10 — effective visible apps for the caller (D-05):
   * defaultVisible entries ∪ direct grants ∪ tag grants, deduped on app id, ordered by
   * sort_order, name (DESIGN-001 D-05). Provenance-free — admin views recompute
   * provenance client-side from users.list + catalog.adminList + tags.list (D-09).
   */
  myApps: authedProcedure.query(async ({ ctx }): Promise<MyApp[]> => {
    const defaults = await ctx.db
      .select({
        id: appCatalog.id,
        slug: appCatalog.slug,
        name: appCatalog.name,
        description: appCatalog.description,
        icon: appCatalog.icon,
        url: appCatalog.url,
        sortOrder: appCatalog.sortOrder,
      })
      .from(appCatalog)
      .where(eq(appCatalog.defaultVisible, true));
    const granted = await effectiveAppsForUser(ctx.user.id, ctx.db);

    const byId = new Map<string, MyApp & { sortOrder: number }>();
    for (const row of defaults) {
      byId.set(row.id, row);
    }
    for (const row of granted) {
      // effectiveAppsForUser yields one row per provenance (direct + each tag) —
      // the dashboard union dedupes on app id.
      byId.set(row.appId, {
        id: row.appId,
        slug: row.slug,
        name: row.name,
        description: row.description,
        icon: row.icon,
        url: row.url,
        sortOrder: row.sortOrder,
      });
    }
    return [...byId.values()]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .map(({ sortOrder: _sortOrder, ...app }) => app);
  }),

  /** R-11 — every entry incl. hidden ones + defaultVisible + sortOrder (admin table). */
  adminList: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select()
      .from(appCatalog)
      .orderBy(asc(appCatalog.sortOrder), asc(appCatalog.name));
    // D-03: timestamps go over the wire as ISO-8601 strings, never raw Dates.
    return rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }),

  create: adminProcedure.input(CatalogEntryInput).mutation(async ({ ctx, input }) => {
    // domain.createApp re-asserts R-14 (D-04 layer 2) and audits 'create_app' (D-07/D-08).
    return mapDomainErrors(() => createApp({ db: ctx.db, ...input, actorId: ctx.user.id }));
  }),

  update: adminProcedure
    // slug omitted: it is the stable machine key (DESIGN-001 D-05) referenced by audit
    // detail snapshots — immutable after create.
    .input(CatalogEntryPatchInput)
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      // Audits 'update_app' with before/after detail — defaultVisible flips and URL
      // edits are permission-affecting (D-08).
      return mapDomainErrors(() =>
        updateApp({ db: ctx.db, appId: id, patch, actorId: ctx.user.id }),
      );
    }),

  delete: adminProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    // Audits 'delete_app'; dependent grants cascade (DESIGN-001 D-06) in the SAME
    // transaction (ADR-003).
    return mapDomainErrors(() => deleteApp({ db: ctx.db, appId: input.id, actorId: ctx.user.id }));
  }),

  /**
   * Total reordering (D-06): the client sends the complete id set in the new order;
   * the domain helper reassigns sort_order in gaps of 10 (10, 20, …) matching the seed
   * convention. A stale/partial set → ReorderMismatchError (CONFLICT) rather than
   * silently interleaving. Audited as a single 'update_app' row (D-08).
   */
  reorder: adminProcedure
    .input(z.object({ orderedIds: z.array(z.uuid()).min(1) }))
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(() =>
        reorderCatalog({ db: ctx.db, orderedIds: input.orderedIds, actorId: ctx.user.id }),
      );
    }),
});
