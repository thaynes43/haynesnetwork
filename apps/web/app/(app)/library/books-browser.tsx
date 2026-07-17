'use client';

// ADR-046 / DESIGN-024 (PLAN-023) + ADR-051/052 / DESIGN-026 (PLAN-029) — a Books Library sub-tab
// (Books / Audiobooks / Comics). Reuses the Library idioms wholesale: the `.media-list.poster-grid`
// of `.poster-card` tiles, `MediaPoster` (null / load-error → KindIcon fallback), the
// `.library-toolbar`/`.library-search`/`.library-chipbar`/`.library-sortbar` chrome, and the
// `.sort-btn` idiom. The data is the app-owned `books_items` ledger read via `books.search` /
// `books.groups` / `books.filterFacets`.
//
// PLAN-029 makes the wall's PRESENTATION a real choice (DESIGN-026 D-01/D-04):
//   • Books/Audiobooks default to the GROUPED-BY-AUTHOR view (R2) — aggregate author cards with an
//     item count — with a flat "All …" alternative on the view selector. Audiobooks additionally
//     offers the GENRE grouping (the group-card-art pass — the first abstract dimension, `?by=`).
//     Tapping a card DRILLS into the flat grid pre-filtered to that group (`?group=` — a PUSH per
//     D-19; Back restores the grouped wall).
//   • Group-card ART (D-04, art-amended): author cards wear the author's REAL portrait where ABS
//     holds one (books.groups attaches /api/books/author-image URLs, populated-value-gated), the
//     stacked-cover fan elsewhere; genre cards wear the designed token-themed GLYPH tile (never
//     fake art). All inside the same reserved 2:3 box (ADR-015) — see the GroupCard family member.
//   • Comics' R2 grouping (Series) IS the wall — a Kavita row IS a series, so the item grid is the
//     series grid (one honest shape, no selector) wearing REAL Kavita series covers.
//   • Sorts + facet chips are REGISTRY-declared per (wall, view level) — a grouped level sorts its
//     CARDS (label / count); the flat level offers exactly its answerable dimensions (R5).
//   • The effective view/sort resolves per ADR-052 (URL wins → stored preference → R2/R6 default);
//     explicit selections persist via library.preferences.set (event handlers only, never render).
//     A bare URL on a multi-shape wall is CANONICALIZED to the resolved `?view=` (+ a non-default
//     `?by=`) with a replace (D-10) so Back always restores the exact shape it left.
//
// URL contract (extends the D-11 idiom; every refinement is a router.replace):
//   ?view=grouped|flat   the wall shape (multi-shape walls; canonicalized in)   [PUSH on switch]
//   ?by=<dimension>      the grouped dimension (omitted = the wall's default)   [PUSH on switch]
//   ?group=<key>         the drilled-into group (implies the flat grid)         [PUSH on drill]
//   ?sort=field:dir      the active level's sort                                [replace]
//   ?q / ?genre / ?author / ?narr / ?ser / ?lang / ?fmt / ?len / ?read / ?at    [replace]
//   ?wanted=only|hide    the three-state composed-Wanted filter (absent = All)  [replace]
//
// ADR-015: fixed 2:3 boxes (item tiles AND group-card stacks), dim-in-place on refetch, fixed-height
// chip/sort rows that pan horizontally, overlay chip editors, the A–Z rail as a fixed overlay,
// skeleton tiles on first load. Pagination is the shared sentinel scroll idiom.
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FilterChip,
  addFilterValue,
  removeFilterValue,
  filterValues,
  nextSort,
  arrowFor,
  type FilterMap,
} from '@hnet/ui';
import type { BooksSort, BooksWantedState, BookReadState } from '@hnet/api';
import { trpc } from '@/lib/trpc-client';
import { BookCard, GroupCard, PosterGrid, PosterGridSkeleton, type InFlightBadge } from '@/components/cards';
import { CHIP_LABELS, SelectChip } from '@/components/filter-chips';
import { LetterJumpBar } from '@/components/letter-jump-bar';
import {
  WALL_VIEW_DEFAULTS,
  parseWallSortToken,
  parseWallViewParam,
  resolveWallView,
  showJumpBar,
  type LibraryWallId,
  type WallSortDir,
  type WallView,
} from '@/lib/library-views';
import {
  LENGTH_BUCKET_OPTIONS,
  READ_STATE_OPTIONS,
  WALL_VIEWS,
  registryFor,
  type ViewLevelKey,
  type ViewRegistryEntry,
  type WallGrouping,
} from '@/lib/library-view-registry';
import { WantedCard } from './wanted-card';
import { SuggestCollectionAffordance } from './suggest-collection';
import type { FacetGates } from './library-client';

type BooksMediaKind = 'book' | 'audiobook' | 'comic';
type BooksWall = Extract<LibraryWallId, 'books' | 'audiobooks' | 'comics'>;

