// ADR-021 / ADR-022 / DESIGN-009 — the Ledger section's admin surface. A spreadsheet browse
// over the WHOLE ledger (tombstoned INCLUDED), the bulk Add-&-search that generalizes Restore,
// and the run report. Access is section-gated (Ledger: read_only browses/reports; edit bulk-adds
// — Disabled never reaches here). The export is a separate Next route handler (JSONL stream);
// everything here is tRPC. Reads are unguarded; the one write goes through @hnet/domain.
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import {
  ARR_KINDS,
  mediaItems,
  mediaMetadata,
  restoreRuns,
  users,
  type RestoreResultItem,
} from '@hnet/db';
import { executeArrAdd } from '@hnet/domain';
import { mapDomainErrors, resolveArrBundle, router } from '../trpc';
import { sectionProcedure } from '../middleware/role';
import {
  LEDGER_FILTER_SHAPE,
  METADATA_SELECT,
  SORT_SPECS,
  buildLibraryWhere,
  librarySortShape,
  metadataBlock,
  posterUrlFor,
} from '../ledger-query';
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  keysetAfter,
  keysetOrderBy,
  type KeysetValue,
} from '../keyset';

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d === null ? null : d.toISOString());

/**
 * DESIGN-009 D-05 — roll a run's per-item results up into the outcome counts the /ledger Runs
 * tab shows on every collapsed row. SAME classification contract as the web report
 * (`apps/web/lib/ledger.ts` classifyRunItem): success keys off `ok` (`outcome:'monitored'` =
 * the monitor-flip, anything else ok = added); skips are persisted as ok:false with a
 * `'skipped:'`-prefixed error (executeArrAdd's skip record); every other ok:false is a real
 * failure. Error TEXT on an ok row is only a best-effort-search caution — NEVER a failure.
 * Computed server-side so the run LIST never ships the full results payload (a capped run
 * carries up to 1000 jsonb entries).
 */
function summarizeArrAddResults(results: RestoreResultItem[]): {
  added: number;
  monitored: number;
  skipped: number;
  failed: number;
} {
  const summary = { added: 0, monitored: 0, skipped: 0, failed: 0 };
  for (const entry of results) {
    if (entry.ok) summary[entry.outcome === 'monitored' ? 'monitored' : 'added'] += 1;
    else if (typeof entry.error === 'string' && entry.error.startsWith('skipped:')) {
      summary.skipped += 1;
    } else summary.failed += 1;
  }
  return summary;
}

