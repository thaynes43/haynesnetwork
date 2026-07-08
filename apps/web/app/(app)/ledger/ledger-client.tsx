'use client';

// DESIGN-009 D-08 — the /ledger section UI: Movies/TV/Music/Runs sub-tabs (same tablist +
// ?tab= contract as /library, keyed remount). The three media tabs are each a SPREADSHEET
// table bound to ledgerAdmin.browse — everything that ever was on the server (tombstones
// forced in, D-04); the RUNS tab is the Monitor-&-search run history (owner UX 2026-07-07:
// runs used to be a card BELOW each spreadsheet you scrolled the whole ledger to reach — now
// they're a destination with an All/Movies/TV/Music media filter that rides ledgerAdmin.runs
// server-side, and each run expands in place to its per-item report — a sanctioned ADR-015
// expansion). The media-tab toolbar reuses the /library chip machinery (same engine, same URL
// params) plus the two Ledger-only dims:
//   ?mon=yes|no       the monitored filter        (browse `monitored`)
//   ?file=none|some|all  the completeness facet   (browse `hasFile`; absent = any)
// Sortable headers ride the shared nextSort/arrowFor cycle for the D-09 wire-sort fields the
// table shows (Title / Rating / Added); ?sort= matches /library exactly.
//
// Selection + actions (edit level): row checkboxes + page-level select-all feed a PERSISTENT
// actions bar ("N selected" · Clear · Export filtered · Monitor & search). Monitor & search
// opens a Modal (explanatory multi-outcome confirm — ADR-014 hard rule 8) that submits
// ledgerAdmin.bulkAddAndSearch and then renders the per-item run report (AC-11) keyed off
// ok/outcome/searched (NEVER off error text — DESIGN-009 D-05). Export streams the CURRENT
// FILTER SET (not the selection) from /api/ledger/export (AC-12). Read-Only sees no selection
// column and no Monitor & search (AC-13; the server rejects the mutation regardless).
//
// ADR-015 (no reorientation): the chip bar is the same fixed-height pan-row as /library; the
// actions bar is permanent with constant-width controls (arming nothing ever moves the table);
// selecting a row re-TINTS it (opaque row background var — the sticky cells ride it) without
// reflow; a filter/sort refetch keeps the previous rows rendered (dimmed); the table scrolls
// BOTH axes inside .ledger-tablewrap (sticky header + sticky select/Title columns — the page
// body never scrolls horizontally).
//
// Portrait mobile (owner report 2026-07-07 — the 13-column sheet was a sideways-panning wall):
// below 640px the wrap hides the <table> and shows .ledger-cards — the SAME items rendered as
// condensed stacked cards (title+year+kind on line 1, monitored/on-disk/size/resolution/rating
// on line 2, requester+added muted on line 3). Both renderings live in the ONE .ledger-tablewrap
// scroller so selection state, the refetch dim, and the keyset infinite-scroll sentinel are
// shared verbatim — only the CSS breakpoint swaps which one is painted. The card carries its own
// edge checkbox (a sibling of the body Link, so a tap selects without navigating); tapping the
// body opens the item page. Selecting re-tints the card, never reflows it (ADR-015).
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  FilterChip,
  addFilterValue,
  removeFilterValue,
  filterValues,
  nextSort,
  arrowFor,
  type FilterMap,
} from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import {
  ARR_KIND_LABELS,
  RESOLUTION_LABELS,
  formatBytes,
  formatDay,
  formatRating,
  formatWhen,
  ratingOrNull,
  type ArrKindName,
  type ResolutionName,
} from '@/lib/media';
import {
  classifyRunItem,
  ledgerExportQuery,
  summarizeRun,
  type RunResultEntry,
} from '@/lib/ledger';
import { Modal } from '@/components/modal';
import { CHIP_LABELS, RatingChip } from '@/components/filter-chips';
import { describeMutationError } from '@/lib/app-error';

const MEDIA_TABS = [
  { key: 'movies', label: 'Movies', arrKind: 'radarr' },
  { key: 'tv', label: 'TV', arrKind: 'sonarr' },
  { key: 'music', label: 'Music', arrKind: 'lidarr' },
] as const satisfies ReadonlyArray<{ key: string; label: string; arrKind: ArrKindName }>;

/** The full tablist: the three media spreadsheets + the run-history tab (owner UX
 *  2026-07-07 — Recent runs used to sit BELOW each sheet; now it's a destination). */
const LEDGER_TABS = [
  ...MEDIA_TABS.map(({ key, label }) => ({ key, label })),
  {
    key: 'runs',
    label: 'Runs',
  },
] as const satisfies ReadonlyArray<{ key: string; label: string }>;

type TabKey = (typeof LEDGER_TABS)[number]['key'];

/** The *arr the bulk action writes to — plumbing names are fine HERE (the admin is choosing
 *  which manager receives the adds), unlike the user-facing kind labels. */
const ARR_TARGET_LABELS: Record<ArrKindName, string> = {
  radarr: 'Radarr',
  sonarr: 'Sonarr',
  lidarr: 'Lidarr',
};

/** The user-facing media label per *arr — what the Runs tab rows and filter speak. */
const ARR_MEDIA_LABELS: Record<ArrKindName, string> = {
  radarr: 'Movies',
  sonarr: 'TV',
  lidarr: 'Music',
};

// Shared facet chips — the exact /library set (DESIGN-008 D-11 param contract).
type LedgerField = 'genres' | 'resolutions' | 'requesters' | 'sourceCollections';
const FILTER_FIELDS: ReadonlyArray<{ field: LedgerField; param: string; label: string }> = [
  { field: 'genres', param: 'genre', label: 'Genre' },
  { field: 'resolutions', param: 'res', label: 'Resolution' },
  { field: 'requesters', param: 'req', label: 'Requester' },
  { field: 'sourceCollections', param: 'col', label: 'Collection' },
];

