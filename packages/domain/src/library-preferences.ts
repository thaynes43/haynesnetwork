// ADR-052 / DESIGN-026 D-06 (PLAN-029 — server-side per-user Library preferences). The single seam
// for the per-user, per-wall `library_preferences` store: the last view shape, group-by dimension and
// last-used sort a wall reopens with (R1/R6). Read on wall load; upserted on change. Written ONLY by
// `setLibraryPreference` (the no-direct-state-writes guard forbids any other module from touching the
// table). NO audit row — descriptive UI state, not a role/permission/ledger mutation (ADR-052 C-04);
// single-writer-confined only so the guard passes. Also owns the R2/R6 DEFAULTS + the pure
// URL-precedence RESOLVER the wall-load path and the UX agent consume.
import {
  libraryPreferences,
  LIBRARY_WALLS,
  type DbClient,
  type LibraryWall,
  type LibraryViewShape,
  type SortDirection,
} from '@hnet/db';
import { and, eq } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';

/** The resolved presentation choice for a wall (the shape the resolver returns + the store persists). */
export interface LibraryView {
  view: LibraryViewShape;
  /** The grouping dimension key (grouped views only); null for flat/hierarchy. */
  groupBy: string | null;
  /** The active sort field key (per-engine; the registry [Step 2] is authoritative on the key set). */
  sortField: string;
  sortDir: SortDirection;
}

/**
 * ADR-051 D-01 / DESIGN-026 D-03 (R2 defaults + R6 default sort) — the opinionated per-wall default a
 * wall opens with the FIRST time (no stored row, bare URL). The owner ruling: Movies flat · TV
 * hierarchy · Music flat · Peloton grouped-by-Exercise · YouTube grouped-by-Channel · Books
 * grouped-by-Author · Comics grouped-by-Series · Audiobooks grouped-by-Author; recently-added default
 * sort for the video walls, A–Z within grouping for the book walls. `sortField` values are the seed
 * defaults — the per-view REGISTRY (build-phase Step 2, the UX agent's) is authoritative on the exact
 * key set and may refine these; the resolver only needs a sensible fallback.
 */
export const LIBRARY_WALL_DEFAULTS: Record<LibraryWall, LibraryView> = {
  movies: { view: 'flat', groupBy: null, sortField: 'added_at', sortDir: 'desc' },
  tv: { view: 'hierarchy', groupBy: null, sortField: 'added_at', sortDir: 'desc' },
  music: { view: 'flat', groupBy: null, sortField: 'added_at', sortDir: 'desc' },
  peloton: { view: 'grouped', groupBy: 'exercise', sortField: 'added_at', sortDir: 'desc' },
  youtube: { view: 'grouped', groupBy: 'channel', sortField: 'added_at', sortDir: 'desc' },
  books: { view: 'grouped', groupBy: 'author', sortField: 'author', sortDir: 'asc' },
  comics: { view: 'grouped', groupBy: 'series', sortField: 'title', sortDir: 'asc' },
  audiobooks: { view: 'grouped', groupBy: 'author', sortField: 'author', sortDir: 'asc' },
};

/** The R2/R6 default view for a wall (a fresh copy — callers must not mutate the shared constant). */
export function defaultLibraryView(wall: LibraryWall): LibraryView {
  return { ...LIBRARY_WALL_DEFAULTS[wall] };
}

// ---------------------------------------------------------------------------
// The URL-precedence resolver (pure — DESIGN-026 D-06/D-10)
// ---------------------------------------------------------------------------

/** An explicit URL override for a wall's presentation (any subset — a bare URL passes {}). */
export interface LibraryViewUrlOverride {
  view?: LibraryViewShape;
  groupBy?: string | null;
  sortField?: string;
  sortDir?: SortDirection;
}

export interface ResolvedLibraryView extends LibraryView {
  /**
   * True when the URL carried ANY explicit view/group/sort param, so this resolution came (in part)
   * from a SHARED LINK and MUST NOT be written back to the user's stored default (shared-link fidelity,
   * R1). A bare URL (`fromUrl: false`) resolved from the store/default and is safe to leave as-is.
   */
  fromUrl: boolean;
}

/**
 * DESIGN-026 D-06 (R1 "URL overrides for shared links") — resolve the effective view for a wall load:
 * an explicit URL param WINS per-dimension (shared-link fidelity), a bare URL is filled from the STORED
 * preference, falling back to the R2/R6 DEFAULT when no row exists. The result carries `fromUrl` so the
 * load path knows NOT to persist a shared link back over the recipient's saved default (never a
 * write-back). A user CHANGING a view/sort persists via `setLibraryPreference` + updates the URL (D-10)
 * — that is a separate, explicit action, not this read-time resolution.
 */