export const ledgerAdminRouter = router({
  /**
   * DESIGN-009 D-04 — the spreadsheet browse. The EXACT same WHERE/keyset assembly as
   * ledger.search (shared buildLibraryWhere + SORT_SPECS + keyset), but tombstoned rows are
   * ALWAYS included and the Ledger-only dims (monitored, hasFile) are exposed. Returns the full
   * spreadsheet column set. Read-Only and above (Disabled never reaches here).
   */
  browse: sectionProcedure('ledger', 'read_only')
    .input(
      z.object({
        ...LEDGER_FILTER_SHAPE,
        ...librarySortShape,
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(100),
      }),
    )
    .query(async ({ ctx, input }) => {
      // includeTombstoned is FORCED true — the Ledger is "everything that ever was on the server".
      const where: SQL[] = buildLibraryWhere({ ...input, includeTombstoned: true });
      const spec = SORT_SPECS[input.sort.field];
      const idCol = sql`${mediaItems.id}`;
      if (input.cursor !== undefined) {
        const { sortValue, id } = decodeKeysetCursor(input.cursor);
        where.push(
          keysetAfter({
            expr: spec.col,
            idCol,
            kind: spec.kind,
            dir: input.sort.dir,
            value: sortValue,
            id,
          }),
        );
      }

      const rows = await ctx.db
        .select({
          id: mediaItems.id,
          arrKind: mediaItems.arrKind,
          title: mediaItems.title,
          year: mediaItems.year,
          monitored: mediaItems.monitored,
          onDiskFileCount: mediaItems.onDiskFileCount,
          expectedFileCount: mediaItems.expectedFileCount,
          sizeOnDisk: mediaItems.sizeOnDisk,
          qualityProfileName: mediaItems.qualityProfileName,
          rootFolder: mediaItems.rootFolder,
          arrTags: mediaItems.arrTags,
          tvdbId: mediaItems.tvdbId,
          tmdbId: mediaItems.tmdbId,
          imdbId: mediaItems.imdbId,
          musicbrainzArtistId: mediaItems.musicbrainzArtistId,
          deletedFromArrAt: mediaItems.deletedFromArrAt,
          firstSeenAt: mediaItems.firstSeenAt,
          lastSeenAt: mediaItems.lastSeenAt,
          sortValue: spec.col,
          ...METADATA_SELECT,
        })
        .from(mediaItems)
        .leftJoin(mediaMetadata, eq(mediaMetadata.mediaItemId, mediaItems.id))
        .where(and(...where))
        .orderBy(keysetOrderBy(spec.col, input.sort.dir, idCol))
        .limit(input.limit + 1);

      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      const cursorValueOf = (row: (typeof page)[number]): KeysetValue => {
        const raw = row.sortValue as string | number | Date | null;
        if (raw === null) return null;
        if (spec.kind === 'date') return raw instanceof Date ? raw.toISOString() : String(raw);
        if (spec.kind === 'number') return Number(raw);
        return String(raw);
      };
      return {
        items: page.map((row) => ({
          id: row.id,
          arrKind: row.arrKind,
          title: row.title,
          year: row.year,
          monitored: row.monitored,
          onDiskFileCount: row.onDiskFileCount,
          expectedFileCount: row.expectedFileCount,
          sizeOnDisk: row.sizeOnDisk,
          qualityProfileName: row.qualityProfileName,
          rootFolder: row.rootFolder,
          arrTags: row.arrTags,
          tvdbId: row.tvdbId,
          tmdbId: row.tmdbId,
          imdbId: row.imdbId,
          musicbrainzArtistId: row.musicbrainzArtistId,
          tombstonedAt: isoOrNull(row.deletedFromArrAt),
          addedAt: iso(row.firstSeenAt),
          lastSyncedAt: iso(row.lastSeenAt),
          posterUrl: posterUrlFor(row.id, row.posterSource),
          metadata: metadataBlock(row),
        })),
        nextCursor:
          rows.length > input.limit && last !== undefined
            ? encodeKeysetCursor(cursorValueOf(last), last.id)
            : null,
      };
    }),

  /**
   * DESIGN-009 D-06 (nit fix 2026-07-07) — the TRUE filtered row count for the Export button
   * label. browse is keyset-paged (no cheap total), so the label used to read the loaded-so-far
   * count ("100+ rows"); this is a single COUNT(*) over the EXACT same WHERE browse/export
   * assemble (shared buildLibraryWhere, includeTombstoned FORCED true, same media_metadata join
   * for the facet filters), so the label can never drift from the streamed export set. Read-Only
   * and above — the export button shows for read_only too (Disabled never reaches here).
   */
  count: sectionProcedure('ledger', 'read_only')
    .input(z.object({ ...LEDGER_FILTER_SHAPE }))
    .query(async ({ ctx, input }) => {
      const where: SQL[] = buildLibraryWhere({ ...input, includeTombstoned: true });
      const [row] = await ctx.db
        .select({ total: sql<number>`count(*)::int` })
        .from(mediaItems)
        .leftJoin(mediaMetadata, eq(mediaMetadata.mediaItemId, mediaItems.id))
        .where(and(...where));
      return { count: row?.total ?? 0 };
    }),

  /**
   * ADR-022 D-02 / DESIGN-009 D-05 — bulk Add-&-search over an explicit selection. Edit-gated.
   * Delegates to executeArrAdd(reason:'ledger_add'): absent → add monitored + search; present
   * but unmonitored → monitor + search; present + monitored → skip. Capped at 1000 items/run
   * when searching (ARR_ADD_SEARCH_CAP → ARR_ADD_SEARCH_CAP_EXCEEDED). Returns {runId,status};
   * the per-item report is read via `run`.
   */
  bulkAddAndSearch: sectionProcedure('ledger', 'edit')
    .input(
      z.object({
        arrKind: z.enum(ARR_KINDS),
        arrInstanceId: z.string().default('main'),
        mediaItemIds: z.array(z.uuid()).min(1).max(1000),
        searchOnAdd: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const result = await executeArrAdd({
          db: ctx.db,
          arr: resolveArrBundle(ctx),
          arrKind: input.arrKind,
          arrInstanceId: input.arrInstanceId,
          initiatedBy: ctx.user.id,
          mediaItemIds: input.mediaItemIds,
          reason: 'ledger_add',
          searchOnAdd: input.searchOnAdd,
        });
        return { runId: result.runId, status: result.status };
      });
    }),

  /** The per-item report (AC-11) — the restore_runs row, scoped to reason 'ledger_add'. */
  run: sectionProcedure('ledger', 'read_only')
    .input(z.object({ id: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .select({
          id: restoreRuns.id,
          arrKind: restoreRuns.arrKind,
          arrInstanceId: restoreRuns.arrInstanceId,
          reason: restoreRuns.reason,
          status: restoreRuns.status,
          preview: restoreRuns.preview,
          results: restoreRuns.results,
          itemCount: restoreRuns.itemCount,
          successCount: restoreRuns.successCount,
          startedAt: restoreRuns.startedAt,
          finishedAt: restoreRuns.finishedAt,
          initiatedByDisplayName: users.displayName,
        })
        .from(restoreRuns)
        .leftJoin(users, eq(users.id, restoreRuns.initiatedBy))
        .where(and(eq(restoreRuns.id, input.id), eq(restoreRuns.reason, 'ledger_add')));
      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `Ledger add run ${input.id} not found` });
      }
      return { ...row, startedAt: iso(row.startedAt), finishedAt: isoOrNull(row.finishedAt) };
    }),

  /**
   * Ledger Add-&-search runs, newest first (reason 'ledger_add' only) — the /ledger **Runs**
   * tab's list (owner UX 2026-07-07: run history is a destination, not a scroll-past card).
   * Optional `arrKind` narrows to one *arr server-side so the media-type filter and the
   * newest-first window always agree (a client-side trim of a fixed page could hide older
   * runs of the filtered kind). Same read gate as `run` — Read-Only browses run history.
   * Each row carries the server-computed outcome summary (added/monitored/skipped/failed)
   * instead of the raw per-item results payload; the expanded report reads `run({id})`.
   */
  runs: sectionProcedure('ledger', 'read_only')
    .input(z.object({ arrKind: z.enum(ARR_KINDS).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const where: SQL[] = [eq(restoreRuns.reason, 'ledger_add')];
      if (input?.arrKind !== undefined) where.push(eq(restoreRuns.arrKind, input.arrKind));
      const rows = await ctx.db
        .select({
          id: restoreRuns.id,
          arrKind: restoreRuns.arrKind,
          arrInstanceId: restoreRuns.arrInstanceId,
          reason: restoreRuns.reason,
          status: restoreRuns.status,
          itemCount: restoreRuns.itemCount,
          successCount: restoreRuns.successCount,
          startedAt: restoreRuns.startedAt,
          finishedAt: restoreRuns.finishedAt,
          initiatedByDisplayName: users.displayName,
          results: restoreRuns.results,
        })
        .from(restoreRuns)
        .leftJoin(users, eq(users.id, restoreRuns.initiatedBy))
        .where(and(...where))
        // id is a pure tiebreak — keeps the order deterministic if two runs share a timestamp.
        .orderBy(desc(restoreRuns.startedAt), desc(restoreRuns.id))
        // "There won't be many runs" (owner) — 100 newest is effectively "all", bounded.
        .limit(100);
      return rows.map(({ results, ...row }) => ({
        ...row,
        startedAt: iso(row.startedAt),
        finishedAt: isoOrNull(row.finishedAt),
        summary: summarizeArrAddResults(results),
      }));
    }),
});
