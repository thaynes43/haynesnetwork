'use client';

// DESIGN-005 D-17 / DESIGN-008 D-11 — /library: WAI-ARIA sub-tabs (Movies · TV · Music ·
// My Fixes, default Movies). Each media tab renders a POSTER-CARD GRID (fixed 2:3 boxes,
// ADR-019 authed poster proxy, KindIcon fallback) over the extended ledger.search, with a
// filter CHIP BAR + SORT control built on the ported @hnet/ui filter engine (D-10) and the
// facet values from ledger.filterFacets. Cards stay ACTION-FREE click-throughs to
// /library/[id] (owner ruling 2026-07-04) — the grid carries badges only.
//
// URL-state contract (deep-linkable, Back/Forward safe — documented in DESIGN-008 D-11):
//   ?tab=movies|tv|music|my-fixes          the sub-tab
//   ?q=…                                   search text (input debounced 250ms → URL)
//   ?disk=complete|partial|none            on-disk narrowing ('any' = absent)
//   ?wanted=1                              the wanted-only toggle
//   ?genre=…&genre=… / res / req / col     facet filters (REPEATED params — comma-safe)
//   ?rmin=7&rmax=9                         the bounded rating chip (imdb_rating, D-09)
//   ?sort=imdb_rating:desc                 wire sort ('title:asc' = absent default)
// Every filter/sort edit uses router.replace — the URL always mirrors the state (shareable),
// while Back/Forward cross PAGES, not individual filter edits. Switching media tabs keeps
// ONLY ?tab (fresh start per tab; the keyed remount below re-reads the now-clean URL), so a
// filter set on Movies never leaks into TV/Music.
//
// ADR-015 (no reorientation): the chip bar and sort bar are FIXED-HEIGHT single rows that
// scroll horizontally when crowded — adding/removing chips or wrapping never shifts the grid;
// chip editors are viewport-clamped fixed-position OVERLAYS; poster boxes reserve their 2:3
// space; a filter/sort refetch keeps the previous grid rendered (dimmed) and the initial load
// shows skeleton poster boxes — never a spinner that collapses.
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  FilterChip,
  chipPopoverStyle,
  addFilterValue,
  removeFilterValue,
  filterValues,
  nextSort,
  arrowFor,
  type FilterChipLabels,
  type FilterMap,
} from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import {
  ARR_KIND_LABELS,
  RESOLUTION_LABELS,
  formatRating,
  onDiskSummary,
  orderResolutions,
  type ArrKindName,
  type ResolutionName,
} from '@/lib/media';
import { MediaPoster } from '@/components/media-poster';
import { MyFixesPanel } from '@/components/my-fixes-panel';

const LIBRARY_TABS = [
  { key: 'movies', label: 'Movies', arrKind: 'radarr' },
  { key: 'tv', label: 'TV', arrKind: 'sonarr' },
  { key: 'music', label: 'Music', arrKind: 'lidarr' },
  { key: 'my-fixes', label: 'My Fixes', arrKind: undefined },
] as const satisfies ReadonlyArray<{ key: string; label: string; arrKind?: ArrKindName }>;

type TabKey = (typeof LIBRARY_TABS)[number]['key'];

const ON_DISK_FILTERS = [
  { value: 'any', label: 'Any' },
  { value: 'complete', label: 'Complete' },
  { value: 'partial', label: 'Partial' },
  { value: 'none', label: 'Missing' },
] as const;

type OnDiskFilter = (typeof ON_DISK_FILTERS)[number]['value'];

// DESIGN-008 D-11 — the host's filter field union: each facet maps to a URL param and to the
// same-named ledger.search input. Values come from ledger.filterFacets (tab-scoped).
type LibraryField = 'genres' | 'resolutions' | 'requesters' | 'sourceCollections';
const FILTER_FIELDS: ReadonlyArray<{ field: LibraryField; param: string; label: string }> = [
  { field: 'genres', param: 'genre', label: 'Genre' },
  { field: 'resolutions', param: 'res', label: 'Resolution' },
  { field: 'requesters', param: 'req', label: 'Requester' },
  { field: 'sourceCollections', param: 'col', label: 'Collection' },
];