export function resolveLibraryView(input: {
  wall: LibraryWall;
  url?: LibraryViewUrlOverride;
  stored?: LibraryView | null;
}): ResolvedLibraryView {
  const url = input.url ?? {};
  const stored = input.stored ?? null;
  const fallback = LIBRARY_WALL_DEFAULTS[input.wall];
  const fromUrl =
    url.view !== undefined ||
    url.groupBy !== undefined ||
    url.sortField !== undefined ||
    url.sortDir !== undefined;
  return {
    view: url.view ?? stored?.view ?? fallback.view,
    // groupBy is NULLABLE (null = no grouping), so a stored null is a real value — never `??`-coalesce
    // it into the default. Precedence: explicit URL (incl. null) → the stored ROW's value (incl. null) →
    // the wall default.
    groupBy:
      url.groupBy !== undefined ? url.groupBy : stored ? stored.groupBy : fallback.groupBy,
    sortField: url.sortField ?? stored?.sortField ?? fallback.sortField,
    sortDir: url.sortDir ?? stored?.sortDir ?? fallback.sortDir,
    fromUrl,
  };
}

// ---------------------------------------------------------------------------
// The store (single-writer + reads)
// ---------------------------------------------------------------------------

/** Read one wall's stored preference for a user (null when unset — the resolver falls to the default). */
export async function getLibraryPreference(
  db: DbClient | undefined,
  userId: string,
  wall: LibraryWall,
): Promise<LibraryView | null> {
  const executor = resolveDb(db);
  const [row] = await executor
    .select({
      view: libraryPreferences.view,
      groupBy: libraryPreferences.groupBy,
      sortField: libraryPreferences.sortField,
      sortDir: libraryPreferences.sortDir,
    })
    .from(libraryPreferences)
    .where(and(eq(libraryPreferences.userId, userId), eq(libraryPreferences.wall, wall)));
  return row ? { view: row.view, groupBy: row.groupBy, sortField: row.sortField, sortDir: row.sortDir } : null;
}

/** Read ALL of a user's stored wall preferences (the client hydrates every tab once). */
export async function getLibraryPreferences(
  db: DbClient | undefined,
  userId: string,
): Promise<Partial<Record<LibraryWall, LibraryView>>> {
  const executor = resolveDb(db);
  const rows = await executor
    .select({
      wall: libraryPreferences.wall,
      view: libraryPreferences.view,
      groupBy: libraryPreferences.groupBy,
      sortField: libraryPreferences.sortField,
      sortDir: libraryPreferences.sortDir,
    })
    .from(libraryPreferences)
    .where(eq(libraryPreferences.userId, userId));
  const out: Partial<Record<LibraryWall, LibraryView>> = {};
  for (const r of rows) {
    out[r.wall] = { view: r.view, groupBy: r.groupBy, sortField: r.sortField, sortDir: r.sortDir };
  }
  return out;
}

export interface SetLibraryPreferenceInput extends LibraryView {
  db?: DbClient;
  userId: string;
  wall: LibraryWall;
}

/**
 * The SINGLE WRITER for a user's per-wall preference: upsert on (user_id, wall) — a change REPLACES the
 * row. No audit row (descriptive UI state, ADR-052 C-04); single-writer-confined so the guard passes.
 * A user reads/writes ONLY their own row (the tRPC layer binds userId to the session; there is no
 * admin/cross-user surface). Runs in a transaction for guard-uniformity, though it writes one row.
 */
export async function setLibraryPreference(
  input: SetLibraryPreferenceInput,
): Promise<LibraryView> {
  return inTransaction(input.db, async (tx) => {
    const now = new Date();
    await tx
      .insert(libraryPreferences)
      .values({
        userId: input.userId,
        wall: input.wall,
        view: input.view,
        groupBy: input.groupBy,
        sortField: input.sortField,
        sortDir: input.sortDir,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [libraryPreferences.userId, libraryPreferences.wall],
        set: {
          view: input.view,
          groupBy: input.groupBy,
          sortField: input.sortField,
          sortDir: input.sortDir,
          updatedAt: now,
        },
      });
    return { view: input.view, groupBy: input.groupBy, sortField: input.sortField, sortDir: input.sortDir };
  });
}

/** The valid Library walls (re-exported for the tRPC input enum). */
export { LIBRARY_WALLS };