// Ledger-only dims (DESIGN-009 D-04): single-select chips over the same FilterChip skin —
// onAdd REPLACES the value, so the checklist behaves as a radio without new chrome.
const MON_LABELS: Record<string, string> = { yes: 'Yes', no: 'No' };
const HAS_FILE_LABELS: Record<string, string> = { none: 'None', some: 'Some', all: 'All' };
type HasFileValue = 'any' | 'none' | 'some' | 'all';

// The D-09 wire-sort fields this table exposes (the columns that carry them).
const SORT_FIELDS = ['title', 'imdb_rating', 'tmdb_rating', 'added_at'] as const;
type SortField = (typeof SORT_FIELDS)[number];
type SortToken = `${SortField}:${'asc' | 'desc'}`;
const DEFAULT_SORT: SortToken = 'title:asc';

/** ADR-022 D-02 — the server rejects bigger searched runs; the Modal blocks them up front. */
const SEARCH_CAP = 1000;

const RUN_STATUS_LABELS: Record<string, string> = {
  running: 'Running',
  completed: 'Completed',
  completed_with_errors: 'Completed with errors',
  failed: 'Failed',
};

function parseSortToken(raw: string | null): { field: SortField; dir: 'asc' | 'desc' } {
  const [field, dir] = (raw ?? '').split(':');
  if (
    (SORT_FIELDS as readonly string[]).includes(field ?? '') &&
    (dir === 'asc' || dir === 'desc')
  ) {
    return { field: field as SortField, dir };
  }
  return { field: 'title', dir: 'asc' };
}

function parseRatingBound(raw: string | null): number | undefined {
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 10 ? n : undefined;
}

function resolveTab(raw: string | null): TabKey {
  return LEDGER_TABS.some((t) => t.key === raw) ? (raw as TabKey) : 'movies';
}

