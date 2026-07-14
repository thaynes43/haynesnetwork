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
  parseArrActivityRef,
  recordActivityAction,
  type ActivitySection,
  type ActivitySourceAdapter,
} from '@hnet/domain';
import type { ActivityImportFailureRow, SectionId } from '@hnet/db';
import {
  router,
  mapDomainErrors,
  resolveActivityBundle,
  resolveArrActivityAdapter,
  resolveArrBundle,
  type TRPCContext,
} from '../trpc';
import { authedProcedure } from '../trpc';
import { activityActionProcedure, effectiveSectionLevel, resolveActivityActions } from '../middleware/role';

type AuthedCtx = TRPCContext & { user: NonNullable<TRPCContext['user']> };

/**
 * The source adapters this viewer's Activity read merges. The *arr adapter is UNIVERSAL (its items are
 * `section: null` — the movies/tv/music walls are ungated, DESIGN-030 D-08), so it is ALWAYS included; the
 * books adapter is section-gated, so it is only built/read when the viewer can see the books section (a
 * member never triggers the LL/SAB upstreams for items the aggregator would gate out). Adding the next
 * source family (Kapowarr) is one more `push` here — the contract-shaped fan-out (D-08).
 */
function buildActivityAdapters(ctx: AuthedCtx, visibleSections: ActivitySection[]): ActivitySourceAdapter[] {
  const adapters: ActivitySourceAdapter[] = [resolveArrActivityAdapter(ctx)];
  if (visibleSections.includes('books')) adapters.push(resolveActivityBundle(ctx).adapter);
  return adapters;
}

/**
 * Fire the confined external write for an audited Activity action AFTER the ledger stamp commits (the
 * fix-flow discipline — external calls stay out of the transaction). Per-kind dispatch off the failure's
 * `sourceRef`: an *arr strand retries via `processMonitoredDownloads` / re-searches via the existing
 * per-kind Force-Search command (PLAN-015 machinery); a books strand fires the confined LL
 * `forceProcess` / `searchBook`. Best-effort — the audit is the durable record; the next `activity-scan`
 * re-detects anything still stuck.
 */
async function fireActivityWrite(
  ctx: AuthedCtx,
  failure: ActivityImportFailureRow,
  action: 'retry_import' | 'force_research',
): Promise<void> {
  const arrRef = parseArrActivityRef(failure.sourceRef);
  try {
    if (arrRef) {
      const write = resolveArrBundle(ctx).write;
      if (action === 'retry_import') {
        await write[arrRef.arrKind].processMonitoredDownloads();
      } else if (arrRef.arrKind === 'radarr') {
        await write.radarr.searchMovies([arrRef.parentId]);
      } else if (arrRef.arrKind === 'sonarr') {
        if (arrRef.targetId != null) await write.sonarr.searchEpisodes([arrRef.targetId]);
        else await write.sonarr.searchSeries(arrRef.parentId);
      } else {
        if (arrRef.targetId != null) await write.lidarr.searchAlbums([arrRef.targetId]);
        else await write.lidarr.searchArtist(arrRef.parentId);
      }
      return;
    }
    const write = resolveActivityBundle(ctx).write;
    if (action === 'retry_import') {
      await write.forceProcess();
    } else {
      const booksRef = parseBooksRef(failure.sourceRef);
      if (booksRef) await write.searchBook(booksRef.bookId, booksRef.format);
    }
  } catch {
    /* best-effort — the audit is the durable record; the re-scan re-detects if it's still stuck */
  }
}

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
  /** The cross-library Activity list + chip counts (live, section-gated). The universal *arr adapter is
   *  always merged; the section-gated books adapter joins only when the viewer can see books. */
  list: authedProcedure.query(async ({ ctx }) => {
    const visibleSections = visibleSectionsFor(ctx);
    const adapters = buildActivityAdapters(ctx, visibleSections);
    const result = await aggregateActivity({ db: ctx.db, adapters, visibleSections });
    return { items: result.items, counts: result.counts };
  }),

  /** The per-wall in-flight badge map the wall posters read (books: keyed by LL/GB bookId; *arr: keyed by
   *  the movie/series/artist id the movies/tv/music posters carry). */
  wallStages: authedProcedure.query(async ({ ctx }) => {
    const visibleSections = visibleSectionsFor(ctx);
    const adapters = buildActivityAdapters(ctx, visibleSections);
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

  /** Retry the stuck import (Admin / granted role). Audited; the confined retry write (the *arr
   *  `ProcessMonitoredDownloads` or the books LL `forceProcess`) fires after commit, per source. */
  retryImport: activityActionProcedure('retry_import')
    .input(z.object({ failureId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { failure } = await mapDomainErrors(() =>
        recordActivityAction({ db: ctx.db, failureId: input.failureId, action: 'retry_import', actorId: ctx.user.id }),
      );
      await fireActivityWrite(ctx, failure, 'retry_import');
      return { ok: true as const, failureId: failure.id };
    }),

  /** Force a fresh re-search (Admin / granted role). Audited; the confined per-kind Force-Search write
   *  (the *arr search command or the books LL `searchBook`) fires after commit, per source. */
  forceSearch: activityActionProcedure('force_research')
    .input(z.object({ failureId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { failure } = await mapDomainErrors(() =>
        recordActivityAction({ db: ctx.db, failureId: input.failureId, action: 'force_research', actorId: ctx.user.id }),
      );
      await fireActivityWrite(ctx, failure, 'force_research');
      return { ok: true as const, failureId: failure.id };
    }),
});
