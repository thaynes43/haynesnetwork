// ADR-052 / DESIGN-026 D-06 (PLAN-029 — server-side per-user Library preferences). The session-gated
// tRPC pair that reads/writes a user's per-wall view/sort preference. A user reads and writes ONLY their
// OWN row — the userId is bound from the session (ctx.user.id), NEVER the wire; there is no admin or
// cross-user surface (ADR-052 C-04). The URL-precedence RESOLVER (resolveLibraryView) lives in
// @hnet/domain so the wall-load path (server components / the UX agent) composes the stored default with
// the URL override without a round-trip; this router just persists + reads the personal default.
import { z } from 'zod';
import {
  LIBRARY_WALLS,
  LIBRARY_VIEW_SHAPES,
  SORT_DIRECTIONS,
  type LibraryWall,
} from '@hnet/db';
import {
  defaultLibraryView,
  getLibraryPreference,
  getLibraryPreferences,
  setLibraryPreference,
  viewerHasBookProgress,
  viewerHasWatchData,
  type LibraryView,
} from '@hnet/domain';
import { authedProcedure, router } from '../trpc';

/** The wire shape a preference read returns: the effective (stored, else R2/R6 default) view + source. */
export interface WallPreference extends LibraryView {
  wall: LibraryWall;
  /** 'stored' = the user has a saved preference for this wall; 'default' = the R2/R6 fallback. */
  source: 'stored' | 'default';
}

/** The set input — the presentation choice a user is persisting (view + group-by + sort). */
const setInputSchema = z.object({
  wall: z.enum(LIBRARY_WALLS),
  view: z.enum(LIBRARY_VIEW_SHAPES),
  /** The group-by dimension key for a grouped view (null for flat/hierarchy). */
  groupBy: z.string().min(1).max(64).nullish(),
  /** The active sort field key (per-engine; the registry is authoritative on the key set). */
  sortField: z.string().min(1).max(64),
  sortDir: z.enum(SORT_DIRECTIONS),
});

export const libraryRouter = router({
  /**
   * ADR-051 C-06 / DESIGN-026 D-07 (PLAN-029 step 6) — the populated-value gates for the per-user
   * facet chips: the client offers the Watched/In-progress chips only when the viewer has ANY
   * user_media_watch rows, and the Audiobooks Read/In-progress chip only when they have ANY
   * user_book_progress rows (never a dead chip). Session-scoped — a viewer reads only their own gate.
   */
  facetGates: authedProcedure.query(async ({ ctx }): Promise<{ watch: boolean; bookProgress: boolean }> => {
    const [watch, bookProgress] = await Promise.all([
      viewerHasWatchData(ctx.db, ctx.user.id),
      viewerHasBookProgress(ctx.db, ctx.user.id),
    ]);
    return { watch, bookProgress };
  }),

  preferences: router({
    /** The caller's effective preference for ONE wall (their stored row, else the R2/R6 default). */
    get: authedProcedure
      .input(z.object({ wall: z.enum(LIBRARY_WALLS) }))
      .query(async ({ ctx, input }): Promise<WallPreference> => {
        const stored = await getLibraryPreference(ctx.db, ctx.user.id, input.wall);
        const view = stored ?? defaultLibraryView(input.wall);
        return { wall: input.wall, ...view, source: stored ? 'stored' : 'default' };
      }),

    /** ALL walls' effective preferences (defaults merged over the caller's stored rows) — tab hydration. */
    getAll: authedProcedure.query(async ({ ctx }): Promise<WallPreference[]> => {
      const stored = await getLibraryPreferences(ctx.db, ctx.user.id);
      return LIBRARY_WALLS.map((wall) => {
        const row = stored[wall];
        const view = row ?? defaultLibraryView(wall);
        return { wall, ...view, source: row ? 'stored' : 'default' } satisfies WallPreference;
      });
    }),

    /** Persist the caller's OWN preference for a wall (upsert; no audit — descriptive UI state). */
    set: authedProcedure
      .input(setInputSchema)
      .mutation(async ({ ctx, input }): Promise<WallPreference> => {
        const view = await setLibraryPreference({
          db: ctx.db,
          userId: ctx.user.id,
          wall: input.wall,
          view: input.view,
          groupBy: input.groupBy ?? null,
          sortField: input.sortField,
          sortDir: input.sortDir,
        });
        return { wall: input.wall, ...view, source: 'stored' };
      }),
  }),
});
