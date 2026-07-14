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
  activityFamilyOf,
  activityWallStages,
  getActivityFailure,
  lazyActivityAdapter,
  parseArrActivityRef,
  parseKapowarrActivityRef,
  recordActivityAction,
  ARR_ACTIVITY_SOURCE,
  BOOKS_ACTIVITY_SOURCE,
  KAPOWARR_ACTIVITY_SOURCE,
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
  resolveKapowarrActivityAdapter,
  resolveKapowarrBundle,
  type TRPCContext,
} from '../trpc';
import { authedProcedure } from '../trpc';
import { activityActionProcedure, effectiveSectionLevel, resolveActivityActions } from '../middleware/role';

type AuthedCtx = TRPCContext & { user: NonNullable<TRPCContext['user']> };

/**
 * The source adapters this viewer's Activity read merges. The *arr adapter is UNIVERSAL (its items are
 * `section: null` — the movies/tv/music walls are ungated, DESIGN-030 D-08), so it is ALWAYS included; the
 * books AND Kapowarr (comics) adapters are section-gated on `books` — comics ride the books section (D-01),
 * so both are only built/read when the viewer can see the books section (a member never triggers the LL/SAB
 * or Kapowarr upstreams for items the aggregator would gate out). The contract-shaped fan-out (D-08).
 *
 * PER-SOURCE FAILURE ISOLATION: each source is wrapped in a `lazyActivityAdapter`, so the `resolveXxx`
 * CONSTRUCTION (which asserts env — a missing `SABNZBD_API_KEY` throws) is DEFERRED into `list()`, inside
 * the aggregator's per-source try/catch. A missing env / down upstream / timeout now degrades ONLY that
 * source (an `unavailable` marker) instead of blanking the whole read (the prod incident). The label is the
 * human family name the notice shows.
 */
function buildActivityAdapters(ctx: AuthedCtx, visibleSections: ActivitySection[]): ActivitySourceAdapter[] {
  const adapters: ActivitySourceAdapter[] = [
    lazyActivityAdapter({
      source: ARR_ACTIVITY_SOURCE,
      label: 'Movies, TV & music',
      resolve: () => resolveArrActivityAdapter(ctx),
    }),
  ];
  if (visibleSections.includes('books')) {
    adapters.push(
      lazyActivityAdapter({
        source: BOOKS_ACTIVITY_SOURCE,
        label: 'Books & audiobooks',
        resolve: () => resolveActivityBundle(ctx).adapter,
      }),
      lazyActivityAdapter({
        source: KAPOWARR_ACTIVITY_SOURCE,
        label: 'Comics',
        resolve: () => resolveKapowarrActivityAdapter(ctx),
      }),
    );
  }
  return adapters;
}

/**
 * Fire the confined external write for an audited Activity action AFTER the ledger stamp commits (the
 * fix-flow discipline — external calls stay out of the transaction). Per-kind dispatch off the failure's
 * `sourceRef`: an *arr strand retries via `processMonitoredDownloads` / re-searches via the existing
 * per-kind Force-Search command (PLAN-015 machinery); a Kapowarr (comic) strand re-searches via the confined
 * PLAN-046 `searchVolume` (auto_search) write — comics have NO retry-import surface (Kapowarr auto-imports),
 * so a comic retry_import is a no-op; a books strand fires the confined LL `forceProcess` / `searchBook`.
 * Best-effort — the audit is the durable record; the next `activity-scan` re-detects anything still stuck.
 */
async function fireActivityWrite(
  ctx: AuthedCtx,
  failure: ActivityImportFailureRow,
  action: 'retry_import' | 'force_research',
): Promise<void> {
  const arrRef = parseArrActivityRef(failure.sourceRef);
  const kapoRef = parseKapowarrActivityRef(failure.sourceRef);
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
    if (kapoRef) {
      // Comics: only a fresh force-search is possible (Kapowarr's auto_search — the same confined write the
      // PLAN-046 Library "Force Search" fires). retry_import has no Kapowarr surface, so it is a no-op here.
      if (action === 'force_research') {
        await resolveKapowarrBundle(ctx).write.searchVolume(kapoRef.volumeId);
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
    // `unavailable` carries the per-source degrade markers so the tab can show a non-blocking notice while
    // the reachable sources render normally (per-source failure isolation — one down never blanks the read).
    return { items: result.items, counts: result.counts, unavailable: result.unavailable };
  }),

  /** The per-wall in-flight badge map the wall posters read (books: keyed by LL/GB bookId; *arr: keyed by
   *  the movie/series/artist id the movies/tv/music posters carry). No hrefs (this never renders a card). */
  wallStages: authedProcedure.query(async ({ ctx }) => {
    const visibleSections = visibleSectionsFor(ctx);
    const adapters = buildActivityAdapters(ctx, visibleSections);
    const result = await aggregateActivity({ db: ctx.db, adapters, visibleSections, resolveHrefs: false });
    return activityWallStages(result.items);
  }),

  /**
   * DESIGN-030 D-10 — the LIVE stage of ONE in-flight item (the Fix-feedback idiom for Activity): the failure
   * detail + the Wanted detail poll this after firing a retry/re-search so the item is seen to MOVE (fired →
   * searching → downloading % → importing → done) exactly like the Fix dialog. Surgical — it builds ONLY the
   * one source family the id names (derived from the ref prefix), never the whole fan-out, and skips the href
   * joins. `present: false` means the item is no longer in any in-flight/failed/completed stage (it cleared).
   * Section-gated: a books/comics item is invisible (present:false) to a viewer without the books section.
   */
  itemStatus: authedProcedure
    .input(z.object({ itemId: z.string().min(1).max(200) }))
    .query(async ({ ctx, input }) => {
      const notPresent = { present: false as const, stage: null, progress: null };
      const family = activityFamilyOf(input.itemId);
      if (family === null) return notPresent;
      const visibleSections = visibleSectionsFor(ctx);
      // Books + comics ride the books gate; the *arr family is universal.
      if ((family === 'books' || family === 'kapowarr') && !visibleSections.includes('books')) {
        return notPresent;
      }
      const adapter =
        family === 'arr'
          ? lazyActivityAdapter({
              source: ARR_ACTIVITY_SOURCE,
              label: 'Movies, TV & music',
              resolve: () => resolveArrActivityAdapter(ctx),
            })
          : family === 'books'
            ? lazyActivityAdapter({
                source: BOOKS_ACTIVITY_SOURCE,
                label: 'Books & audiobooks',
                resolve: () => resolveActivityBundle(ctx).adapter,
              })
            : lazyActivityAdapter({
                source: KAPOWARR_ACTIVITY_SOURCE,
                label: 'Comics',
                resolve: () => resolveKapowarrActivityAdapter(ctx),
              });
      const result = await aggregateActivity({
        db: ctx.db,
        adapters: [adapter],
        visibleSections,
        resolveHrefs: false,
      });
      const found = result.items.find((it) => it.id === input.itemId);
      return found ? { present: true as const, stage: found.stage, progress: found.progress } : notPresent;
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
        // The stable adapter ref (== the ActivityItem id) — the client polls `activity.itemStatus` with it to
        // watch the item MOVE off the failed stage after a retry/re-search fires (the Fix-feedback idiom).
        sourceRef: row.sourceRef,
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
