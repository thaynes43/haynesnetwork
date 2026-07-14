// ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — the Activity tRPC surface. `list` + `wallStages`
// read LIVE per source (the aggregator merges each adapter, degrade-safe) and gate per-item by the viewer's
// section (a book item needs `books ≥ read_only`); `failure` is the failure detail (section-gated + the
// per-viewer canAct flags); `retryImport`/`forceSearch` are the ROLE-CONTROLLED actions (R2) — gated by
// `activityActionProcedure` (admin OR the role grant), audited same-tx, with the confined LazyLibrarian
// write fired AFTER commit (the fix-flow discipline). Server-authoritative throughout (AC-13).
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
  aggregateActivity,
  activityWallStages,
  getActivityFailure,
  recordActivityAction,
  type ActivitySection,
} from '@hnet/domain';
import type { SectionId } from '@hnet/db';
import { router, mapDomainErrors, resolveActivityBundle, type TRPCContext } from '../trpc';
import { authedProcedure } from '../trpc';
import { activityActionProcedure, effectiveSectionLevel, resolveActivityActions } from '../middleware/role';

/** The sections this viewer may see activity for (SLICE 1: books when it's ≥ read_only). */
function visibleSectionsFor(ctx: TRPCContext & { user: NonNullable<TRPCContext['user']> }): ActivitySection[] {
  const sections: ActivitySection[] = [];
  if (effectiveSectionLevel(ctx.user.role, 'books') !== 'disabled') sections.push('books');
  return sections;
}

/** Parse a books failure ref (`books:ll:<bookId>:<format>`) → the LL searchBook target. */
function parseBooksRef(ref: string): { bookId: string; format: 'ebook' | 'audiobook' } | null {
  const m = /^books:ll:([^:]+):(ebook|audiobook|book)$/.exec(ref);
  if (!m) return null;
  return { bookId: m[1]!, format: m[2] === 'audiobook' ? 'audiobook' : 'ebook' };
}

export const activityRouter = router({
  /** The cross-library Activity list + chip counts (live, section-gated). */
  list: authedProcedure.query(async ({ ctx }) => {
    const visibleSections = visibleSectionsFor(ctx);
    // Only build/run a source adapter the viewer can actually see (avoids members triggering upstream
    // calls). In SLICE 1 that's the books adapter; the future *arr/Kapowarr adapters are universal.
    const adapters = visibleSections.includes('books') ? [resolveActivityBundle(ctx).adapter] : [];
    const result = await aggregateActivity({ db: ctx.db, adapters, visibleSections });
    return { items: result.items, counts: result.counts };
  }),

  /** The per-wall in-flight badge map the wall posters read (books: keyed by LL/GB bookId). */
  wallStages: authedProcedure.query(async ({ ctx }) => {
    const visibleSections = visibleSectionsFor(ctx);
    const adapters = visibleSections.includes('books') ? [resolveActivityBundle(ctx).adapter] : [];
    const result = await aggregateActivity({ db: ctx.db, adapters, visibleSections });
    return activityWallStages(result.items);
  }),

  /** The failure detail (the #264 idiom): the failure facts + the per-viewer canAct flags. */
  failure: authedProcedure
    .input(z.object({ failureId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const row = await getActivityFailure({ db: ctx.db, failureId: input.failureId });
      if (!row) throw new TRPCError({ code: 'NOT_FOUND' });
      // Section gate — a book failure is visible only when the viewer can see the books section.
      if (row.section && effectiveSectionLevel(ctx.user.role, row.section as SectionId) === 'disabled') {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      const acts = await resolveActivityActions(ctx.db, ctx.user.role);
      return {
        id: row.id,
        source: row.source,
        kind: row.kind,
        section: row.section,
        failureKind: row.failureKind,
        failureReason: row.failureReason,
        title: row.title,
        year: row.year,
        sourceApp: row.sourceApp,
        // The downstream operator deep link is Admin-only (the LAN-only operator UIs — R2).
        downstreamUrl: ctx.user.role.isAdmin ? row.downstreamUrl : null,
        firstSeenAt: row.firstSeenAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
        resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
        lastActionAt: row.lastActionAt ? row.lastActionAt.toISOString() : null,
        lastAction: row.lastAction,
        canRetryImport: acts.includes('retry_import'),
        canForceSearch: acts.includes('force_research'),
      };
    }),

  /** Retry the stuck import (Admin / granted role). Audited; the confined LL forceProcess fires after commit. */
  retryImport: activityActionProcedure('retry_import')
    .input(z.object({ failureId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const bundle = resolveActivityBundle(ctx);
      const { failure } = await mapDomainErrors(() =>
        recordActivityAction({ db: ctx.db, failureId: input.failureId, action: 'retry_import', actorId: ctx.user.id }),
      );
      // External write AFTER commit — best-effort; the next `activity-scan` reconciles the outcome.
      try {
        await bundle.write.forceProcess();
      } catch {
        /* the audit is the durable record; the re-scan re-detects if it's still stuck */
      }
      return { ok: true as const, failureId: failure.id };
    }),

  /** Force a fresh re-search (Admin / granted role). Audited; the confined LL searchBook fires after commit. */
  forceSearch: activityActionProcedure('force_research')
    .input(z.object({ failureId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const bundle = resolveActivityBundle(ctx);
      const { failure } = await mapDomainErrors(() =>
        recordActivityAction({ db: ctx.db, failureId: input.failureId, action: 'force_research', actorId: ctx.user.id }),
      );
      const target = parseBooksRef(failure.sourceRef);
      if (target) {
        try {
          await bundle.write.searchBook(target.bookId, target.format);
        } catch {
          /* best-effort */
        }
      }
      return { ok: true as const, failureId: failure.id };
    }),
});