/** The books walls' enum/suggest facet fields (FilterMap keys — each maps to a URL param + the
 *  same-named books.search input; see the registry declarations). */
type BooksField = 'genres' | 'authors' | 'narrators' | 'series' | 'languages' | 'formats' | 'lengths';

function formatDuration(seconds: number | null): string | null {
  if (seconds == null || seconds <= 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const SKELETON = <PosterGridSkeleton testId="books-skeleton" />;

export function BooksBrowser({
  wall,
  mediaKind,
  label,
  stored,
  gates,
}: {
  wall: LibraryWallId;
  mediaKind: BooksMediaKind;
  label: string;
  /** The caller's stored wall preference (null = none; undefined = still loading). */
  stored: WallView | null | undefined;
  gates: FacetGates;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const booksWall = wall as BooksWall;
  const spec = WALL_VIEWS[booksWall];
  const groupings = spec.groupings ?? [];
  const defaultGrouping: WallGrouping | undefined = groupings[0];
  // DESIGN-038 D-07 — the selector renders for multiple SHAPES or multiple grouping DIMENSIONS
  // (Comics gains it via the Collections sibling without gaining a flat shape).
  const hasSelector = spec.offers.length > 1 || groupings.length > 1;
  const offersFlat = spec.offers.includes('flat');
  const prefsReady = stored !== undefined;

  // ── URL → state ──
  const qParam = searchParams.get('q') ?? '';
  const group = searchParams.get('group');
  const drilled = group !== null && group !== '';
  const urlView = parseWallViewParam(searchParams.get('view'), spec.offers);
  const byRaw = searchParams.get('by');
  const urlBy = byRaw !== null && groupings.some((g) => g.dimension === byRaw) ? byRaw : undefined;
  const resolved = resolveWallView({
    wall: booksWall,
    url: {
      ...(urlView !== undefined ? { view: urlView } : {}),
      ...(urlBy !== undefined ? { groupBy: urlBy } : {}),
    },
    stored: stored ?? null,
  });
  // The active grouping DIMENSION (URL ?by= wins → stored preference → the wall's default/first);
  // an unknown dimension falls back to the default (mangled-shared-link safety).
  const grouping: WallGrouping | undefined =
    groupings.find((g) => g.dimension === resolved.groupBy) ?? defaultGrouping;
  // A grouping WITH a bound registry level renders aggregate cards; one without (Comics' Series —
  // the wall IS that grouping, a Kavita row IS a series) renders the item grid (DESIGN-038 D-07).
  const groupedCards =
    !drilled && resolved.view === 'grouped' && grouping !== undefined && grouping.level !== undefined;
  // The dimension a DRILLED grid filters on (the drill link carries ?by= for non-default dims).
  const drillGrouping: WallGrouping | undefined =
    groupings.find((g) => g.dimension === (urlBy ?? defaultGrouping?.dimension)) ?? defaultGrouping;
  const drillDim = drillGrouping?.dimension;
  // ADR-066 / DESIGN-038 (PLAN-051) — the Collections dimension: aggregate cards come from
  // books.collectionGroups; the drill is a `collection` predicate keyed by the mirror row uuid.
  const collectionCards = groupedCards && grouping?.dimension === 'collection';
  const drilledCollection = drilled && drillDim === 'collection';
  const levelKey: ViewLevelKey = drilledCollection
    ? (`${booksWall}:collection-items` as ViewLevelKey)
    : groupedCards && grouping?.level
      ? grouping.level
      : (`${booksWall}:wall` as ViewLevelKey);
  const entry: ViewRegistryEntry = registryFor(levelKey);

  // ONE bounded collections read per wall (the facets/wanted always-on idiom): the grouped
  // Collections cards, the drill header label + `ordered` flag, and the selector's populated gate
  // all read it (books-section gated server-side like everything else here).
  const collectionsQ = trpc.books.collectionGroups.useQuery(
    { mediaKind },
    { refetchOnWindowFocus: false, placeholderData: (prev) => prev },
  );
  const drilledMeta = drilledCollection
    ? collectionsQ.data?.groups.find((g) => g.key === group)
    : undefined;
  // A drilled ?group= that is not one of this wall's collections (mangled/shared-stale link).
  const drilledMissing =
    drilledCollection && collectionsQ.data !== undefined && drilledMeta === undefined;
  // DESIGN-038 D-06 — the ordered-drill sort contract: an UNORDERED collection's drill drops the
  // position sort (the `ordered` flag is the data-honesty gate, the dataGated idiom applied to a
  // sort) and falls back to the wall level's default. Ordered drills default to List order.
  const positionOffered = !drilledCollection || drilledMeta?.ordered === true;
  const levelSorts = positionOffered
    ? entry.sorts
    : entry.sorts.filter((s) => s.key !== 'position');
  const levelDefaultSort = positionOffered
    ? entry.defaultSort
    : registryFor(`${booksWall}:wall` as ViewLevelKey).defaultSort;
  // Plain computations below (sortKeys/facetsForLevel/chipFacets/filters) — the React Compiler
  // memoizes them; manual useMemo over the registry-derived values trips
  // react-hooks/preserve-manual-memoization now that the level is grouping-dependent.
  const sortKeys = levelSorts.map((s) => s.key);

  // ADR-052 — sort resolution: URL token → stored (validated against THIS level's keys) → default.
  // A drilled COLLECTION ignores the stored wall sort (D-06 — the drill default is the point:
  // reading order for an ordered list); an explicit ?sort= still wins (shared links stay exact).
  const urlSort = parseWallSortToken(searchParams.get('sort'), sortKeys);
  const storedSort =
    stored != null && sortKeys.includes(stored.sortField)
      ? { field: stored.sortField, dir: stored.sortDir }
      : null;
  const sort =
    urlSort ??
    (drilledCollection ? null : storedSort) ??
    { field: levelDefaultSort.field, dir: levelDefaultSort.dir };
  const sortToken = `${sort.field}:${sort.dir}`;

  const readRaw = searchParams.get('read');
  const readState = READ_STATE_OPTIONS.some((o) => o.value === readRaw)
    ? (readRaw as BookReadState)
    : undefined;
  // PLAN-056 / DESIGN-029 amendment 3 — the THREE-state composed-Wanted filter (All · Wanted only ·
  // Hide wanted; absent = All). Server-authoritative: the state rides the books.search input and the
  // server composes/excludes there. Legacy `?wanted=1` links read as Wanted-only.
  const wantedRaw = searchParams.get('wanted');
  const wantedState: BooksWantedState =
    wantedRaw === 'only' || wantedRaw === '1' ? 'only' : wantedRaw === 'hide' ? 'hide' : 'all';
  const letterRaw = searchParams.get('at');
  const letter = letterRaw !== null && /^[a-z]$/.test(letterRaw) ? letterRaw : null;

  // The drilled dimension's own facet chip hides — the drill IS that filter (author OR genre).
  // A collection drill hides none: `collection` is not an item facet (its level omits `wanted`).
  const drillFacetKey =
    drillDim === 'genre' ? 'genres' : drillDim === 'collection' ? null : 'authors';
  const facetsForLevel = entry.facets.filter(
    (f) => !(drilled && drillFacetKey !== null && f.key === drillFacetKey),
  );
  const chipFacets = facetsForLevel.filter(
    (f) => f.kind === 'enum' || f.kind === 'suggest' || f.kind === 'buckets',
  );
  const filters: FilterMap<BooksField> = {};
  for (const f of chipFacets) {
    const vals = [...new Set(searchParams.getAll(f.param).filter((v) => v !== ''))];
    if (vals.length > 0) filters[f.key as BooksField] = vals;
  }

  // ── URL patching (refinements REPLACE — D-19) ──
  const patchParams = (patch: Record<string, string | string[] | null>) => {
    const params = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      params.delete(k);
      if (v === null || v === '') continue;
      if (Array.isArray(v)) for (const val of v) params.append(k, val);
      else params.set(k, v);
    }
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  // D-10 — CANONICALIZE a bare URL on a multi-shape wall to the resolved shape (a replace, no
  // history entry) so the entry's URL is explicit and Back restores exactly this view even after
  // the stored preference changes. A non-default grouping dimension canonicalizes its ?by= too.
  useEffect(() => {
    // Multi-SHAPE walls only (Comics — single-shape, selector-by-dimensions — keeps bare URLs;
    // its dimension switches PUSH explicit ?view=grouped&by=collection URLs).
    if (spec.offers.length <= 1 || !prefsReady || drilled) return;
    if (searchParams.get('view') === null) {
      patchParams({
        view: resolved.view === 'flat' ? 'flat' : 'grouped',
        by: resolved.view !== 'flat' && grouping !== undefined && grouping !== defaultGrouping
          ? grouping.dimension
          : null,
      });
    }
    // patchParams reads the live location; the deps that matter are the resolution inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.offers.length, prefsReady, drilled, searchParams, resolved.view, grouping]);

  // The search INPUT is a local draft debounced 250ms into the URL (the Library convention).
  const [query, setQuery] = useState(qParam);
  useEffect(() => {
    const t = setTimeout(() => {
      const current = new URLSearchParams(window.location.search).get('q') ?? '';
      if (query !== current) patchParams({ q: query });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // ── preference persistence (ADR-052 — explicit selections only, never on render) ──
  const utils = trpc.useUtils();
  const setPreference = trpc.library.preferences.set.useMutation({
    onSuccess: () => utils.library.preferences.getAll.invalidate(),
  });

  /** A view/dimension switch: a SCREEN-level change → PUSH a clean URL (refinements drop — the
   *  new shape starts fresh, like a tab switch) + persist the choice (R1). */
  const selectView = (target: { view: 'flat' } | { view: 'grouped'; grouping: WallGrouping }) => {
    // The active key covers item-grid groupings too (Comics' Series — grouped without cards).
    const currentKey = drilled
      ? null
      : resolved.view === 'grouped' && grouping !== undefined
        ? `grouped:${grouping.dimension}`
        : 'flat';
    const targetKey = target.view === 'flat' ? 'flat' : `grouped:${target.grouping.dimension}`;
    if (currentKey !== targetKey) {
      const params = new URLSearchParams();
      params.set('tab', booksWall);
      params.set('view', target.view);
      if (target.view === 'grouped' && target.grouping !== defaultGrouping) {
        params.set('by', target.grouping.dimension);
      }
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    }
    const level = registryFor(
      target.view === 'grouped' && target.grouping.level
        ? target.grouping.level
        : (`${booksWall}:wall` as ViewLevelKey),
    );
    const keys = level.sorts.map((s) => s.key);
    const keep =
      stored != null && keys.includes(stored.sortField)
        ? { field: stored.sortField, dir: stored.sortDir }
        : { field: level.defaultSort.field, dir: level.defaultSort.dir };
    setPreference.mutate({
      wall: booksWall,
      view: target.view,
      groupBy: target.view === 'grouped' ? target.grouping.dimension : null,
      sortField: keep.field,
      sortDir: keep.dir,
    });
  };

  // ── sort control (registry-declared keys, ordered-gated for a collection drill; two-state cycle) ──
  const clickCycle = Object.fromEntries(
    levelSorts.map((c) => [
      c.key,
      c.firstDir === 'asc'
        ? { asc: `${c.key}:asc`, desc: `${c.key}:desc` }
        : { asc: `${c.key}:desc`, desc: `${c.key}:asc` },
    ]),
  ) as Record<string, { asc: string; desc: string }>;
  const arrowCycle = Object.fromEntries(
    levelSorts.map((c) => [c.key, { asc: `${c.key}:asc`, desc: `${c.key}:desc` }]),
  ) as Record<string, { asc: string; desc: string }>;
  const cycleSort = (col: string) => {
    const next = nextSort<string, string>(sortToken, col, clickCycle);
    const [field, dir] = next.split(':') as [string, WallSortDir];
    patchParams({ sort: next, at: null });
    // R6 remember-last-used — persisted for the wall's top-level views; a DRILLED grid's sort is a
    // transient refinement of that one group screen, not the wall preference.
    if (!drilled) {
      setPreference.mutate({
        wall: booksWall,
        // A wall without a flat shape (Comics) persists its default grouped shape/dimension.
        view: groupedCards ? 'grouped' : offersFlat ? 'flat' : WALL_VIEW_DEFAULTS[booksWall].view,
        groupBy: groupedCards ? (grouping?.dimension ?? null) : offersFlat ? null : WALL_VIEW_DEFAULTS[booksWall].groupBy,
        sortField: field,
        sortDir: dir,
      });
    }
  };

  // ── data ──
  const facets = trpc.books.filterFacets.useQuery({ mediaKind }, { refetchOnWindowFocus: false });
  // ADR-057 (PLAN-045, owner-corrected) + PLAN-056 — the composed-Wanted household `book_requests`
  // (books-section gated server-side). Since PLAN-056 the wanted rows arrive INSIDE books.search
  // (composed into the active sort server-side); this always-on read remains as the three-state
  // selector's populated-value gate (ADR-051 C-06) and the wall-stage poll's enable signal.
  const wantedQ = trpc.books.wanted.useQuery({ mediaKind }, { refetchOnWindowFocus: false });
  const wantedAll = wantedQ.data?.items ?? [];
  // PLAN-048 / ADR-059 D-03 (#272 residual) — ONE live wall-stage read per wall view, enabled only when this
  // wall actually has wanted tiles (cheap: no wants ⇒ no query). Each wanted poster wears the live in-flight
  // stage badge (searching / downloading % / importing) and updates on the poll, in place (ADR-015). A book/
  // audiobook want joins by its LL/GB book id; a comic want by its Kapowarr volume id — the `activity.wallStages`
  // map is keyed exactly so (`{ [wall]: { [joinKey]: WallStage } }`).
  const wallStagesQ = trpc.activity.wallStages.useQuery(undefined, {
    enabled: wantedAll.length > 0,
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
    placeholderData: (prev) => prev,
  });
  const inFlightFor = (key: string | null | undefined): InFlightBadge | null => {
    if (key == null) return null;
    const s = wallStagesQ.data?.[booksWall]?.[key];
    return s ? { stage: s.stage, progress: s.progress } : null;
  };
  const wantedInFlight = (w: {
    llBookId: string | null;
    kapowarrVolumeId: string | null;
  }): InFlightBadge | null => inFlightFor(mediaKind === 'comic' ? w.kapowarrVolumeId : w.llBookId);
  const groupsQuery = trpc.books.groups.useQuery(
    { mediaKind, groupBy: grouping?.dimension === 'genre' ? 'genre' : 'author' },
    {
      enabled: groupedCards && !collectionCards,
      refetchOnWindowFocus: false,
      placeholderData: (prev) => prev,
    },
  );
  // The ACTIVE grouped-cards source: books.collectionGroups for the Collections dimension (cards
  // carry the ordered flag), books.groups for author/genre.
  const groupsError = collectionCards ? collectionsQ.error : groupsQuery.error;
  const groupsPending = collectionCards ? collectionsQ.isPending : groupsQuery.isPending;
  // The Genres/Collections selector segments are populated-value-gated like their facet chips
  // (ADR-051 C-06): once the data confirms the medium carries NONE, the segment hides (never a
  // dead view). While loading (undefined) the segment shows — the same optimistic rule as Genres.
  const selectorGroupings = groupings.filter(
    (g) =>
      (g.dimension !== 'genre' || facets.data === undefined || facets.data.genres.length > 0) &&
      (g.dimension !== 'collection' ||
        collectionsQ.data === undefined ||
        collectionsQ.data.groups.length > 0),
  );

  const azActive =
    !groupedCards && (entry.azSorts as readonly string[]).includes(sort.field) && sort.dir === 'asc';
  const bucketKind = mediaKind === 'audiobook' ? 'duration' : 'pages';
  const search = trpc.books.search.useInfiniteQuery(
    {
      mediaKind,
      // The registry pinned this level's keys to BooksSort at compile time.
      sort: sort.field as BooksSort,
      dir: sort.dir,
      ...(qParam.trim().length > 0 ? { query: qParam.trim() } : {}),
      // The drilled group IS its dimension's filter (D-04 — the flat grid pre-filtered to the
      // group): an author drill binds authors, a genre drill binds genres, a COLLECTION drill
      // binds the mirror membership predicate (DESIGN-038 D-06 — one EXISTS inside books.search).
      ...(drilled && drillDim === 'genre'
        ? { genres: [group] }
        : filters.genres
          ? { genres: filters.genres }
          : {}),
      ...(drilled && drillDim !== 'genre' && drillDim !== 'collection'
        ? { authors: [group] }
        : filters.authors
          ? { authors: filters.authors }
          : {}),
      ...(drilledCollection && group !== null ? { collection: group } : {}),
      ...(filters.narrators ? { narrators: filters.narrators } : {}),
      ...(filters.series ? { series: filters.series } : {}),
      ...(filters.languages ? { languages: filters.languages } : {}),
      ...(filters.formats ? { formats: filters.formats as ('epub' | 'archive' | 'pdf' | 'image' | 'unknown')[] } : {}),
      ...(filters.lengths ? { lengths: filters.lengths as ('short' | 'medium' | 'long')[] } : {}),
      ...(readState !== undefined ? { readState } : {}),
      ...(azActive && letter !== null ? { letter } : {}),
      // PLAN-056 — the three-state Wanted filter, applied SERVER-side ('all' composes wants into
      // the sorted stream; 'hide' excludes them there — never a client hide). A drilled group
      // forces 'hide': a want is not a group/collection member (the D-09 honesty rule).
      wanted: drilled ? ('hide' as const) : wantedState,
    },
    {
      // A collection drill waits for its meta (label + ordered — the sort default depends on it)
      // and never fires for a mangled/unknown ?group= (the empty state renders instead).
      enabled: prefsReady && !groupedCards && (!drilledCollection || drilledMeta !== undefined),
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      initialCursor: 0,
      placeholderData: (prev) => prev,
      refetchOnWindowFocus: false,
    },
  );

  const items = useMemo(() => search.data?.pages.flatMap((p) => p.items) ?? [], [search.data]);
  const refreshing = search.isFetching && !search.isFetchingNextPage && !search.isPending;

  // Grouped cards: client-side label search + card sort (the level's registry keys — author/label/
  // count). Plain computation — the React Compiler memoizes it (a manual useMemo on `sort.*` deps
  // trips react-hooks/preserve-manual-memoization); the group lists are small (bounded walls).
  const groupList = collectionCards
    ? (collectionsQ.data?.groups ?? [])
    : (groupsQuery.data?.groups ?? []);
  const groupQ = qParam.trim().toLowerCase();
  const groupsFound = groupQ === '' ? groupList : groupList.filter((g) => g.label.toLowerCase().includes(groupQ));
  const groupDir = sort.dir === 'desc' ? -1 : 1;
  const groups =
    sort.field === 'count'
      ? [...groupsFound].sort((a, b) => (a.count - b.count) * groupDir || a.label.localeCompare(b.label))
      : [...groupsFound].sort((a, b) => a.label.localeCompare(b.label) * groupDir);
  const groupsRefreshing = collectionCards
    ? collectionsQ.isPlaceholderData && collectionsQ.isFetching
    : groupsQuery.isPlaceholderData && groupsQuery.isFetching;

  // The `?from=` back-link key so the detail page returns to THIS wall (ADR-047).
  const fromKey = booksWall;

  const jumpVisible =
    !groupedCards &&
    // Wanted-only ignores the A–Z jump (a letter is an item refinement wants can't answer).
    wantedState !== 'only' &&
    showJumpBar({
      isAzSort: azActive,
      activeLetter: letter,
      itemCount: items.length,
      hasNextPage: search.hasNextPage === true,
    });

  // The shared sentinel scroll idiom (DESIGN-008 D-11 / DESIGN-024 amendment).
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const canLoadMore =
    search.hasNextPage === true && !search.isFetchingNextPage && !search.isPlaceholderData;
  useEffect(() => {
    const el = sentinelRef.current;
    if (el === null || !canLoadMore || groupedCards) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void search.fetchNextPage();
      },
      { rootMargin: '600px 0px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canLoadMore, groupedCards]);

  const facetValuesFor = (field: BooksField): readonly string[] => {
    if (facets.data === undefined) return [];
    switch (field) {
      case 'genres':
        return facets.data.genres;
      case 'authors':
        return facets.data.authors;
      case 'narrators':
        return facets.data.narrators;
      case 'series':
        return facets.data.series;
      case 'languages':
        return facets.data.languages;
      case 'formats':
        return facets.data.formats.map((f) => f.key);
      case 'lengths':
        return LENGTH_BUCKET_OPTIONS[bucketKind].map((o) => o.value);
    }
  };
  const formatLabel = (key: string): string =>
    facets.data?.formats.find((f) => f.key === key)?.label ?? key;
  const bucketLabel = (key: string): string =>
    LENGTH_BUCKET_OPTIONS[bucketKind].find((o) => o.value === key)?.label ?? key;
  const setFieldValues = (field: BooksField, values: string[]) => {
    const param = chipFacets.find((f) => f.key === field)!.param;
    patchParams({ [param]: values.length > 0 ? values : null });
  };

  const showEmpty = groupedCards
    ? !groupsPending && groups.length === 0
    : (!search.isPending && items.length === 0 && !search.error) || drilledMissing;
  const pending =
    !prefsReady ||
    (groupedCards ? groupsPending : drilledMissing ? false : search.isPending);

  return (
    <>
      {/* Drill-in header (D-04): the drilled group's name + the way back UP to the grouped wall.
          A screen of its own (reached by a PUSH), so this header is static per screen (ADR-015). */}
      {drilled && drillGrouping ? (
        <div className="library-drill" data-testid="library-drill">
          <Link
            className="btn sm library-drill__back"
            href={`${pathname}?tab=${booksWall}&view=grouped${
              drillGrouping !== defaultGrouping ? `&by=${encodeURIComponent(drillGrouping.dimension)}` : ''
            }`}
            scroll={false}
          >
            ‹ {drillGrouping.allLabel}
          </Link>
          {/* A collection drill's key is the mirror row uuid — the label resolves from the group
              listing (D-08); dimension drills (author/genre) key by the label itself. */}
          <span className="library-drill__label">
            {drilledCollection ? (drilledMeta?.label ?? '') : group}
          </span>
        </div>
      ) : null}

      <div className="library-toolbar">
        <div className="library-controls">
          {/* DESIGN-026 D-01 — the view selector (D-11 affordance call: the `.seg` segmented control,
              leftmost — the highest-level presentation choice). Only multi-shape walls render it; a
              grouping dimension is one segment each (Authors | Genres | All …). */}
          {hasSelector && !drilled && groupings.length > 0 ? (
            <div className="seg" role="group" aria-label="View" data-testid="view-selector">
              {selectorGroupings.map((g) => {
                // An item-grid grouping (Comics' Series) is active in the grouped shape too.
                const isActive = !drilled && resolved.view === 'grouped' && grouping === g;
                return (
                  <button
                    key={g.dimension}
                    type="button"
                    className={isActive ? 'is-active' : undefined}
                    aria-pressed={isActive}
                    onClick={() => selectView({ view: 'grouped', grouping: g })}
                  >
                    {g.selectorLabel}
                  </button>
                );
              })}
              {offersFlat ? (
                <button
                  type="button"
                  className={!groupedCards ? 'is-active' : undefined}
                  aria-pressed={!groupedCards}
                  onClick={() => selectView({ view: 'flat' })}
                >
                  {spec.flatLabel}
                </button>
              ) : null}
            </div>
          ) : null}
          <input
            type="search"
            className="library-search"
            placeholder={groupedCards ? `Search ${grouping?.selectorLabel.toLowerCase() ?? 'groups'}…` : `Search ${label.toLowerCase()}…`}
            aria-label={`Search ${label}`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {/* Facet chip bar — REGISTRY-declared per view level (grouped levels carry none; the flat
            levels offer exactly their answerable facets, D-03). Value-gated facets (narrator /
            series / language / genre-on-ABS) hide entirely while empty (ADR-051 C-06 — no dead
            chip); the per-user Read chip needs the bookProgress gate. Fixed-height pan row. */}
        {facetsForLevel.length > 0 ? (
          <div className="library-chipbar" role="group" aria-label="Filters">
            {facetsForLevel.map((facet) => {
              if (facet.key === 'wanted') {
                // PLAN-056 / DESIGN-029 amendment 3 — the THREE-state composed-Wanted selector
                // (All · Wanted only · Hide wanted) on the wall's existing `.seg` idiom: fixed
                // per-segment labels, recolor-not-reflow (ADR-015); `?wanted=` is a replace-in-place
                // refinement (D-19). Value-gated on the overlay itself (ADR-051 C-06 — no dead
                // control) and absent inside a drill (a want is not a group member; the server
                // excludes it there regardless).
                if (drilled || wantedAll.length === 0) return null;
                const wantedSegments = [
                  { value: 'all', label: 'All', testId: 'books-wanted-all' },
                  { value: 'only', label: 'Wanted only', testId: 'books-wanted-only' },
                  { value: 'hide', label: 'Hide wanted', testId: 'books-wanted-hide' },
                ] as const;
                return (
                  <div
                    key={facet.key}
                    className="seg"
                    role="group"
                    aria-label="Wanted"
                    data-testid="books-wanted-filter"
                  >
                    {wantedSegments.map((s) => (
                      <button
                        key={s.value}
                        type="button"
                        className={wantedState === s.value ? 'is-active' : undefined}
                        aria-pressed={wantedState === s.value}
                        data-testid={s.testId}
                        onClick={() => patchParams({ wanted: s.value === 'all' ? null : s.value })}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                );
              }
              if (facet.kind === 'select' && facet.gate === 'bookProgress') {
                if (!gates.bookProgress) return null;
                return (
                  <SelectChip
                    key={facet.key}
                    label={facet.label}
                    value={readState}
                    options={READ_STATE_OPTIONS}
                    onChange={(v) => patchParams({ read: v ?? null })}
                  />
                );
              }
              if (facet.kind !== 'enum' && facet.kind !== 'suggest' && facet.kind !== 'buckets') return null;
              const field = facet.key as BooksField;
              const values = facetValuesFor(field);
              if (facet.dataGated && values.length === 0) return null;
              return (
                <FilterChip
                  key={facet.key}
                  fieldLabel={facet.label}
                  values={filterValues(filters, field)}
                  kind={facet.kind === 'suggest' ? 'unbounded' : 'enum'}
                  enumValues={facet.kind === 'suggest' ? undefined : values}
                  suggestions={facet.kind === 'suggest' ? [...values] : undefined}
                  enumLabel={
                    facet.key === 'formats' ? formatLabel : facet.key === 'lengths' ? bucketLabel : undefined
                  }
                  displayValues={
                    facet.key === 'formats'
                      ? filterValues(filters, field).map(formatLabel)
                      : facet.key === 'lengths'
                        ? filterValues(filters, field).map(bucketLabel)
                        : undefined
                  }
                  labels={CHIP_LABELS}
                  onAdd={(v) => setFieldValues(field, filterValues(addFilterValue(filters, field, v), field))}
                  onRemove={(v) =>
                    setFieldValues(field, filterValues(removeFilterValue(filters, field, v), field))
                  }
                  onClear={() => setFieldValues(field, [])}
                />
              );
            })}
          </div>
        ) : null}

        {/* Sort bar — the ACTIVE LEVEL's registry keys (grouped: author/count over the cards; flat:
            the wall's answerable sorts; a collection drill's keys are ordered-gated — levelSorts).
            Two-state cycle with the reserved arrow slot (ADR-015). */}
        <div className="library-sortbar" role="group" aria-label="Sort">
          <span className="library-sortbar__label">Sort</span>
          {levelSorts.map((c) => {
            const isActive = sort.field === c.key;
            return (
              <button
                key={c.key}
                type="button"
                className={`sort-btn${isActive ? ' is-active' : ''}`}
                aria-pressed={isActive}
                onClick={() => cycleSort(c.key)}
              >
                {c.label}
                <span className="sort-btn__arrow" aria-hidden="true">
                  {arrowFor<string, string>(sortToken, c.key, arrowCycle).trim()}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {jumpVisible ? <LetterJumpBar active={letter} onJump={(l) => patchParams({ at: l })} /> : null}

      {pending ? (
        SKELETON
      ) : groupedCards ? (
        groupsError ? (
          <p className="alert" role="alert">
            Failed to load {label}: {groupsError.message}
          </p>
        ) : showEmpty ? (
          <section className="card empty-state">
            <p className="muted">
              {qParam.trim().length > 0
                ? 'Nothing matches your search.'
                : collectionCards
                  ? 'No collections yet.'
                  : `No ${label.toLowerCase()} yet.`}
            </p>
          </section>
        ) : (
          // DESIGN-026 D-04 (art-amended) — the aggregate cards: the dimension's REAL portrait /
          // the stacked-cover fan / the designed glyph tile, all in the reserved 2:3 box
          // (GroupCard), plus the group label and the member count. Drill-in = PUSH.
          <PosterGrid refreshing={groupsRefreshing} testId="books-groups">
            {groups.map((g) => (
              <GroupCard
                key={g.key}
                href={`${pathname}?tab=${booksWall}${
                  grouping !== undefined && grouping !== defaultGrouping
                    ? `&by=${encodeURIComponent(grouping.dimension)}`
                    : ''
                }&group=${encodeURIComponent(g.key)}`}
                art={grouping?.art ?? 'covers'}
                label={g.label}
                imageUrl={g.imageUrl}
                coverUrls={g.coverUrls}
                kind={mediaKind}
                count={g.count}
                // Provenance badge only on the Collections dimension (author/genre groups carry none).
                provenance={
                  collectionCards ? (g as { provenance?: string | null }).provenance : undefined
                }
              />
            ))}
          </PosterGrid>
        )
      ) : search.error ? (
        <p className="alert" role="alert">
          Failed to load {label}: {search.error.message}
        </p>
      ) : showEmpty ? (
        <section
          className="card empty-state"
          data-testid={wantedState === 'only' ? 'wanted-empty' : undefined}
        >
          <p className="muted">
            {qParam.trim().length > 0
              ? 'Nothing matches your search.'
              : wantedState === 'only'
                ? `No wanted ${label.toLowerCase()} right now.`
                : `No ${label.toLowerCase()} yet.`}
          </p>
        </section>
      ) : (
        <>
          <PosterGrid refreshing={refreshing} testId="books-grid">
            {/* PLAN-056 / DESIGN-029 amendment 3 — ONE composed stream from books.search: a wanted
                entry lands exactly where the active sort puts it (never pinned to the head) and
                renders the SAME poster block as an on-disk book. */}
            {items.map((entry) => {
              if (entry.kind === 'wanted') {
                return (
                  <WantedCard
                    key={`w-${entry.requestId}`}
                    item={entry}
                    mediaKind={mediaKind}
                    inFlight={wantedInFlight(entry)}
                  />
                );
              }
              const duration = formatDuration(entry.durationSeconds);
              const badge =
                mediaKind === 'audiobook'
                  ? duration
                  : entry.pageCount
                    ? `${entry.pageCount} pp`
                    : null;
              // ADR-065 / DESIGN-036 D-09 — the format-coverage badge ("Ebook + Audio" when the title
              // is paired; the honest single-format label otherwise). Comics carry none (null).
              const coverage =
                entry.formatCoverage === 'both'
                  ? 'Ebook + Audio'
                  : entry.formatCoverage === 'ebook'
                    ? 'Ebook only'
                    : entry.formatCoverage === 'audio'
                      ? 'Audio only'
                      : null;
              return (
                // ADR-047 — the tile opens the in-app books DETAIL page (the deep link lives there now).
                <BookCard
                  key={entry.id}
                  href={`/library/books/${entry.id}?from=${fromKey}`}
                  posterUrl={entry.posterUrl}
                  mediaKind={entry.mediaKind}
                  title={entry.title}
                  year={entry.year}
                  author={entry.author}
                  badges={[badge ? { label: badge } : null, coverage ? { label: coverage } : null]}
                />
              );
            })}
          </PosterGrid>
          {search.hasNextPage ? (
            // The scroll sentinel (reused Library idiom): the observer above watches this element and
            // fetches the next page as it nears the viewport — no Load more button. The fetching hint
            // sits BELOW the grid, so appending the next page never shifts existing tiles (ADR-015).
            <div className="load-more" ref={sentinelRef}>
              {search.isFetchingNextPage ? <span className="muted">Loading…</span> : null}
            </div>
          ) : null}
        </>
      )}

      {/* ADR-070 / DESIGN-043 D-05 — the member "Suggest a collection" affordance sits AFTER the
          collections grid (only on the Collections dimension, not inside a drill), so it never reflows an
          existing card (ADR-015). It hides itself for members without the `suggest` grant and for comics. */}
      {collectionCards && !drilled && !pending && !groupsError ? (
        <SuggestCollectionAffordance mediaKind={mediaKind} />
      ) : null}
    </>
  );
}