function LedgerContent({ canEdit }: { canEdit: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = resolveTab(searchParams.get('tab'));
  const activeMedia = MEDIA_TABS.find((t) => t.key === active);

  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectTab = (key: TabKey) => {
    // Same contract as /library: switching tabs keeps ONLY ?tab — a filter set on Movies
    // never leaks into TV/Music (the keyed remount re-reads the clean URL).
    const params = new URLSearchParams();
    params.set('tab', key);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (e.key === 'ArrowRight') next = (index + 1) % LEDGER_TABS.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + LEDGER_TABS.length) % LEDGER_TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = LEDGER_TABS.length - 1;
    else return;
    e.preventDefault();
    const target = LEDGER_TABS[next];
    if (!target) return;
    selectTab(target.key);
    tabRefs.current[next]?.focus();
  };

  return (
    <>
      <h1 className="page-title">Ledger</h1>

      <div className="library-tabs" role="tablist" aria-label="Ledger sections">
        {LEDGER_TABS.map((tab, index) => (
          <button
            key={tab.key}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={`ledgertab-${tab.key}`}
            aria-selected={active === tab.key}
            aria-controls="ledger-panel"
            tabIndex={active === tab.key ? 0 : -1}
            onClick={() => selectTab(tab.key)}
            onKeyDown={(e) => onTabKeyDown(e, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div id="ledger-panel" role="tabpanel" aria-labelledby={`ledgertab-${active}`}>
        {/* Keyed by tab: switching REMOUNTS with fresh state (selection included). */}
        {activeMedia !== undefined ? (
          <LedgerBrowser
            key={activeMedia.key}
            arrKind={activeMedia.arrKind}
            label={activeMedia.label}
            canEdit={canEdit}
          />
        ) : (
          <LedgerRunsTab key="runs" />
        )}
      </div>
    </>
  );
}

/** One media tab's spreadsheet: toolbar (search + chips), the persistent actions bar, and the
 *  both-axis-scrolling table with keyset infinite scroll. All result-shaping state lives in
 *  the URL (contract at the top of this file). */
function LedgerBrowser({
  arrKind,
  label,
  canEdit,
}: {
  arrKind: ArrKindName;
  label: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const utils = trpc.useUtils();

  // ── URL → state (the URL is the single source of truth) ──
  const qParam = searchParams.get('q') ?? '';
  const filters = useMemo<FilterMap<LedgerField>>(() => {
    const out: FilterMap<LedgerField> = {};
    for (const f of FILTER_FIELDS) {
      const vals = [...new Set(searchParams.getAll(f.param).filter((v) => v !== ''))];
      if (vals.length > 0) out[f.field] = vals;
    }
    return out;
  }, [searchParams]);
  const ratingMin = parseRatingBound(searchParams.get('rmin'));
  const ratingMax = parseRatingBound(searchParams.get('rmax'));
  const monRaw = searchParams.get('mon');
  const mon: 'yes' | 'no' | null = monRaw === 'yes' || monRaw === 'no' ? monRaw : null;
  const fileRaw = searchParams.get('file');
  const hasFile: HasFileValue =
    fileRaw === 'none' || fileRaw === 'some' || fileRaw === 'all' ? fileRaw : 'any';
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

  // Search input: local draft debounced 250ms into ?q (the QUERY reads ?q — URL and results
  // always agree; a shared link restores the text). Same mechanism as /library.
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

  const setFieldValues = (field: LedgerField, values: string[]) => {
    const param = FILTER_FIELDS.find((f) => f.field === field)!.param;
    patchParams({ [param]: values.length > 0 ? values : null });
  };

  // ── facets + browse (D-04) ──
  const facets = trpc.ledger.filterFacets.useQuery({ arrKind });
  const facetValues = (field: LedgerField): readonly string[] =>
    facets.data === undefined ? [] : facets.data[field];

  const resolutionsInput = filterValues(filters, 'resolutions').filter((v): v is ResolutionName =>
    Object.hasOwn(RESOLUTION_LABELS, v),
  );
  const trimmedQuery = qParam.trim();
  // The shared filter set — the paged browse, the true-total count (Export label), and the export
  // href all derive from THIS one object, so the three can never disagree about "what's filtered".
  const filterInput = {
    arrKind,
    ...(trimmedQuery === '' ? {} : { query: trimmedQuery }),
    hasFile,
    ...(mon === 'yes' ? { monitored: true } : mon === 'no' ? { monitored: false } : {}),
    ...(filters.genres ? { genres: filters.genres } : {}),
    ...(resolutionsInput.length > 0 ? { resolutions: resolutionsInput } : {}),
    ...(filters.requesters ? { requesters: filters.requesters } : {}),
    ...(filters.sourceCollections ? { sourceCollections: filters.sourceCollections } : {}),
    ...(ratingMin !== undefined ? { ratingMin } : {}),
    ...(ratingMax !== undefined ? { ratingMax } : {}),
  };
  const browse = trpc.ledgerAdmin.browse.useInfiniteQuery(
    { ...filterInput, sort, limit: 100 },
    {
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      // Keep the previous rows rendered (dimmed) while a filter/sort refetch resolves —
      // results swap in place, the table never collapses (ADR-015).
      placeholderData: (prev) => prev,
    },
  );
  // The TRUE filtered total for the Export label (nit fix 2026-07-07): browse is keyset-paged, so
  // items.length only knows the loaded-so-far count ("100+"). This cheap COUNT(*) rides the SAME
  // filter set as the streamed export. placeholderData keeps the last number visible during a
  // refetch (the grid is never blocked while counting).
  const totalCount = trpc.ledgerAdmin.count.useQuery(filterInput, {
    placeholderData: (prev) => prev,
  });

  const items = browse.data?.pages.flatMap((p) => p.items) ?? [];
  const refreshing = browse.isPlaceholderData && browse.isFetching;

  // ── selection (edit level only renders the affordances; the SET is id-keyed) ──
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>());
  // A membership-changing filter edit clears the selection — a hidden stale selection must
  // never ride into the bulk mutation. (Sort only reorders; it keeps the selection.)
  // Render-time adjust (the React "reset state when a prop changes" pattern — no effect).
  const filterSignature = JSON.stringify([
    trimmedQuery,
    filters,
    ratingMin ?? null,
    ratingMax ?? null,
    mon,
    hasFile,
  ]);
  const [prevSignature, setPrevSignature] = useState(filterSignature);
  if (prevSignature !== filterSignature) {
    setPrevSignature(filterSignature);
    setSelected(new Set<string>());
  }
  // Prune the selection to the SETTLED loaded set: a select-all clicked while a refetch was
  // still showing placeholder rows can capture rows the new filter excludes (caught in the
  // self-verify screenshots — "3 selected" over a 2-row sheet). Pagination appends keep every
  // id, so this only ever bites when membership genuinely changed.
  const settledIdsKey =
    browse.isLoading || browse.isPlaceholderData ? null : items.map((i) => i.id).join('|');
  const [prevIdsKey, setPrevIdsKey] = useState<string | null>(null);
  if (settledIdsKey !== null && settledIdsKey !== prevIdsKey) {
    setPrevIdsKey(settledIdsKey);
    if (selected.size > 0) {
      const loaded = new Set(items.map((i) => i.id));
      const pruned = new Set([...selected].filter((id) => loaded.has(id)));
      if (pruned.size !== selected.size) setSelected(pruned);
    }
  }

  const toggleRow = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));
  const someSelected = items.some((i) => selected.has(i.id));
  const toggleAll = () => {
    setSelected(allSelected ? new Set<string>() : new Set(items.map((i) => i.id)));
  };

  // ── sortable headers (the shared nextSort/arrowFor cycle — D-10) ──
  const ratingField: SortField = arrKind === 'radarr' ? 'imdb_rating' : 'tmdb_rating';
  interface Col {
    key: string;
    label: string;
    className?: string;
    sortField?: SortField;
    firstDir?: 'asc' | 'desc';
  }
  const cols: Col[] = [
    { key: 'title', label: 'Title', className: 'col-title', sortField: 'title', firstDir: 'asc' },
    { key: 'year', label: 'Year' },
    { key: 'monitored', label: 'Monitored' },
    { key: 'disk', label: 'On disk' },
    { key: 'size', label: 'Size' },
    { key: 'quality', label: 'Quality' },
    { key: 'root', label: 'Root', className: 'col-root' },
    { key: 'rating', label: 'Rating', sortField: ratingField, firstDir: 'desc' },
    { key: 'votes', label: 'Votes' },
    { key: 'requesters', label: 'Requesters', className: 'col-list' },
    { key: 'collections', label: 'Collections', className: 'col-list' },
    { key: 'removed', label: 'Removed' },
    { key: 'added', label: 'Added', sortField: 'added_at', firstDir: 'desc' },
  ];
  const sortableCols = cols.filter((c) => c.sortField !== undefined);
  // Two-state click cycle per column: first click → firstDir, then it just toggles direction
  // (no cleared state — the active column always shows an arrow; Title A–Z is the reachable
  // default via the Title column).
  const clickCycle = Object.fromEntries(
    sortableCols.map((c) => [
      c.key,
      c.firstDir === 'asc'
        ? { asc: `${c.sortField}:asc` as SortToken, desc: `${c.sortField}:desc` as SortToken }
        : { asc: `${c.sortField}:desc` as SortToken, desc: `${c.sortField}:asc` as SortToken },
    ]),
  ) as Record<string, { asc: SortToken; desc: SortToken }>;
  // Direction-true map for the ▲/▼ glyph + aria-sort.
  const arrowCycle = Object.fromEntries(
    sortableCols.map((c) => [
      c.key,
      { asc: `${c.sortField}:asc` as SortToken, desc: `${c.sortField}:desc` as SortToken },
    ]),
  ) as Record<string, { asc: SortToken; desc: SortToken }>;
  const cycleSort = (colKey: string) => {
    const next = nextSort<SortToken, string>(sortToken, colKey, clickCycle);
    patchParams({ sort: next === DEFAULT_SORT ? null : next });
  };

  // Keyset infinite scroll INSIDE the spreadsheet pane: the wrap is the scroll root, so the
  // sentinel triggers as the user nears the bottom of the internally-scrolling table.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const canLoadMore =
    browse.hasNextPage === true && !browse.isFetchingNextPage && !browse.isPlaceholderData;
  useEffect(() => {
    const el = sentinelRef.current;
    if (el === null || !canLoadMore) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void browse.fetchNextPage();
      },
      { root: wrapRef.current, rootMargin: '400px 0px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canLoadMore]);

  // ── export (AC-12): the CURRENT FILTER SET, never the selection ── (same filterInput as the
  // browse + the count, so the href, the label, and the streamed rows all describe one set).
  const exportQs = ledgerExportQuery(filterInput);
  // The Export label now shows the TRUE filtered total (ledgerAdmin.count), not the loaded-so-far
  // page count — a "…" only until the first count resolves, then the exact number.
  const total = totalCount.data?.count;
  const countLabel =
    total === undefined ? '…' : `${total.toLocaleString()} ${total === 1 ? 'row' : 'rows'}`;

  // ── the Monitor & search Modal (ADR-014 explanatory confirm → AC-11 report) ──
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [searchOnAdd, setSearchOnAdd] = useState(true);
  const [runId, setRunId] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  // Titles snapshotted at open time so the report can name SKIPPED items too (skip entries
  // are persisted without a title and never enter the run's preview).
  const [titleById, setTitleById] = useState<ReadonlyMap<string, string>>(() => new Map());

  const bulk = trpc.ledgerAdmin.bulkAddAndSearch.useMutation({
    onError: (err: unknown) => setModalError(describeMutationError(err)),
    onSuccess: ({ runId: id }) => {
      setModalError(null);
      setRunId(id);
      setSelected(new Set<string>());
      void utils.ledgerAdmin.runs.invalidate();
      void utils.ledgerAdmin.browse.invalidate(); // monitored flags / tombstones changed
    },
  });

  const openConfirm = () => {
    setTitleById(new Map(items.filter((i) => selected.has(i.id)).map((i) => [i.id, i.title])));
    setSearchOnAdd(true);
    setModalError(null);
    setRunId(null);
    setConfirmOpen(true);
  };
  const closeModal = () => {
    if (bulk.isPending) return;
    setConfirmOpen(false);
    setRunId(null);
    setModalError(null);
  };
  const overCap = selected.size > SEARCH_CAP;
  const selectionIds = useMemo(() => [...selected], [selected]);

  const colCount = cols.length;
  const target = ARR_TARGET_LABELS[arrKind];
  // The portrait-card kind badge (Movie / TV / Music) — the tab context is lost once a row is a
  // detached card, so each card re-states its kind.
  const kindLabel = ARR_KIND_LABELS[arrKind];

  return (
    <>
      <div className="library-toolbar">
        <div className="library-controls">
          <input
            type="search"
            className="library-search"
            placeholder={`Search ${label.toLowerCase()}…`}
            aria-label="Search the ledger"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {/* Filter chip bar — the /library engine verbatim, plus the two Ledger-only dims as
            single-select chips (same skin; onAdd replaces, so the checklist acts as a radio).
            Fixed-height pan-row; editors overlay (ADR-015). */}
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
          <FilterChip
            fieldLabel="Monitored"
            values={mon === null ? [] : [mon]}
            kind="enum"
            enumValues={['yes', 'no']}
            enumLabel={(v) => MON_LABELS[v] ?? v}
            labels={CHIP_LABELS}
            onAdd={(v) => patchParams({ mon: v })}
            onRemove={() => patchParams({ mon: null })}
            onClear={() => patchParams({ mon: null })}
          />
          <FilterChip
            fieldLabel="Has file"
            values={hasFile === 'any' ? [] : [hasFile]}
            kind="enum"
            enumValues={['none', 'some', 'all']}
            enumLabel={(v) => HAS_FILE_LABELS[v] ?? v}
            labels={CHIP_LABELS}
            onAdd={(v) => patchParams({ file: v })}
            onRemove={() => patchParams({ file: null })}
            onClear={() => patchParams({ file: null })}
          />
        </div>
      </div>

      {/* Persistent actions bar (ADR-015: always rendered, constant-width controls — selection
          changes recolor/recount, they never move the table). Export rides the FILTER. */}
      <div className="ledger-actionsbar" role="toolbar" aria-label="Ledger actions">
        {canEdit ? (
          <>
            <span className="ledger-actionsbar__count" data-testid="ledger-selected-count">
              {selected.size} selected
            </span>
            <button
              type="button"
              className="btn sm"
              disabled={selected.size === 0}
              onClick={() => setSelected(new Set<string>())}
            >
              Clear
            </button>
          </>
        ) : (
          <span className="ledger-actionsbar__count muted">Browse &amp; export</span>
        )}
        <span className="ledger-actionsbar__spacer" />
        <a
          className="btn sm ledger-exportbtn"
          href={`/api/ledger/export?${exportQs}`}
          download
          data-testid="ledger-export"
          title="Download the current filter set as JSONL (not just the selection)"
        >
          Export filtered ({countLabel})
        </a>
        {canEdit ? (
          <button
            type="button"
            className="btn sm primary"
            data-testid="ledger-bulk-open"
            disabled={selected.size === 0}
            onClick={openConfirm}
          >
            Monitor &amp; search…
          </button>
        ) : null}
      </div>

      {/* The spreadsheet pane: BOTH axes scroll in here (sticky header row + sticky select/
          Title columns), so the page body never scrolls horizontally (hard rule / ADR-015). */}
      <div
        ref={wrapRef}
        className={`ledger-tablewrap${refreshing ? ' is-refreshing' : ''}`}
        data-testid="ledger-tablewrap"
      >
        <table
          className={`ledger-table${canEdit ? '' : ' ledger-table--noselect'}`}
          aria-busy={refreshing}
          aria-label={`${label} ledger`}
        >
          <thead>
            <tr>
              {cols.map((c) => {
                const isActive = c.sortField !== undefined && sort.field === c.sortField;
                const sortButton =
                  c.sortField !== undefined ? (
                    <button
                      type="button"
                      className={`sort-btn ledger-sort${isActive ? ' is-active' : ''}`}
                      onClick={() => cycleSort(c.key)}
                    >
                      {c.label}
                      {/* fixed-width slot: the arrow appearing never nudges neighbors (ADR-015) */}
                      <span className="sort-btn__arrow" aria-hidden="true">
                        {arrowFor<SortToken, string>(sortToken, c.key, arrowCycle).trim()}
                      </span>
                    </button>
                  ) : (
                    c.label
                  );
                return (
                  <th
                    key={c.key}
                    scope="col"
                    className={c.className}
                    aria-sort={
                      isActive ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined
                    }
                  >
                    {c.key === 'title' && canEdit ? (
                      // The select-all box rides the frozen Title column (one sticky pane —
                      // no offset drift between two frozen columns under auto table layout).
                      <span className="ledger-titlecell">
                        <input
                          type="checkbox"
                          className="ledger-check"
                          aria-label="Select all loaded rows"
                          checked={allSelected}
                          ref={(el) => {
                            if (el) el.indeterminate = someSelected && !allSelected;
                          }}
                          onChange={toggleAll}
                        />
                        {sortButton}
                      </span>
                    ) : (
                      sortButton
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          {browse.isLoading ? (
            // Initial load: skeleton rows hold the table geometry — never a collapsing spinner.
            <tbody data-testid="ledger-skeleton" aria-hidden="true">
              {Array.from({ length: 8 }, (_, i) => (
                <tr key={i} className="ledger-row">
                  {cols.map((c) => (
                    <td key={c.key} className={c.className}>
                      <span
                        className={`skeleton-line${c.key === 'title' ? '' : ' skeleton-line--short'}`}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ) : browse.error ? (
            <tbody>
              <tr>
                <td colSpan={colCount}>
                  <p className="alert" role="alert">
                    Failed to load the ledger: {browse.error.message}
                  </p>
                </td>
              </tr>
            </tbody>
          ) : items.length === 0 ? (
            <tbody>
              <tr>
                <td colSpan={colCount} className="ledger-empty muted">
                  Nothing matches — loosen the filters (the Ledger holds everything that ever was on
                  the server, removed items included).
                </td>
              </tr>
            </tbody>
          ) : (
            <tbody>
              {items.map((item) => {
                const rating = formatRating(
                  ratingOrNull(item.metadata.imdbRating) ?? ratingOrNull(item.metadata.tmdbRating),
                );
                const votes = item.metadata.imdbVotes ?? item.metadata.tmdbVotes;
                const disk =
                  item.expectedFileCount > 0
                    ? `${item.onDiskFileCount}/${item.expectedFileCount}`
                    : String(item.onDiskFileCount);
                const isSelected = selected.has(item.id);
                return (
                  <tr key={item.id} className={`ledger-row${isSelected ? ' is-selected' : ''}`}>
                    <td className="col-title">
                      <span className="ledger-titlecell">
                        {canEdit ? (
                          <input
                            type="checkbox"
                            className="ledger-check"
                            aria-label={`Select ${item.title}`}
                            checked={isSelected}
                            onChange={() => toggleRow(item.id)}
                          />
                        ) : null}
                        <Link
                          href={`/library/${item.id}?from=ledger`}
                          className="ledger-title"
                          title={item.title}
                        >
                          {item.title}
                        </Link>
                      </span>
                    </td>
                    <td className="col-num">{item.year ?? '—'}</td>
                    <td className="col-center">
                      {item.monitored ? (
                        <span className="ledger-yes" title="Monitored">
                          ✓
                        </span>
                      ) : (
                        <span className="muted" title="Not monitored">
                          —
                        </span>
                      )}
                    </td>
                    <td className="col-num">{disk}</td>
                    <td className="col-num">
                      {item.sizeOnDisk > 0 ? formatBytes(item.sizeOnDisk) : '—'}
                    </td>
                    <td>{item.qualityProfileName}</td>
                    <td className="col-root" title={item.rootFolder}>
                      {item.rootFolder}
                    </td>
                    <td className="col-num">{rating !== null ? `★ ${rating}` : '—'}</td>
                    <td className="col-num">
                      {votes !== null && votes > 0 ? votes.toLocaleString() : '—'}
                    </td>
                    <td className="col-list" title={item.metadata.requesters.join(', ')}>
                      {item.metadata.requesters.length > 0
                        ? item.metadata.requesters.join(', ')
                        : '—'}
                    </td>
                    <td className="col-list" title={item.metadata.sourceCollections.join(', ')}>
                      {item.metadata.sourceCollections.length > 0
                        ? item.metadata.sourceCollections.join(', ')
                        : '—'}
                    </td>
                    <td>
                      {item.tombstonedAt !== null ? (
                        <span className="ledger-removed">{formatDay(item.tombstonedAt)}</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{formatDay(item.metadata.addedAt ?? item.addedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          )}
        </table>

        {/* Portrait mobile (<640px): the SAME items as condensed stacked cards. Lives in the one
            .ledger-tablewrap scroller with the table (CSS swaps which is painted), so selection,
            the refetch dim, and the infinite-scroll sentinel below are shared. */}
        <ul className="ledger-cards" data-testid="ledger-cards" aria-busy={refreshing}>
          {browse.isLoading ? (
            // Skeleton cards hold the list geometry on mobile — never a collapsing spinner.
            Array.from({ length: 5 }, (_, i) => (
              <li key={i} className="ledger-card ledger-card--skeleton" aria-hidden="true">
                <span className="skeleton-line" />
                <span className="skeleton-line skeleton-line--short" />
                <span className="skeleton-line skeleton-line--short" />
              </li>
            ))
          ) : browse.error ? (
            <li className="ledger-cards__state">
              <p className="alert" role="alert">
                Failed to load the ledger: {browse.error.message}
              </p>
            </li>
          ) : items.length === 0 ? (
            <li className="ledger-cards__state muted" data-testid="ledger-cards-empty">
              Nothing matches — loosen the filters (the Ledger holds everything that ever was on the
              server, removed items included).
            </li>
          ) : (
            items.map((item) => {
              const rating = formatRating(
                ratingOrNull(item.metadata.imdbRating) ?? ratingOrNull(item.metadata.tmdbRating),
              );
              const disk =
                item.expectedFileCount > 0
                  ? `${item.onDiskFileCount}/${item.expectedFileCount}`
                  : String(item.onDiskFileCount);
              const resLabel =
                item.metadata.resolution !== null && item.metadata.resolution !== ''
                  ? (RESOLUTION_LABELS[item.metadata.resolution] ?? item.metadata.resolution)
                  : null;
              const requesters = item.metadata.requesters;
              const isSelected = selected.has(item.id);
              return (
                <li key={item.id} className="ledger-cardrow">
                  <div
                    className={`ledger-card${isSelected ? ' is-selected' : ''}`}
                    data-testid="ledger-card"
                  >
                    {canEdit ? (
                      // Edge tap target — a SIBLING of the body Link, so a tap selects without
                      // navigating (no nested interactive).
                      <label className="ledger-card__check">
                        <input
                          type="checkbox"
                          className="ledger-check"
                          aria-label={`Select ${item.title}`}
                          checked={isSelected}
                          onChange={() => toggleRow(item.id)}
                        />
                      </label>
                    ) : null}
                    <Link
                      href={`/library/${item.id}`}
                      className="ledger-card__body"
                      data-testid="ledger-card-link"
                    >
                      <span className="ledger-card__l1">
                        <span className="ledger-card__title">{item.title}</span>
                        {item.year !== null ? (
                          <span className="ledger-card__year">({item.year})</span>
                        ) : null}
                        <span className="badge badge--muted ledger-card__kind">{kindLabel}</span>
                        {item.tombstonedAt !== null ? (
                          <span className="badge badge--danger ledger-card__removed">Removed</span>
                        ) : null}
                      </span>
                      <span className="ledger-card__l2">
                        {/* Monitored is the norm → the green ✓ carries it (matches the sheet's
                            Monitored column); the noteworthy exception gets a full muted word. */}
                        {item.monitored ? (
                          <span
                            className="ledger-card__fact ledger-yes"
                            title="Monitored"
                            aria-label="Monitored"
                          >
                            ✓
                          </span>
                        ) : (
                          <span className="ledger-card__fact muted" title="Not monitored">
                            Unmonitored
                          </span>
                        )}
                        <span className="ledger-card__fact">{disk} files</span>
                        {item.sizeOnDisk > 0 ? (
                          <span className="ledger-card__fact">{formatBytes(item.sizeOnDisk)}</span>
                        ) : null}
                        {resLabel !== null ? (
                          <span className="ledger-card__fact">{resLabel}</span>
                        ) : null}
                        {rating !== null ? (
                          <span className="ledger-card__fact">★ {rating}</span>
                        ) : null}
                      </span>
                      <span className="ledger-card__l3 muted">
                        {requesters.length > 0 ? `${requesters.join(', ')} · ` : ''}Added{' '}
                        {formatDay(item.metadata.addedAt ?? item.addedAt)}
                      </span>
                    </Link>
                  </div>
                </li>
              );
            })
          )}
        </ul>

        {browse.hasNextPage === true ? (
          <div className="load-more" ref={sentinelRef}>
            <button
              type="button"
              className="btn"
              disabled={browse.isFetchingNextPage}
              onClick={() => void browse.fetchNextPage()}
            >
              {browse.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          </div>
        ) : null}
      </div>

      <Modal
        open={confirmOpen}
        title={runId === null ? `Monitor & search in ${target}` : 'Run report'}
        onClose={closeModal}
        banner={
          modalError ? (
            <p className="alert" role="alert">
              {modalError}
            </p>
          ) : null
        }
      >
        {runId === null ? (
          <div className="ledger-confirm">
            <p>
              <strong>{selected.size}</strong> selected item{selected.size === 1 ? '' : 's'} →{' '}
              <strong>{target}</strong>. Per item:
            </p>
            <ul className="ledger-confirm__outcomes">
              <li>
                <strong>Not in {target}</strong> — added <em>monitored</em> with its recorded
                quality profile, root folder, and tags.
              </li>
              <li>
                <strong>Present but unmonitored</strong> — switched to monitored in place.
              </li>
              <li>
                <strong>Already monitored</strong> — skipped, nothing changes.
              </li>
            </ul>
            <label className="check-row">
              <input
                type="checkbox"
                checked={searchOnAdd}
                onChange={(e) => setSearchOnAdd(e.target.checked)}
              />
              <span>Trigger a search for each added or newly-monitored item</span>
            </label>
            {overCap ? (
              <p className="alert" role="alert">
                Runs are capped at {SEARCH_CAP.toLocaleString()} items and{' '}
                {selected.size.toLocaleString()} are selected — narrow the filter set (e.g. by
                rating tier or requester) and run in batches.
              </p>
            ) : null}
            <div className="form-actions">
              <button
                type="button"
                className="btn primary"
                data-testid="ledger-bulk-submit"
                disabled={bulk.isPending || overCap || selected.size === 0}
                onClick={() => bulk.mutate({ arrKind, mediaItemIds: selectionIds, searchOnAdd })}
              >
                {bulk.isPending
                  ? 'Working…'
                  : `Monitor & search ${selected.size} item${selected.size === 1 ? '' : 's'}`}
              </button>
              <button type="button" className="btn" disabled={bulk.isPending} onClick={closeModal}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <RunReport runId={runId} titleById={titleById} onClose={closeModal} />
        )}
      </Modal>
    </>
  );
}

/** AC-11 — the per-item run report (read from ledgerAdmin.run; reason-scoped server-side).
 *  Outcomes key off ok/outcome/searched — an added-but-search-throttled item reads as a
 *  SUCCESS with a search caution, never as a failure (DESIGN-009 D-05). */
function RunReport({
  runId,
  titleById,
  onClose,
}: {
  runId: string;
  titleById?: ReadonlyMap<string, string>;
  onClose?: () => void;
}) {
  const report = trpc.ledgerAdmin.run.useQuery({ id: runId });
  if (report.isLoading) return <p className="muted">Loading the report…</p>;
  if (report.error) {
    return (
      <p className="alert" role="alert">
        Failed to load the report: {report.error.message}
      </p>
    );
  }
  const run = report.data!;
  const entries = run.results as RunResultEntry[];
  const previewTitles = new Map(run.preview.map((p) => [p.mediaItemId, p.title]));
  const s = summarizeRun(entries);
  const statusTone =
    run.status === 'completed' ? 'ok' : run.status === 'failed' ? 'danger' : 'warn';

  const OUTCOME_BADGES: Record<string, { label: string; tone: string }> = {
    added: { label: 'added', tone: 'ok' },
    monitored: { label: 'monitored', tone: 'info' },
    skipped: { label: 'skipped', tone: 'muted' },
    failed: { label: 'failed', tone: 'danger' },
  };

  return (
    <div className="ledger-report" data-testid="ledger-run-report">
      <p className="ledger-report__meta">
        <span className={`badge badge--${statusTone}`}>
          {RUN_STATUS_LABELS[run.status] ?? run.status}
        </span>{' '}
        <span className="muted">
          {ARR_TARGET_LABELS[run.arrKind as ArrKindName]} · {formatWhen(run.startedAt)}
          {run.initiatedByDisplayName !== null ? ` · by ${run.initiatedByDisplayName}` : ''}
        </span>
      </p>
      {/* Count badges wear their tone only when non-zero — a red "0 failed" (or a bright
          "0 added") reads as an alarm/result it isn't. */}
      <p className="ledger-report__summary" data-testid="ledger-run-summary">
        <span className={`badge badge--${s.added > 0 ? 'ok' : 'muted'}`}>{s.added} added</span>{' '}
        <span className={`badge badge--${s.monitored > 0 ? 'info' : 'muted'}`}>
          {s.monitored} monitored
        </span>{' '}
        <span className="badge badge--muted">{s.skipped} skipped</span>{' '}
        <span className={`badge badge--${s.failed > 0 ? 'danger' : 'muted'}`}>
          {s.failed} failed
        </span>{' '}
        <span className="muted">
          {s.searched} search command{s.searched === 1 ? '' : 's'} sent
        </span>
      </p>
      {entries.length === 0 ? (
        <p className="muted">Nothing to do — every selected item was already handled.</p>
      ) : (
        <table className="admin-table ledger-report__table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Outcome</th>
              <th>Search</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, i) => {
              const c = classifyRunItem(entry);
              const badge = OUTCOME_BADGES[c.kind]!;
              const title =
                titleById?.get(entry.mediaItemId) ??
                previewTitles.get(entry.mediaItemId) ??
                '(unknown item)';
              return (
                <tr key={`${entry.mediaItemId}-${i}`}>
                  <td data-label="Item">{title}</td>
                  <td data-label="Outcome">
                    <span className={`badge badge--${badge.tone}`}>{badge.label}</span>
                    {c.kind !== 'added' && c.kind !== 'monitored' && c.note !== null ? (
                      <>
                        {' '}
                        <span className="muted">{c.note}</span>
                      </>
                    ) : null}
                  </td>
                  <td data-label="Search">
                    {c.searched ? (
                      <span className="badge badge--info">searched</span>
                    ) : c.searchFailed ? (
                      <>
                        <span className="badge badge--warn">search failed</span>
                        {c.note !== null ? <span className="muted"> {c.note}</span> : null}
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {onClose !== undefined ? (
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The Runs tab's media-type filter row: All plus one entry per media tab. `key` is the
 *  ?kind= URL token; `arrKind` (absent on All) is passed to ledgerAdmin.runs server-side so
 *  the newest-first window and the filter always agree. */
interface RunFilter {
  key: string;
  label: string;
  /** Absent on All — the query then narrows nothing. */
  arrKind?: ArrKindName;
}
const RUN_FILTERS: readonly RunFilter[] = [
  { key: 'all', label: 'All' },
  ...MEDIA_TABS.map(({ key, label, arrKind }) => ({ key, label, arrKind })),
];

/** The Runs tab (owner UX 2026-07-07): the FULL run history as its own destination — every
 *  reason='ledger_add' run, newest first, each row expanding IN PLACE to the same per-item
 *  report the post-submit Modal shows (a sanctioned ADR-015 expansion, like the catalog
 *  inline editor). Filter state rides the URL (?kind=), like every other Ledger dim; a tab
 *  switch keeps only ?tab, so filters never leak between tabs. Read-Only sees this tab too —
 *  runs are a read surface (the CREATING action stays edit-gated on the media tabs). Runs are
 *  synchronous end-to-end, so fetch-on-load is honest — no polling. */
function LedgerRunsTab() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const kindRaw = searchParams.get('kind');
  const filter = RUN_FILTERS.find((f) => f.key === kindRaw) ?? RUN_FILTERS[0]!;
  const setKind = (key: string) => {
    const params = new URLSearchParams(window.location.search);
    if (key === 'all') params.delete('kind');
    else params.set('kind', key);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const runs = trpc.ledgerAdmin.runs.useQuery(
    filter.arrKind === undefined ? {} : { arrKind: filter.arrKind },
    // A filter switch keeps the previous rows rendered (dimmed) while the refetch resolves —
    // the list swaps in place, it never collapses (ADR-015).
    { placeholderData: (prev) => prev },
  );
  const refreshing = runs.isPlaceholderData && runs.isFetching;

  // Which runs are expanded to their report (id-keyed — filter switches keep them open).
  const [openRunIds, setOpenRunIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const toggleRun = (id: string) => {
    setOpenRunIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <>
      {/* The media-type filter: a single-select pill row (aria-pressed radios). Constant
          label widths — switching recolors the pills and dims the list, nothing moves. */}
      <div className="ledger-runsbar" role="group" aria-label="Filter runs by media type">
        {RUN_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`ledger-runfilter${filter.key === f.key ? ' is-active' : ''}`}
            aria-pressed={filter.key === f.key}
            onClick={() => setKind(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div
        className={`ledger-runlist${refreshing ? ' is-refreshing' : ''}`}
        data-testid="ledger-runs"
        aria-busy={refreshing}
      >
        {runs.isLoading ? (
          // Skeleton cards hold the list geometry — never a collapsing spinner (ADR-015).
          <div
            className="ledger-runlist__skeleton"
            data-testid="ledger-runs-skeleton"
            aria-hidden="true"
          >
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="ledger-runcard">
                <div className="ledger-runcard__head">
                  <span className="skeleton-line" />
                  <span className="skeleton-line skeleton-line--short" />
                </div>
              </div>
            ))}
          </div>
        ) : runs.error ? (
          <p className="alert" role="alert">
            Failed to load runs: {runs.error.message}
          </p>
        ) : (runs.data ?? []).length === 0 ? (
          <p className="muted ledger-runsempty" data-testid="ledger-runs-empty">
            {filter.arrKind === undefined
              ? 'No runs yet — a bulk Monitor & search from a media tab creates a run.'
              : `No ${filter.label} runs yet — a bulk Monitor & search from the ${filter.label} tab creates one.`}
          </p>
        ) : (
          (runs.data ?? []).map((run) => {
            const open = openRunIds.has(run.id);
            const s = run.summary;
            return (
              <div key={run.id} className="ledger-runcard">
                <button
                  type="button"
                  className="ledger-runcard__head"
                  aria-expanded={open}
                  onClick={() => toggleRun(run.id)}
                >
                  <span className="ledger-runcard__chevron" aria-hidden="true">
                    ▸
                  </span>
                  <span className="ledger-runcard__when">{formatWhen(run.startedAt)}</span>
                  <span className="badge badge--muted ledger-runcard__kind">
                    {ARR_MEDIA_LABELS[run.arrKind as ArrKindName]}
                  </span>
                  <span
                    className={`badge badge--${
                      run.status === 'completed'
                        ? 'ok'
                        : run.status === 'failed'
                          ? 'danger'
                          : run.status === 'running'
                            ? 'info'
                            : 'warn'
                    }`}
                  >
                    {RUN_STATUS_LABELS[run.status] ?? run.status}
                  </span>
                  {/* The report's count language, toned only when non-zero (a red "0 failed"
                      reads as an alarm it isn't). */}
                  <span className="ledger-runcard__counts">
                    <span className={`badge badge--${s.added > 0 ? 'ok' : 'muted'}`}>
                      {s.added} added
                    </span>{' '}
                    <span className={`badge badge--${s.monitored > 0 ? 'info' : 'muted'}`}>
                      {s.monitored} monitored
                    </span>{' '}
                    <span className="badge badge--muted">{s.skipped} skipped</span>{' '}
                    <span className={`badge badge--${s.failed > 0 ? 'danger' : 'muted'}`}>
                      {s.failed} failed
                    </span>
                  </span>
                  <span className="ledger-runcard__by muted">
                    {run.initiatedByDisplayName !== null ? `by ${run.initiatedByDisplayName}` : '—'}
                  </span>
                </button>
                {open ? (
                  <div className="ledger-runcard__report">
                    <RunReport runId={run.id} />
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

export function LedgerClient({ canEdit }: { canEdit: boolean }) {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <LedgerContent canEdit={canEdit} />
    </Suspense>
  );
}
