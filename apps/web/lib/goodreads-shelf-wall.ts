// ADR-057 / DESIGN-029 (PLAN-045) — pure helpers for the Goodreads sub-section: the SHELF CHIPS
// (exactly the Helpdesk ticket state-chip semantics — multi-select additive OR, an "All" superset
// select, canonical-default-writes-no-param, the deliberate-empty sentinel), the items wall's
// client-side filter/sort (the list is bounded — Goodreads RSS caps at 100 items/shelf), and the
// request PHASE presentation map (the corner puck + summary tiles). Unit-tested (the chip spec
// mirrors apps/web/e2e/helpdesk.spec.ts semantics).

/** The four canonical Goodreads shelves, in chip order (mirrors @hnet/db GOODREADS_SHELVES —
 *  duplicated as a value here so the client bundle never imports server code). */
export const GOODREADS_SHELF_ORDER = ['to-read', 'currently-reading', 'read', 'did-not-finish'] as const;

export const SHELF_LABELS: Record<string, string> = {
  'to-read': 'To read',
  'currently-reading': 'Currently reading',
  read: 'Read',
  'did-not-finish': 'Did not finish',
  // ADR-065 (PLAN-050) — the SYSTEM want's source slug: no shelf, the estate's format pairing.
  pairing: 'Format pairing',
  // DESIGN-038 D-13 — a collection's missing member (origin='collection'): no shelf, the collection.
  collection: 'Collection',
};

export function shelfLabel(shelf: string): string {
  return SHELF_LABELS[shelf] ?? shelf;
}

/** Sort shelf slugs into canonical chip order (unknown/custom slugs after, A–Z). */
export function shelfSort(shelves: readonly string[]): string[] {
  const order = (s: string): number => {
    const i = (GOODREADS_SHELF_ORDER as readonly string[]).indexOf(s);
    return i === -1 ? GOODREADS_SHELF_ORDER.length : i;
  };
  return [...shelves].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Shelf chips — the Helpdesk state-chip semantics (DESIGN-012 D-12 / DESIGN-029):
//   • multi-select toggles, additive OR — the visible set is the union of selected shelves;
//   • "All" is a SUPERSET select (never exclusive) and lights up when every chip is on;
//   • the DEFAULT selection is ALL populated shelves (a library wall shows everything);
//   • URL: canonical default ⇒ NO param; explicit subset ⇒ repeated `?shelf=` params in canonical
//     order; a deliberately EMPTY selection ⇒ the `shelf=none` sentinel;
//   • chips are populated-value-gated (A3 — an absent/empty shelf renders no chip at all).
// ---------------------------------------------------------------------------

/** The sentinel a deliberately-empty selection writes (`?shelf=none`) — the Helpdesk EMPTY_STATE_TOKEN. */
export const SHELF_EMPTY_TOKEN = 'none';

/**
 * Resolve the selected shelf set from the URL's repeated `?shelf=` params. No params ⇒ the DEFAULT
 * (all populated shelves). Unknown/unpopulated values are dropped (mangled-link safety); the `none`
 * sentinel (or params that all drop out) yields the deliberately-empty set.
 */
export function shelfSelectionFromParams(
  raw: readonly string[],
  populated: readonly string[],
): Set<string> {
  if (raw.length === 0) return new Set(populated);
  return new Set(raw.filter((v) => populated.includes(v)));
}

/**
 * Serialize a selection to the `?shelf=` param list: `null` = canonical default (write NO param),
 * `[SHELF_EMPTY_TOKEN]` = the deliberate-empty sentinel, else the selected shelves in canonical order.
 */
export function shelfParamsForSelection(
  next: ReadonlySet<string>,
  populated: readonly string[],
): string[] | null {
  const list = shelfSort(populated.filter((s) => next.has(s)));
  if (list.length === populated.length) return null; // default (all populated) — no param
  if (list.length === 0) return [SHELF_EMPTY_TOKEN];
  return list;
}

/** Toggle one shelf chip (the Helpdesk toggleState). */
export function toggleShelf(selected: ReadonlySet<string>, shelf: string): Set<string> {
  const next = new Set(selected);
  if (next.has(shelf)) next.delete(shelf);
  else next.add(shelf);
  return next;
}

// ---------------------------------------------------------------------------
// The request PHASE presentation seam (the corner puck + the stats tiles).
// ---------------------------------------------------------------------------

export type RequestPhaseName = 'have' | 'searching' | 'missing' | 'parked';

export const PHASE_META: Record<RequestPhaseName, { label: string; tone: 'success' | 'warning' | 'danger' | 'muted' }> = {
  have: { label: 'Have it', tone: 'success' },
  searching: { label: 'Searching', tone: 'warning' },
  missing: { label: 'Missing', tone: 'danger' },
  parked: { label: 'Parked', tone: 'muted' },
};

// ---------------------------------------------------------------------------
// Items wall — client-side filter/sort over the bounded list.
// ---------------------------------------------------------------------------

/** The slice of an items-wall tile the filter/sort helpers read. */
export interface ShelfWallItemLike {
  title: string;
  author: string | null;
  shelves: string[];
  shelvedAt: string | null;
  phase: RequestPhaseName;
}

export type ShelfWallSort = 'shelved' | 'title' | 'author';
export const SHELF_WALL_SORTS: ReadonlyArray<{ key: ShelfWallSort; label: string; firstDir: 'asc' | 'desc' }> = [
  { key: 'shelved', label: 'Shelved', firstDir: 'desc' },
  { key: 'title', label: 'Title', firstDir: 'asc' },
  { key: 'author', label: 'Author', firstDir: 'asc' },
];

export interface ShelfWallFilter {
  query: string;
  /** The selected shelf set (an item shows when it sits on ANY selected shelf — additive OR). */
  shelves: ReadonlySet<string>;
  /** Optional phase narrowing (the Status select chip); undefined = all phases. */
  phase?: RequestPhaseName;
}

export function filterShelfWallItems<T extends ShelfWallItemLike>(
  items: readonly T[],
  filter: ShelfWallFilter,
): T[] {
  const q = filter.query.trim().toLowerCase();
  return items.filter((item) => {
    if (!item.shelves.some((s) => filter.shelves.has(s))) return false;
    if (filter.phase !== undefined && item.phase !== filter.phase) return false;
    if (q !== '') {
      const hay = `${item.title} ${item.author ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function sortShelfWallItems<T extends ShelfWallItemLike>(
  items: readonly T[],
  sort: ShelfWallSort,
  dir: 'asc' | 'desc',
): T[] {
  const mul = dir === 'desc' ? -1 : 1;
  const sorted = [...items];
  sorted.sort((a, b) => {
    let cmp: number;
    switch (sort) {
      case 'title':
        cmp = a.title.localeCompare(b.title);
        break;
      case 'author':
        // Null authors sort LAST in either direction (the D-09 convention).
        if (a.author === null || b.author === null) {
          if (a.author === b.author) return a.title.localeCompare(b.title);
          return a.author === null ? 1 : -1;
        }
        cmp = a.author.localeCompare(b.author);
        break;
      case 'shelved':
      default:
        cmp = (a.shelvedAt ? Date.parse(a.shelvedAt) : 0) - (b.shelvedAt ? Date.parse(b.shelvedAt) : 0);
        break;
    }
    return cmp * mul || a.title.localeCompare(b.title);
  });
  return sorted;
}
