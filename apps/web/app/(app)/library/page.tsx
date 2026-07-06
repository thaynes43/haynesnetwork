'use client';

// DESIGN-005 D-17 / DESIGN-008 D-11 — /library: WAI-ARIA sub-tabs (Movies · TV · Music ·
// My Fixes). Each media tab renders a POSTER-CARD GRID (ADR-019) over ledger.search, with a
// filter chip bar + sort control built on the ported @hnet/ui filter engine (D-10) and
// URL-synced state (deep-linkable, Back/Forward safe). Cards are ACTION-FREE click-throughs to
// /library/[id] (owner ruling 2026-07-04) — the grid carries badges only. No-reorientation
// (ADR-015): the poster boxes reserve their 2:3 space so late image loads never reflow neighbors;
// applying a filter/sort swaps the result set (a deliberate content change).
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useRef, useState } from 'react';
import {
  FilterChip,
  type FilterChipLabels,
  type FilterMap,
  addFilterValue,
  removeFilterValue,
  nextSort,
  arrowFor,
} from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import {
  ARR_KIND_LABELS,
  RESOLUTION_LABELS,
  formatRating,
  onDiskSummary,
  type ArrKindName,
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

// DESIGN-008 D-09 — the host's filter field union + the URL param each maps to. Genres /
// requesters / collections draw their checklist values from ledger.filterFacets; resolutions
// from the RESOLUTIONS enum.
type LibraryField = 'genres' | 'resolutions' | 'requesters' | 'sourceCollections';
const FILTER_FIELDS: ReadonlyArray<{ field: LibraryField; param: string; label: string }> = [
  { field: 'genres', param: 'g', label: 'Genre' },
  { field: 'resolutions', param: 'res', label: 'Resolution' },
  { field: 'requesters', param: 'req', label: 'Requester' },
  { field: 'sourceCollections', param: 'col', label: 'Collection' },
];

// DESIGN-008 D-09 — the sort control (the ported nextSort/arrowFor engine). Each column
// cycles unsorted → asc → desc → default (title asc).
const SORT_COLUMNS = [
  { col: 'title', label: 'Title' },
  { col: 'imdb_rating', label: 'Rating' },
  { col: 'added_at', label: 'Added' },
  { col: 'play_count', label: 'Plays' },
  { col: 'last_viewed', label: 'Watched' },
  { col: 'runtime', label: 'Runtime' },
] as const;
type SortCol = (typeof SORT_COLUMNS)[number]['col'];
type SortStr = `${SortCol}:asc` | `${SortCol}:desc`;
const SORT_CYCLE = Object.fromEntries(
  SORT_COLUMNS.map((c) => [c.col, { asc: `${c.col}:asc`, desc: `${c.col}:desc` }]),
) as Record<SortCol, { asc: SortStr; desc: SortStr }>;

const CHIP_LABELS: FilterChipLabels = {
  editChip: (f) => `Edit the ${f} filter`,
  clearChip: (f) => `Clear the ${f} filter`,
  addValue: (f) => `Add a ${f} value`,
  removeValue: (f, v) => `Remove ${f} ${v}`,
  valuePlaceholder: 'value…',
  add: 'Add',
  noMatches: 'No matches',
};

function resolveTab(raw: string | null): TabKey {
  return LIBRARY_TABS.some((t) => t.key === raw) ? (raw as TabKey) : 'movies';
}

function parseSort(raw: string | null): { field: SortCol; dir: 'asc' | 'desc' } {
  if (!raw) return { field: 'title', dir: 'asc' };
  const [field, dir] = raw.split(':');
  const known = SORT_COLUMNS.some((c) => c.col === field);
  return { field: known ? (field as SortCol) : 'title', dir: dir === 'desc' ? 'desc' : 'asc' };
}

function LibraryContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = resolveTab(searchParams.get('tab'));
  const activeTab = LIBRARY_TABS.find((t) => t.key === active) ?? LIBRARY_TABS[0];

  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectTab = (key: TabKey) => {
    // Switching media tabs starts fresh: keep only ?tab (drops filter/sort/query params) so a
    // filter set on Movies never leaks into TV/Music and Back/Forward resets too.
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
          <MediaBrowser key={activeTab.key} arrKind={activeTab.arrKind} label={activeTab.label} />
        ) : (
          <MyFixesPanel />
        )}
      </div>
    </>
  );
}