// DESIGN-008 D-09 — the wire sort fields this page offers (LIBRARY_SORT_FIELDS subset).
const SORT_FIELDS = [
  'title',
  'imdb_rating',
  'tmdb_rating',
  'added_at',
  'play_count',
  'last_viewed',
  'runtime',
] as const;
type SortField = (typeof SORT_FIELDS)[number];
type SortToken = `${SortField}:${'asc' | 'desc'}`;
const DEFAULT_SORT: SortToken = 'title:asc';

interface SortColumn {
  col: string;
  label: string;
  field: SortField;
  /** which direction the FIRST click gives ('desc' = best/newest-first columns). */
  firstDir: 'asc' | 'desc';
}

/** The sort columns per media tab. "Rating" rides imdb_rating for Movies but tmdb_rating for
 *  TV/Music (Sonarr/Lidarr expose one community rating, mapped to the tmdb slots — ADR-018
 *  C-07); Music drops Runtime (artists have none — D-02). */
function sortColumnsFor(arrKind: ArrKindName): SortColumn[] {
  const rating: SortField = arrKind === 'radarr' ? 'imdb_rating' : 'tmdb_rating';
  return [
    { col: 'title', label: 'Title', field: 'title', firstDir: 'asc' },
    { col: 'rating', label: 'Rating', field: rating, firstDir: 'desc' },
    { col: 'added', label: 'Added', field: 'added_at', firstDir: 'desc' },
    { col: 'plays', label: 'Plays', field: 'play_count', firstDir: 'desc' },
    { col: 'watched', label: 'Watched', field: 'last_viewed', firstDir: 'desc' },
    ...(arrKind === 'lidarr'
      ? []
      : [{ col: 'runtime', label: 'Runtime', field: 'runtime', firstDir: 'desc' } as SortColumn]),
  ];
}

function parseSortToken(raw: string | null): { field: SortField; dir: 'asc' | 'desc' } {
  const [field, dir] = (raw ?? '').split(':');
  if ((SORT_FIELDS as readonly string[]).includes(field ?? '') && (dir === 'asc' || dir === 'desc')) {
    return { field: field as SortField, dir };
  }
  return { field: 'title', dir: 'asc' };
}

function parseRatingBound(raw: string | null): number | undefined {
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 10 ? n : undefined;
}

// Host copy for the ported chips (the shared components are i18n-free — D-10).
const CHIP_LABELS: FilterChipLabels = {
  editChip: (f) => `Edit the ${f} filter`,
  clearChip: (f) => `Clear the ${f} filter`,
  addValue: (f) => `Add a ${f} value`,
  removeValue: (_f, v) => `Remove ${v}`,
  valuePlaceholder: 'Type a value…',
  add: 'Add',
  noMatches: 'No matches',
  noValues: 'Nothing to filter by yet — values appear as the metadata harvest runs.',
};

function resolveTab(raw: string | null): TabKey {
  return LIBRARY_TABS.some((t) => t.key === raw) ? (raw as TabKey) : 'movies';
}

function LibraryContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = resolveTab(searchParams.get('tab'));
  const activeTab = LIBRARY_TABS.find((t) => t.key === active) ?? LIBRARY_TABS[0];

  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectTab = (key: TabKey) => {
    // Switching tabs starts fresh: keep ONLY ?tab (drops filter/sort/search params) so a
    // filter set on Movies never leaks into TV/Music — the keyed remount below re-reads the
    // clean URL. Documented in DESIGN-008 D-11.
    const params = new URLSearchParams();
    params.set('tab', key);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (e.key === 'ArrowRight') next = (index + 1) % LIBRARY_TABS.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + LIBRARY_TABS.length) % LIBRARY_TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = LIBRARY_TABS.length - 1;
    else return;
    e.preventDefault();
    const target = LIBRARY_TABS[next];
    if (!target) return;
    selectTab(target.key);
    tabRefs.current[next]?.focus();
  };

  return (
    <>
      <h1 className="page-title">Library</h1>

      <div className="library-tabs" role="tablist" aria-label="Library sections">
        {LIBRARY_TABS.map((tab, index) => (
          <button
            key={tab.key}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={`libtab-${tab.key}`}
            aria-selected={active === tab.key}
            aria-controls="library-panel"
            tabIndex={active === tab.key ? 0 : -1}
            onClick={() => selectTab(tab.key)}
            onKeyDown={(e) => onTabKeyDown(e, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div id="library-panel" role="tabpanel" aria-labelledby={`libtab-${active}`}>
        {activeTab.arrKind ? (
          // Keyed by tab: switching media tabs REMOUNTS with fresh state, so nothing carries
          // over besides what the (tab-cleaned) URL says.
          <MediaBrowser key={activeTab.key} arrKind={activeTab.arrKind} label={activeTab.label} />
        ) : (
          <MyFixesPanel />
        )}
      </div>
    </>
  );
}

// One media tab's browse UI: search + on-disk/wanted controls, the facet chip bar + sort bar
// (D-10 engine, D-09 contract), and the poster grid with keyset infinite scroll. All result-
// shaping state lives in the URL (see the contract at the top of this file).
function MediaBrowser({ arrKind, label }: { arrKind: ArrKindName; label: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // ── URL → state (the URL is the single source of truth) ──
  const qParam = searchParams.get('q') ?? '';
  const diskRaw = searchParams.get('disk');
  const onDisk: OnDiskFilter = ON_DISK_FILTERS.some((f) => f.value === diskRaw)
    ? (diskRaw as OnDiskFilter)
    : 'any';
  const wantedOnly = searchParams.get('wanted') === '1';
  const filters = useMemo<FilterMap<LibraryField>>(() => {
    const out: FilterMap<LibraryField> = {};
    for (const f of FILTER_FIELDS) {
      const vals = [...new Set(searchParams.getAll(f.param).filter((v) => v !== ''))];
      if (vals.length > 0) out[f.field] = vals;
    }
    return out;
  }, [searchParams]);
  const ratingMin = parseRatingBound(searchParams.get('rmin'));
  const ratingMax = parseRatingBound(searchParams.get('rmax'));
  const sort = parseSortToken(searchParams.get('sort'));
  const sortToken: SortToken = `${sort.field}:${sort.dir}`;

  // Merge one patch into the URL (null deletes; arrays become repeated params). Reads the
  // LIVE location rather than the hook value so two quick patches never clobber each other.
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

  // The search INPUT is a local draft (initialised from ?q on mount — tab switches remount
  // via the key) debounced 250ms into the URL; the QUERY reads ?q, so URL and results always
  // agree and a shared link restores the text.
  const [query, setQuery] = useState(qParam);
  useEffect(() => {
    const t = setTimeout(() => {
      const current = new URLSearchParams(window.location.search).get('q') ?? '';
      if (query !== current) patchParams({ q: query });
    }, 250);
    return () => clearTimeout(t);
    // patchParams reads live state; re-arming on query edits is the whole point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const setFieldValues = (field: LibraryField, values: string[]) => {
    const param = FILTER_FIELDS.find((f) => f.field === field)!.param;
    patchParams({ [param]: values.length > 0 ? values : null });
  };

  // ── sort control (the ported nextSort/arrowFor engine) ──
  const sortColumns = sortColumnsFor(arrKind);
  // Click cycle per column: first click → firstDir, second → the other, third → default.
  const clickCycle = Object.fromEntries(
    sortColumns.map((c) => [
      c.col,
      c.firstDir === 'asc'
        ? { asc: `${c.field}:asc` as SortToken, desc: `${c.field}:desc` as SortToken }
        : { asc: `${c.field}:desc` as SortToken, desc: `${c.field}:asc` as SortToken },
    ]),
  ) as Record<string, { asc: SortToken; desc: SortToken }>;
  // Direction-true map for the ▲/▼ glyph.
  const arrowCycle = Object.fromEntries(
    sortColumns.map((c) => [
      c.col,
      { asc: `${c.field}:asc` as SortToken, desc: `${c.field}:desc` as SortToken },
    ]),
  ) as Record<string, { asc: SortToken; desc: SortToken }>;
  const cycleSort = (col: string) => {
    const next = nextSort<SortToken, string>(sortToken, col, clickCycle);
    patchParams({ sort: next === undefined || next === DEFAULT_SORT ? null : next });
  };

  // ── facets + search (D-09) ──
  const facets = trpc.ledger.filterFacets.useQuery({ arrKind });
  const facetValues = (field: LibraryField): readonly string[] => {
    if (facets.data === undefined) return [];
    if (field === 'resolutions') return orderResolutions(facets.data.resolutions);
    return facets.data[field];
  };

  const resolutionsInput = filterValues(filters, 'resolutions').filter((v): v is ResolutionName =>
    Object.hasOwn(RESOLUTION_LABELS, v),
  );
  const search = trpc.ledger.search.useInfiniteQuery(
    {
      query: qParam.trim() === '' ? undefined : qParam.trim(),
      arrKind,
      onDisk,
      ...(wantedOnly ? { wanted: true } : {}),
      sort,
      ...(filters.genres ? { genres: filters.genres } : {}),
      ...(resolutionsInput.length > 0 ? { resolutions: resolutionsInput } : {}),
      ...(filters.requesters ? { requesters: filters.requesters } : {}),
      ...(filters.sourceCollections ? { sourceCollections: filters.sourceCollections } : {}),
      ...(ratingMin !== undefined ? { ratingMin } : {}),
      ...(ratingMax !== undefined ? { ratingMax } : {}),
      limit: 50,
    },
    {
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      // Keep the previous grid rendered (dimmed below) while a filter/sort refetch resolves —
      // results swap in place, the layout never jumps (ADR-015).
      placeholderData: (prev) => prev,
    },
  );

  const items = search.data?.pages.flatMap((p) => p.items) ?? [];
  const refreshing = search.isPlaceholderData && search.isFetching;

  // Keyset infinite scroll: a sentinel below the grid pulls the next page as it approaches
  // the viewport; the Load more button stays as the visible/manual fallback.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const canLoadMore =
    search.hasNextPage === true && !search.isFetchingNextPage && !search.isPlaceholderData;
  useEffect(() => {
    const el = sentinelRef.current;
    if (el === null || !canLoadMore) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void search.fetchNextPage();
      },
      { rootMargin: '600px 0px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canLoadMore]);

  return (
    <>
      <div className="library-toolbar">
        <div className="library-controls">
          <input
            type="search"
            className="library-search"
            placeholder={`Search ${label.toLowerCase()}…`}
            aria-label="Search the library"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="library-filters">
            <div className="seg" role="group" aria-label="On disk">
              {ON_DISK_FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  className={onDisk === f.value ? 'is-active' : undefined}
                  onClick={() => patchParams({ disk: f.value === 'any' ? null : f.value })}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={`btn sm${wantedOnly ? ' primary' : ''}`}
              aria-pressed={wantedOnly}
              onClick={() => patchParams({ wanted: wantedOnly ? null : '1' })}
            >
              Wanted only
            </button>
          </div>
        </div>

        {/* Filter chip bar (D-10 engine): one permanent chip per facet — empty chips are the
            ghost "add a filter" affordance, active chips carry the OR-ed CSV + the clear ✕.
            A FIXED-HEIGHT single row that scrolls horizontally when crowded (ADR-015: the bar
            never grows, so the grid never shifts); editors overlay via fixed positioning. */}
        <div className="library-chipbar" role="group" aria-label="Filters">
          {FILTER_FIELDS.map((f) => (
            <FilterChip
              key={f.field}
              fieldLabel={f.label}
              values={filterValues(filters, f.field)}
              kind="enum"
              enumValues={facetValues(f.field)}
              enumLabel={f.field === 'resolutions' ? (v) => RESOLUTION_LABELS[v] ?? v : undefined}
              labels={CHIP_LABELS}
              onAdd={(v) =>
                setFieldValues(f.field, filterValues(addFilterValue(filters, f.field, v), f.field))
              }
              onRemove={(v) =>
                setFieldValues(
                  f.field,
                  filterValues(removeFilterValue(filters, f.field, v), f.field),
                )
              }
              onClear={() => setFieldValues(f.field, [])}
            />
          ))}
          {/* The bounded rating chip (D-11 judgment call): Movies only — D-09's ratingMin/Max
              compare imdb_rating, which only the Radarr tier fills (ADR-018 C-07). */}
          {arrKind === 'radarr' ? (
            <RatingChip
              min={ratingMin}
              max={ratingMax}
              onChange={(min, max) =>
                patchParams({
                  rmin: min === undefined ? null : String(min),
                  rmax: max === undefined ? null : String(max),
                })
              }
            />
          ) : null}
        </div>

        {/* Sort bar (D-10 nextSort/arrowFor): each column cycles best-first → reversed →
            default (Title A–Z). Same fixed-height scroll-row pattern as the chip bar. */}
        <div className="library-sortbar" role="group" aria-label="Sort">
          <span className="library-sortbar__label">Sort</span>
          {sortColumns.map((c) => {
            const isActive = sort.field === c.field;
            return (
              <button
                key={c.col}
                type="button"
                className={`sort-btn${isActive ? ' is-active' : ''}`}
                aria-pressed={isActive}
                onClick={() => cycleSort(c.col)}
              >
                {c.label}
                {/* fixed-width slot: the arrow appearing never nudges neighbors (ADR-015) */}
                <span className="sort-btn__arrow" aria-hidden="true">
                  {arrowFor<SortToken, string>(sortToken, c.col, arrowCycle).trim()}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {search.isLoading ? (
        // Initial load: skeleton poster boxes hold the exact grid geometry (ADR-015 — no
        // spinner that collapses into a differently-sized result).
        <div className="media-list poster-grid" aria-hidden="true" data-testid="poster-skeleton">
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i} className="poster-card poster-card--skeleton">
              <div className="poster-box" />
              <span className="poster-card__body">
                <span className="skeleton-line" />
                <span className="skeleton-line skeleton-line--short" />
              </span>
            </div>
          ))}
        </div>
      ) : search.error ? (
        <p className="alert" role="alert">
          Failed to load the library: {search.error.message}
        </p>
      ) : items.length === 0 ? (
        <section className="card empty-state">
          <p>Nothing matches — the ledger fills in as sync runs.</p>
        </section>
      ) : (
        <div
          className={`media-list poster-grid${refreshing ? ' is-refreshing' : ''}`}
          aria-busy={refreshing}
        >
          {items.map((item) => {
            const disk = onDiskSummary(item);
            const rating = formatRating(item.metadata.imdbRating ?? item.metadata.tmdbRating);
            const ratingSource = item.metadata.imdbRating !== null ? 'IMDb' : 'TMDb';
            return (
              <Link key={item.id} href={`/library/${item.id}`} className="media-card poster-card">
                <MediaPoster posterUrl={item.posterUrl} kind={item.arrKind} alt="" />
                <span className="poster-card__body">
                  <span className="media-card__title">
                    {item.title}
                    {item.year !== null ? <span className="muted"> ({item.year})</span> : null}
                  </span>
                  <span className="media-card__badges">
                    <span className="badge badge--muted">{ARR_KIND_LABELS[item.arrKind]}</span>
                    {rating !== null ? (
                      <span className="badge badge--rating" title={`${ratingSource} rating`}>
                        ★ {rating}
                      </span>
                    ) : null}
                    <span className={`badge badge--${disk.tone}`}>{disk.label}</span>
                    {item.tombstoned ? <span className="badge badge--danger">Removed</span> : null}
                  </span>
                </span>
              </Link>
            );
          })}
        </div>
      )}

      {search.hasNextPage === true ? (
        <div className="load-more" ref={sentinelRef}>
          <button
            type="button"
            className="btn"
            disabled={search.isFetchingNextPage}
            onClick={() => void search.fetchNextPage()}
          >
            {search.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : null}
    </>
  );
}

/** DESIGN-008 D-11 — the bounded rating-range chip. It wears the shared `hnet-` chip skin
 *  (same pill, same overlay-popover geometry via chipPopoverStyle) but edits a RANGE rather
 *  than a value set, so it is host glue rather than a FilterChip kind. */
function RatingChip({
  min,
  max,
  onChange,
}: {
  min: number | undefined;
  max: number | undefined;
  onChange: (min: number | undefined, max: number | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [popStyle, setPopStyle] = useState<CSSProperties | undefined>(undefined);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const empty = min === undefined && max === undefined;

  const toggleOpen = () => {
    if (open) {
      setOpen(false);
      return;
    }
    if (rootRef.current !== null) {
      setPopStyle(
        chipPopoverStyle(rootRef.current.getBoundingClientRect(), {
          width: window.innerWidth,
          height: window.innerHeight,
        }),
      );
    }
    setOpen(true);
  };

  // Same dismissal contract as the shared FilterChip: outside click, Escape, resize, scroll.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const close = () => setOpen(false);
    const onScroll = (e: Event) => {
      if (rootRef.current && e.target instanceof Node && rootRef.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  const csv =
    min !== undefined && max !== undefined
      ? `${min}–${max}`
      : min !== undefined
        ? `≥ ${min}`
        : max !== undefined
          ? `≤ ${max}`
          : '';
  const bound = (raw: string): number | undefined => (raw === '' ? undefined : Number(raw));

  return (
    <span ref={rootRef} className={`hnet-filter-chip${empty ? ' is-empty' : ''}`}>
      <button
        type="button"
        className="hnet-chip-open"
        aria-haspopup="true"
        aria-expanded={open}
        title="Edit the Rating filter"
        onClick={toggleOpen}
      >
        <span className="hnet-chip-label">
          Rating
          {csv !== '' ? (
            <>
              {' · '}
              <span className="hnet-chip-csv">{csv}</span>
            </>
          ) : null}
        </span>
        <span className="hnet-chip-caret" aria-hidden="true" />
      </button>
      {!empty ? (
        <button
          type="button"
          className="hnet-chip-x"
          aria-label="Clear the Rating filter"
          title="Clear the Rating filter"
          onClick={() => onChange(undefined, undefined)}
        >
          ✕
        </button>
      ) : null}
      {open ? (
        <div
          className="hnet-chip-popover"
          role="dialog"
          aria-label="Edit the Rating filter"
          style={popStyle}
        >
          <div className="rating-editor">
            <label className="rating-editor__bound">
              <span>Min</span>
              <select
                value={min ?? ''}
                onChange={(e) => onChange(bound(e.target.value), max)}
                aria-label="Minimum rating"
              >
                <option value="">Any</option>
                {[9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => (
                  <option key={n} value={n}>
                    {n}+
                  </option>
                ))}
              </select>
            </label>
            <label className="rating-editor__bound">
              <span>Max</span>
              <select
                value={max ?? ''}
                onChange={(e) => onChange(min, bound(e.target.value))}
                aria-label="Maximum rating"
              >
                <option value="">Any</option>
                {[10, 9, 8, 7, 6, 5, 4, 3, 2].map((n) => (
                  <option key={n} value={n}>
                    up to {n}
                  </option>
                ))}
              </select>
            </label>
            <p className="rating-editor__hint muted">IMDb score, 0–10</p>
          </div>
        </div>
      ) : null}
    </span>
  );
}

export default function LibraryPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <LibraryContent />
    </Suspense>
  );
}
