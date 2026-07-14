// ADR-052 / DESIGN-026 D-01/D-06/D-10 (PLAN-029) — the client-side Library VIEW model: the R2/R6
// per-wall defaults and the URL-precedence resolver. A framework-free MIRROR of @hnet/domain's
// `LIBRARY_WALL_DEFAULTS` / `resolveLibraryView` (the lib/media.ts rule: app lib code never imports
// @hnet/domain — it would drag drizzle/pg into the client bundle); parity is enforced by
// lib/__tests__/library-views.test.ts, which compares this mirror against the domain resolver
// case-by-case in the node test context.
//
// The handoff contract (PR #243) this mirror honors exactly:
//   • URL wins PER-DIMENSION; a bare URL fills from the stored preference, else the R2/R6 default.
//   • `fromUrl: true` = the resolution came (in part) from a SHARED LINK — never persisted. (The
//     client never persists on render anyway: `library.preferences.set` fires only inside explicit
//     user-selection handlers, D-06.)
//   • A stored `groupBy: null` is a REAL value — never coalesced into the wall default.
import type { LibraryWall, LibraryViewShape, SortDirection } from '@hnet/db';

/** The Library walls (mirrors @hnet/db LIBRARY_WALLS — the satisfies pins parity at compile time). */
export const LIBRARY_WALL_IDS = [
  'movies',
  'tv',
  'music',
  'peloton',
  'youtube',
  'books',
  'audiobooks',
  'comics',
] as const satisfies readonly LibraryWall[];
export type LibraryWallId = (typeof LIBRARY_WALL_IDS)[number];

export type WallViewShape = LibraryViewShape; // 'flat' | 'grouped' | 'hierarchy'
export type WallSortDir = SortDirection; // 'asc' | 'desc'

/** A wall's resolved presentation (mirrors @hnet/domain LibraryView). */
export interface WallView {
  view: WallViewShape;
  /** The grouping DIMENSION key (grouped views only); null for flat/hierarchy. */
  groupBy: string | null;
  sortField: string;
  sortDir: WallSortDir;
}

/**
 * The R2/R6 per-wall defaults (owner ruling — mirrors @hnet/domain LIBRARY_WALL_DEFAULTS verbatim;
 * parity-tested): Movies flat · TV hierarchy · Music flat · Peloton by Exercise · YouTube by Channel ·
 * Books/Audiobooks by Author · Comics by Series; recently-added sort on the video walls, A–Z within
 * grouping on the book walls.
 */
export const WALL_VIEW_DEFAULTS: Record<LibraryWallId, WallView> = {
  movies: { view: 'flat', groupBy: null, sortField: 'added_at', sortDir: 'desc' },
  tv: { view: 'hierarchy', groupBy: null, sortField: 'added_at', sortDir: 'desc' },
  music: { view: 'flat', groupBy: null, sortField: 'added_at', sortDir: 'desc' },
  peloton: { view: 'grouped', groupBy: 'exercise', sortField: 'added_at', sortDir: 'desc' },
  youtube: { view: 'grouped', groupBy: 'channel', sortField: 'added_at', sortDir: 'desc' },
  books: { view: 'grouped', groupBy: 'author', sortField: 'author', sortDir: 'asc' },
  comics: { view: 'grouped', groupBy: 'series', sortField: 'title', sortDir: 'asc' },
  audiobooks: { view: 'grouped', groupBy: 'author', sortField: 'author', sortDir: 'asc' },
};

/** An explicit URL override (any subset — a bare URL passes {}). */
export interface WallViewUrlOverride {
  view?: WallViewShape;
  groupBy?: string | null;
  sortField?: string;
  sortDir?: WallSortDir;
}

export interface ResolvedWallView extends WallView {
  /** True when ANY dimension came from the URL (shared-link state — never written back). */
  fromUrl: boolean;
}

/** Mirror of @hnet/domain `resolveLibraryView` (URL wins per-dimension → stored → R2/R6 default). */
export function resolveWallView(input: {
  wall: LibraryWallId;
  url?: WallViewUrlOverride;
  stored?: WallView | null;
}): ResolvedWallView {
  const url = input.url ?? {};
  const stored = input.stored ?? null;
  const fallback = WALL_VIEW_DEFAULTS[input.wall];
  const fromUrl =
    url.view !== undefined ||
    url.groupBy !== undefined ||
    url.sortField !== undefined ||
    url.sortDir !== undefined;
  return {
    view: url.view ?? stored?.view ?? fallback.view,
    // groupBy is NULLABLE (null = no grouping) — a stored null is a real value, never coalesced.
    groupBy: url.groupBy !== undefined ? url.groupBy : stored ? stored.groupBy : fallback.groupBy,
    sortField: url.sortField ?? stored?.sortField ?? fallback.sortField,
    sortDir: url.sortDir ?? stored?.sortDir ?? fallback.sortDir,
    fromUrl,
  };
}

/** Parse a `?sort=field:dir` token against a valid-key list (invalid ⇒ null — treated as absent,
 *  so a mangled shared link falls back to the stored/default sort instead of erroring). */
export function parseWallSortToken(
  raw: string | null,
  validFields: readonly string[],
): { field: string; dir: WallSortDir } | null {
  if (raw === null) return null;
  const [field, dir] = raw.split(':');
  if (field !== undefined && validFields.includes(field) && (dir === 'asc' || dir === 'desc')) {
    return { field, dir };
  }
  return null;
}

/** Parse a `?view=` param against the shapes the wall actually offers (invalid ⇒ undefined). */
export function parseWallViewParam(
  raw: string | null,
  offered: readonly WallViewShape[],
): WallViewShape | undefined {
  return raw !== null && (offered as readonly string[]).includes(raw)
    ? (raw as WallViewShape)
    : undefined;
}

/**
 * DESIGN-026 D-09 — the A–Z jump-bar visibility rule (a D-11 tunable): the bar appears only when the
 * active sort is an A–Z sort (registry `azSorts`, asc) on a BIG wall — first page full / more pages —
 * or when a jump is already active (so the rail never vanishes mid-use).
 */
export const JUMP_BAR_MIN_ITEMS = 48;
export function showJumpBar(input: {
  isAzSort: boolean;
  activeLetter: string | null;
  itemCount: number;
  hasNextPage: boolean;
}): boolean {
  if (!input.isAzSort) return false;
  if (input.activeLetter !== null) return true;
  return input.hasNextPage || input.itemCount >= JUMP_BAR_MIN_ITEMS;
}