function MediaBrowser({ arrKind, label }: { arrKind: ArrKindName; label: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [query, setQuery] = useState('');
  const [onDisk, setOnDisk] = useState<OnDiskFilter>('any');
  const [wantedOnly, setWantedOnly] = useState(false);

  // Filter + sort state lives in the URL (deep-linkable). Derived here as the source of truth.
  const filters = useMemo<FilterMap<LibraryField>>(() => {
    const out: FilterMap<LibraryField> = {};
    for (const f of FILTER_FIELDS) {
      const raw = searchParams.get(f.param);
      if (raw) out[f.field] = raw.split(',').filter(Boolean);
    }
    return out;
  }, [searchParams]);
  const sort = parseSort(searchParams.get('sort'));
  const sortStr = searchParams.get('sort') as SortStr | null;
  const ratingMinRaw = searchParams.get('rmin');
  const ratingMin = ratingMinRaw ? Number(ratingMinRaw) : undefined;

  // Merge one param change into the URL, preserving ?tab and the other filter/sort params.
  const patchParams = (patch: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') params.delete(k);
      else params.set(k, v);
    }
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const setFilterValues = (field: LibraryField, values: string[]) => {
    const param = FILTER_FIELDS.find((f) => f.field === field)!.param;
    patchParams({ [param]: values.length ? values.join(',') : null });
  };
  const cycleSort = (col: SortCol) => patchParams({ sort: nextSort(sortStr ?? undefined, col, SORT_CYCLE) ?? null });

  const facets = trpc.ledger.filterFacets.useQuery({ arrKind });
  const facetValues = (field: LibraryField): string[] => {
    if (field === 'genres') return facets.data?.genres ?? [];
    if (field === 'requesters') return facets.data?.requesters ?? [];
    if (field === 'sourceCollections') return facets.data?.sourceCollections ?? [];
    return facets.data?.resolutions ?? [];
  };

  const search = trpc.ledger.search.useInfiniteQuery(
    {
      query: query.trim() === '' ? undefined : query.trim(),
      arrKind,
      onDisk,
      ...(wantedOnly ? { wanted: true } : {}),
      sort,
      ...(filters.genres?.length ? { genres: filters.genres } : {}),
      ...(filters.resolutions?.length
        ? { resolutions: filters.resolutions as ('2160p' | '1080p' | '720p' | '576p' | '480p' | 'sd' | 'unknown')[] }
        : {}),
      ...(filters.requesters?.length ? { requesters: filters.requesters } : {}),
      ...(filters.sourceCollections?.length ? { sourceCollections: filters.sourceCollections } : {}),
      ...(ratingMin !== undefined ? { ratingMin } : {}),
      limit: 50,
    },
    {
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      placeholderData: (prev) => prev,
    },
  );

  const items = search.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <div className="library-toolbar">
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
                onClick={() => setOnDisk(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`btn sm${wantedOnly ? ' primary' : ''}`}
            aria-pressed={wantedOnly}
            onClick={() => setWantedOnly((v) => !v)}
          >
            Wanted only
          </button>
          <label className="library-rating">
            Min rating
            <select
              value={ratingMin ?? ''}
              onChange={(e) => patchParams({ rmin: e.target.value || null })}
            >
              <option value="">Any</option>
              <option value="6">6+</option>
              <option value="7">7+</option>
              <option value="8">8+</option>
              <option value="9">9+</option>
            </select>
          </label>
        </div>

        {/* Filter chip bar (ported @hnet/ui engine) — one enum checklist per facet field. */}
        <div className="library-chipbar" role="group" aria-label="Filters">
          {FILTER_FIELDS.map((f) => {
            const values = filters[f.field] ?? [];
            const enumValues = f.field === 'resolutions'
              ? (facetValues(f.field).length ? facetValues(f.field) : Object.keys(RESOLUTION_LABELS))
              : facetValues(f.field);
            return (
              <FilterChip
                key={f.field}
                fieldLabel={f.label}
                values={values}
                kind="enum"
                enumValues={enumValues}
                enumLabel={
                  f.field === 'resolutions' ? (v) => RESOLUTION_LABELS[v] ?? v : undefined
                }
                labels={CHIP_LABELS}
                onAdd={(v) => setFilterValues(f.field, addFilterValue(filters, f.field, v)[f.field] ?? [])}
                onRemove={(v) =>
                  setFilterValues(f.field, removeFilterValue(filters, f.field, v)[f.field] ?? [])
                }
                onClear={() => setFilterValues(f.field, [])}
              />
            );
          })}
        </div>

        {/* Sort control (ported nextSort/arrowFor). */}
        <div className="library-sortbar" role="group" aria-label="Sort">
          <span className="library-sortbar__label">Sort</span>
          {SORT_COLUMNS.map((c) => (
            <button
              key={c.col}
              type="button"
              className={`btn sm${sortStr && sortStr.startsWith(`${c.col}:`) ? ' primary' : ''}`}
              onClick={() => cycleSort(c.col)}
            >
              {c.label}
              {arrowFor(sortStr ?? undefined, c.col, SORT_CYCLE)}
            </button>
          ))}
        </div>
      </div>

      {search.isLoading || search.isPlaceholderData ? (
        <p className="muted">Loading the ledger…</p>
      ) : search.error ? (
        <p className="alert" role="alert">
          Failed to load the library: {search.error.message}
        </p>
      ) : items.length === 0 ? (
        <section className="card empty-state">
          <p>Nothing matches — the ledger fills in as sync runs.</p>
        </section>
      ) : (
        <div className="media-list media-grid">
          {items.map((item) => {
            const disk = onDiskSummary({ ...item, monitored: item.monitored });
            const rating = formatRating(item.metadata.imdbRating ?? item.metadata.tmdbRating);
            return (
              <Link key={item.id} href={`/library/${item.id}`} className="media-card poster-card">
                <MediaPoster posterUrl={item.posterUrl} kind={item.arrKind} alt={item.title} />
                <div className="media-card__body">
                  <span className="media-card__title">
                    {item.title}
                    {item.year !== null ? <span className="muted"> ({item.year})</span> : null}
                  </span>
                  <span className="media-card__badges">
                    <span className="badge badge--muted">{ARR_KIND_LABELS[item.arrKind]}</span>
                    {rating !== null ? <span className="badge badge--info">★ {rating}</span> : null}
                    <span className={`badge badge--${disk.tone}`}>{disk.label}</span>
                    {item.tombstoned ? <span className="badge badge--danger">Removed</span> : null}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {search.hasNextPage ? (
        <div className="load-more">
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

export default function LibraryPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <LibraryContent />
    </Suspense>
  );
}
