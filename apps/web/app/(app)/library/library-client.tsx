'use client';

// DESIGN-005 D-17 / DESIGN-008 D-11 — /library: WAI-ARIA sub-tabs (Movies · TV · Music ·
// My Fixes, default Movies). Each media tab renders a POSTER-CARD GRID (fixed 2:3 boxes,
// ADR-019 authed poster proxy, KindIcon fallback) over the extended ledger.search, with a
// filter CHIP BAR + SORT control built on the ported @hnet/ui filter engine (D-10) and the
// facet values from ledger.filterFacets. Cards stay ACTION-FREE click-throughs to
// /library/[id] (owner ruling 2026-07-04) — the grid carries badges only.
//
// PLAN-029 (ADR-051/052/053, DESIGN-026) — the walls are now REGISTRY-DRIVEN: each wall's sort
// keys + facet chips come from lib/library-view-registry.ts (the per-(wall, view-level) capability
// declaration — a level offers ONLY the dimensions it can answer, R5 "Episodes ≠ Shows"), and the
// effective view/sort resolves per ADR-052: an explicit URL param WINS (shared-link fidelity, never
// written back), a bare URL fills from the caller's stored preference (library.preferences.getAll),
// else the R2/R6 default. Explicit user selections persist via library.preferences.set — only ever
// from event handlers, never on render.
//
// URL-state contract (deep-linkable, Back/Forward safe — documented in DESIGN-008 D-11 + D-10):
//   ?tab=movies|tv|music|…|my-fixes         the sub-tab (PUSH — a screen-level switch, D-19)
//   ?q=…                                    search text (input debounced 250ms → URL)
//   ?disk=complete|partial|none             on-disk narrowing ('any' = absent)
//   ?wanted=1                               the wanted-only toggle (Movies/TV; the book walls
//                                           use the PLAN-056 three-state ?wanted=only|hide)
//   ?genre=…&genre=… / res / req / col      facet filters (REPEATED params — comma-safe)
//   ?decade=1990&decade=2000                the Decade facet (PLAN-029 — decade-start years)
//   ?rfrom=2020-01-01&rto=2021-12-31        the Release-Date range facet (PLAN-029, inclusive)
//   ?rmin=7&rmax=9                          the bounded rating chip (COALESCE imdb/tmdb, D-09)
//   ?watch=watched|unwatched|in_progress    the per-user watch-state facet (PLAN-029, gated)
//   ?at=m                                   the A–Z jump (PLAN-029 D-09; asc Title sorts only)
//   ?sort=field:dir                         wire sort (absent = the stored/R6 default)
// Every filter/sort edit uses router.replace — the URL always mirrors the state (shareable),
// while Back/Forward cross SCREENS (tabs / views), not individual filter edits. Switching media
// tabs keeps ONLY ?tab (fresh start per tab; the keyed remount below re-reads the now-clean URL),
// so a filter set on Movies never leaks into TV/Music.
//
// ADR-015 (no reorientation): the chip bar and sort bar are FIXED-HEIGHT single rows that
// scroll horizontally when crowded — adding/removing chips or wrapping never shifts the grid;
// chip editors are viewport-clamped fixed-position OVERLAYS; poster boxes reserve their 2:3
// space; the A–Z rail is a fixed overlay; a filter/sort refetch keeps the previous grid rendered
// (dimmed) and the initial load shows skeleton poster boxes — never a spinner that collapses.
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Fragment, Suspense, useEffect, useRef, useState } from 'react';
import {
  FilterChip,
  addFilterValue,
  removeFilterValue,
  filterValues,
  nextSort,
  arrowFor,
  type FilterMap,
} from '@hnet/ui';
import type { LibrarySortField, WallPreference } from '@hnet/api';
import { trpc } from '@/lib/trpc-client';
import {
  RESOLUTION_LABELS,
  formatRating,
  onDiskSummary,
  ratingOrNull,
  type ArrKindName,
  type ResolutionName,
} from '@/lib/media';
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
  orderCollectionCategories,
  WALL_VIEWS,
  WATCH_STATE_OPTIONS,
  decadeLabel,
  registryFor,
  type ViewLevelKey,
  type ViewRegistryEntry,
  type WallGrouping,
} from '@/lib/library-view-registry';
import { MediaAction } from '@hnet/ui';
import { GroupCard, MediaCard, PosterGrid, PosterGridSkeleton } from '@/components/cards';
import { ForceSearchDialog } from './[id]/force-search-dialog';
import { MyFixesPanel } from '@/components/my-fixes-panel';
import { ActivityPanel } from './activity-panel';
import { CHIP_LABELS, DateRangeChip, RatingChip, SelectChip } from '@/components/filter-chips';
import { LetterJumpBar } from '@/components/letter-jump-bar';
import { YtdlsubBrowser } from './ytdlsub-browser';
import { BooksBrowser } from './books-browser';

const MEDIA_TABS = [
  { key: 'movies', label: 'Movies', arrKind: 'radarr' },
  { key: 'tv', label: 'TV', arrKind: 'sonarr' },
  { key: 'music', label: 'Music', arrKind: 'lidarr' },
] as const satisfies ReadonlyArray<{ key: string; label: string; arrKind?: ArrKindName }>;

// ADR-038 / DESIGN-017 (PLAN-022) — the ytdl-sub Library sub-tabs (Peloton, YouTube). Spliced into the
// visible tab set ONLY when the caller can see the `ytdlsub` section (server-resolved in page.tsx and
// passed down as `ytdlsubVisible`). They read the k8plex Plex libraries directly (no *arr, no ledger).
const YTDLSUB_TABS = [
  { key: 'peloton', label: 'Peloton', arrKind: undefined },
  { key: 'youtube', label: 'YouTube', arrKind: undefined },
] as const satisfies ReadonlyArray<{ key: string; label: string; arrKind?: ArrKindName }>;

// ADR-046 / DESIGN-024 (PLAN-023) — the Books Library sub-tabs (Books, Audiobooks, Comics). Spliced in
// AFTER the ytdl-sub tabs (i.e. after YouTube) ONLY when the caller can see the `books` section
// (server-resolved in page.tsx, passed as `booksVisible`). They read the app-owned books_items ledger.
const BOOKS_TABS = [
  { key: 'books', label: 'Books', arrKind: undefined },
  { key: 'audiobooks', label: 'Audiobooks', arrKind: undefined },
  { key: 'comics', label: 'Comics', arrKind: undefined },
] as const satisfies ReadonlyArray<{ key: string; label: string; arrKind?: ArrKindName }>;

/** Each Books sub-tab's books_items media_kind. */
const BOOKS_TAB_KINDS: Record<(typeof BOOKS_TABS)[number]['key'], 'book' | 'audiobook' | 'comic'> =
  {
    books: 'book',
    audiobooks: 'audiobook',
    comics: 'comic',
  };

// ADR-059 / DESIGN-030 (PLAN-048) — the cross-library Activity sub-tab (the Trash→Activity idiom). Like My
// Fixes it is ALWAYS-ON (no section id gates the Library shell); the `activity.list` resolver does the
// per-item section gating server-side, so a role that can see nothing gets an empty Activity, never a
// forbidden tab. Sits after Books, before My Fixes.
const ACTIVITY_TAB = { key: 'activity', label: 'Activity', arrKind: undefined } as const satisfies {
  key: string;
  label: string;
  arrKind?: ArrKindName;
};

// DESIGN-017 D-08 (owner ruling 2026-07-10) — My Fixes is a personal utility view, not a library:
// it sits LAST, after the media tabs, the ytdl-sub tabs, and the Books tabs.
const MY_FIXES_TAB = { key: 'my-fixes', label: 'My Fixes', arrKind: undefined } as const satisfies {
  key: string;
  label: string;
  arrKind?: ArrKindName;
};

type TabKey =
  | (typeof MEDIA_TABS)[number]['key']
  | (typeof YTDLSUB_TABS)[number]['key']
  | (typeof BOOKS_TABS)[number]['key']
  | (typeof ACTIVITY_TAB)['key']
  | (typeof MY_FIXES_TAB)['key'];
type YtdlsubTabKey = (typeof YTDLSUB_TABS)[number]['key'];
type BooksTabKey = (typeof BOOKS_TABS)[number]['key'];

// ADR-047 (PLAN-028) — server-resolved per-Plex-library tab visibility (a withheld library's tab hides).
type MediaVisible = { movies: boolean; tv: boolean; music: boolean };
type YtdlsubLibsVisible = { peloton: boolean; youtube: boolean };

/** The ledger walls' *arr kind → preference-wall mapping (ADR-052 LIBRARY_WALLS). */
const ARR_WALLS: Record<ArrKindName, LibraryWallId> = {
  radarr: 'movies',
  sonarr: 'tv',
  lidarr: 'music',
};

const ON_DISK_FILTERS = [
  { value: 'any', label: 'Any' },
  { value: 'complete', label: 'Complete' },
  { value: 'partial', label: 'Partial' },
  { value: 'none', label: 'Missing' },
] as const;

type OnDiskFilter = (typeof ON_DISK_FILTERS)[number]['value'];

// DESIGN-026 D-02 — the ledger walls' ENUM facet plumbing: each registry facet key maps to its URL
// param (registry-declared) and the same-named ledger.search input / ledger.filterFacets list.
type LibraryField = 'genres' | 'resolutions' | 'requesters' | 'sourceCollections' | 'decade';

/** The per-user facet gates (library.facetGates — ADR-051 C-06 populated-value gating). */
export interface FacetGates {
  watch: boolean;
  bookProgress: boolean;
}

function parseRatingBound(raw: string | null): number | undefined {
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 10 ? n : undefined;
}

/** `YYYY-MM-DD` (the date input) or undefined — anything else is treated as absent. */
function parseDayParam(raw: string | null): string | undefined {
  return raw !== null && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
}

/** The stored preference for one wall (null = no stored row; undefined = still loading). */
function storedViewFor(
  prefs: WallPreference[] | undefined,
  wall: LibraryWallId,
): WallView | null | undefined {
  if (prefs === undefined) return undefined;
  const row = prefs.find((p) => p.wall === wall);
  return row !== undefined && row.source === 'stored'
    ? { view: row.view, groupBy: row.groupBy, sortField: row.sortField, sortDir: row.sortDir }
    : null;
}

function LibraryContent({
  ytdlsubVisible,
  booksVisible,
  mediaVisible,
  ytdlsubLibraries,
}: {
  ytdlsubVisible: boolean;
  booksVisible: boolean;
  mediaVisible: MediaVisible;
  ytdlsubLibraries: YtdlsubLibsVisible;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // ADR-038 / ADR-046 / ADR-047 — Movies | TV | Music | Peloton | YouTube | Books | Audiobooks | Comics |
  // My Fixes. ADR-047 THE INVARIANT: a Movies/TV/Music tab shows only when the caller's role can access
  // that kind's Plex library, and a ytdl-sub tab (Peloton/YouTube) only when its k8plex library is granted
  // (server-resolved in page.tsx). A fully-withheld library's tab is ABSENT (not an empty-state). My Fixes
  // is always LAST. The active-tab resolution validates against the VISIBLE set, so a hidden caller who
  // deep-links a gated tab falls back to the first visible tab.
  const tabs = [
    ...MEDIA_TABS.filter((t) => mediaVisible[t.key as keyof MediaVisible]),
    ...(ytdlsubVisible
      ? YTDLSUB_TABS.filter((t) => ytdlsubLibraries[t.key as keyof YtdlsubLibsVisible])
      : []),
    ...(booksVisible ? BOOKS_TABS : []),
    ACTIVITY_TAB,
    MY_FIXES_TAB,
  ];
  const rawTab = searchParams.get('tab');
  const active: TabKey = tabs.some((t) => t.key === rawTab)
    ? (rawTab as TabKey)
    : (tabs[0]?.key ?? MY_FIXES_TAB.key);
  const activeTab = tabs.find((t) => t.key === active) ?? tabs[0] ?? MY_FIXES_TAB;

  // ADR-052 / DESIGN-026 D-06 (PLAN-029) — hydrate ALL wall preferences once (the browsers resolve
  // their effective view/sort from these + the URL) and the per-user facet gates (ADR-051 C-06).
  const prefs = trpc.library.preferences.getAll.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const gatesQuery = trpc.library.facetGates.useQuery(undefined, { refetchOnWindowFocus: false });
  const gates: FacetGates = gatesQuery.data ?? { watch: false, bookProgress: false };

  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectTab = (key: TabKey) => {
    // Switching tabs starts fresh: keep ONLY ?tab (drops filter/sort/search/view params) so a
    // filter set on Movies never leaks into TV/Music — the keyed remount below re-reads the
    // clean URL; the per-user preference refills the cleaned state (D-10 "tab-switch reset").
    // A tab switch is a SCREEN-level view change, so it PUSHES a history entry (DESIGN-004
    // D-19): Back restores the prior tab with whatever filter state its URL carried (those
    // edits replace-in-place within the tab's single entry), Forward re-applies. Refinements
    // (patchParams below) stay router.replace. scroll:false keeps the tab-switch scroll as-is.
    const params = new URLSearchParams();
    params.set('tab', key);
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    const target = tabs[next];
    if (!target) return;
    selectTab(target.key);
    tabRefs.current[next]?.focus();
  };

  return (
    <>
      <h1 className="page-title">Library</h1>

      <div className="library-tabs" role="tablist" aria-label="Library sections">
        {tabs.map((tab, index) => (
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
          <MediaBrowser
            key={activeTab.key}
            arrKind={activeTab.arrKind}
            label={activeTab.label}
            stored={storedViewFor(prefs.data, ARR_WALLS[activeTab.arrKind])}
            gates={gates}
          />
        ) : activeTab.key === 'peloton' || activeTab.key === 'youtube' ? (
          // ADR-038 — the ytdl-sub Library sub-tabs (read direct from k8plex Plex; poster grid).
          // PLAN-029: these walls ARE the R2 grouped views (a Plex show is a discipline/channel).
          <YtdlsubBrowser
            key={activeTab.key}
            library={activeTab.key as YtdlsubTabKey}
            label={activeTab.label}
            stored={storedViewFor(prefs.data, activeTab.key as LibraryWallId)}
          />
        ) : activeTab.key === 'books' ||
          activeTab.key === 'audiobooks' ||
          activeTab.key === 'comics' ? (
          // ADR-046 — the Books Library sub-tabs (read the app-owned books_items ledger; poster grid).
          // PLAN-029: Books/Audiobooks default to the grouped-by-Author view with a flat alternative.
          <BooksBrowser
            key={activeTab.key}
            wall={activeTab.key as LibraryWallId}
            mediaKind={BOOKS_TAB_KINDS[activeTab.key as BooksTabKey]}
            label={activeTab.label}
            stored={storedViewFor(prefs.data, activeTab.key as LibraryWallId)}
            gates={gates}
          />
        ) : activeTab.key === 'activity' ? (
          // ADR-059 / DESIGN-030 (PLAN-048) — the cross-library Activity sub-tab (live in-flight + failures).
          <ActivityPanel />
        ) : (
          <MyFixesPanel />
        )}
      </div>
    </>
  );
}

// One media tab's browse UI: search + on-disk/wanted controls, the registry-declared facet chip
// bar + sort bar (D-10 engine, D-09 contract, DESIGN-026 D-02/D-03 registry), the A–Z jump rail,
// and the poster grid with keyset infinite scroll. All result-shaping state lives in the URL (see
// the contract at the top of this file).
function MediaBrowser({
  arrKind,
  label,
  stored,
  gates,
}: {
  arrKind: ArrKindName;
  label: string;
  /** The caller's stored wall preference (null = none; undefined = still loading). */
  stored: WallView | null | undefined;
  gates: FacetGates;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const wall = ARR_WALLS[arrKind];
  // ADR-064 / DESIGN-035 D-05/D-09 (PLAN-037) — Movies/TV are multi-shape walls now (the base
  // flat/hierarchy grid + the opt-in Collections grouped view); Music stays single-shape. The view
  // resolves per ADR-052 (URL wins → stored preference → the unchanged R2 default).
  const spec = WALL_VIEWS[wall];
  const groupings = spec.groupings ?? [];
  const defaultGrouping: WallGrouping | undefined = groupings[0];
  const hasSelector = spec.offers.length > 1;
  const group = searchParams.get('group');
  const drilled = hasSelector && group !== null && group !== '';
  const urlView = parseWallViewParam(searchParams.get('view'), spec.offers);
  const byRaw = searchParams.get('by');
  const urlBy = byRaw !== null && groupings.some((g) => g.dimension === byRaw) ? byRaw : undefined;
  const resolved = resolveWallView({
    wall,
    url: {
      ...(urlView !== undefined ? { view: urlView } : {}),
      ...(urlBy !== undefined ? { groupBy: urlBy } : {}),
    },
    stored: stored ?? null,
  });
  const grouping: WallGrouping | undefined =
    groupings.find((g) => g.dimension === resolved.groupBy) ?? defaultGrouping;
  const groupedCards =
    !drilled && hasSelector && resolved.view === 'grouped' && grouping !== undefined;
  // DESIGN-026 D-02/D-03 — the ACTIVE LEVEL's capability declaration (the grouped level sorts the
  // aggregate CARDS — label/count; the item grid keeps the wall's answerable sorts + facets).
  const levelKey: ViewLevelKey =
    groupedCards && grouping?.level !== undefined
      ? grouping.level
      : (`${wall}:wall` as ViewLevelKey);
  const entry: ViewRegistryEntry = registryFor(levelKey);
  // Plain computations below (sortKeys/enumFacets/filters) — the React Compiler memoizes them;
  // manual useMemo over registry-derived values trips react-hooks/preserve-manual-memoization now
  // that the level is grouping-dependent (the books-browser precedent).
  const sortKeys = entry.sorts.map((s) => s.key);

  // ── URL → state (the URL is the single source of truth) ──
  const qParam = searchParams.get('q') ?? '';
  const diskRaw = searchParams.get('disk');
  const onDisk: OnDiskFilter = ON_DISK_FILTERS.some((f) => f.value === diskRaw)
    ? (diskRaw as OnDiskFilter)
    : 'any';
  const wantedOnly = searchParams.get('wanted') === '1';
  // The registry's enum facets → the FilterMap (repeated URL params, comma-safe).
  const enumFacets = entry.facets.filter((f) => f.kind === 'enum');
  const filters: FilterMap<LibraryField> = {};
  for (const f of enumFacets) {
    const vals = [...new Set(searchParams.getAll(f.param).filter((v) => v !== ''))];
    if (vals.length > 0) filters[f.key as LibraryField] = vals;
  }
  const ratingMin = parseRatingBound(searchParams.get('rmin'));
  const ratingMax = parseRatingBound(searchParams.get('rmax'));
  const releasedFromDay = parseDayParam(searchParams.get('rfrom'));
  const releasedToDay = parseDayParam(searchParams.get('rto'));
  const watchRaw = searchParams.get('watch');
  const watchState = WATCH_STATE_OPTIONS.some((o) => o.value === watchRaw)
    ? (watchRaw as (typeof WATCH_STATE_OPTIONS)[number]['value'])
    : undefined;
  // DESIGN-035 D-11' — the category chip (?ctype=, replace refinement — D-19). Grouped-card concern
  // only: the drill URL never carries it and the item grid never reads it. The vocabulary is OPEN
  // (dynamic), so ctype is any non-empty string; an unknown value simply matches no cards (the
  // viewer clicks All to clear) — the chip set itself comes from the present categories below.
  const ctypeRaw = searchParams.get('ctype');
  const ctype = ctypeRaw !== null && ctypeRaw.trim() !== '' ? ctypeRaw : undefined;
  const letterRaw = searchParams.get('at');
  const letter = letterRaw !== null && /^[a-z]$/.test(letterRaw) ? letterRaw : null;

  // ADR-052 (PLAN-029) — the effective sort: explicit URL token WINS (shared-link fidelity, never
  // persisted back), else the stored preference (validated against THIS level's registry keys — the
  // store carries free text), else the R6 default. `prefsReady` gates the first query so the wall
  // never renders the default and then snaps to the stored sort (ADR-015 — no re-orientation).
  const prefsReady = stored !== undefined;
  const urlSort = parseWallSortToken(searchParams.get('sort'), sortKeys);
  const storedSort =
    stored != null && sortKeys.includes(stored.sortField)
      ? { field: stored.sortField, dir: stored.sortDir }
      : null;
  const sort = urlSort ??
    storedSort ?? { field: entry.defaultSort.field, dir: entry.defaultSort.dir };
  const sortToken = `${sort.field}:${sort.dir}`;

  // R6 "remember last-used sort" — persisted ONLY on explicit selection (cycleSort below); a
  // URL-driven render never writes back (the ADR-052 shared-link rule).
  const utils = trpc.useUtils();
  const setPreference = trpc.library.preferences.set.useMutation({
    onSuccess: () => utils.library.preferences.getAll.invalidate(),
  });

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

  // D-10 (PLAN-037) — CANONICALIZE a bare URL that resolved to the GROUPED shape (a replace, no
  // history entry) so the Collections entry's URL is explicit and Back restores exactly this view
  // even after the stored preference changes. A bare URL resolving to the wall's DEFAULT shape
  // stays bare — the D-10 rule ("?view omitted when it equals the wall's R2 default") is shipped
  // contract on these walls (deep links + the history e2e assert the bare ?tab= form).
  useEffect(() => {
    if (!hasSelector || !prefsReady || drilled) return;
    if (searchParams.get('view') === null && resolved.view === 'grouped') {
      patchParams({
        view: 'grouped',
        by: grouping !== undefined && grouping !== defaultGrouping ? grouping.dimension : null,
      });
    }
    // patchParams reads the live location; the deps that matter are the resolution inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSelector, prefsReady, drilled, searchParams, resolved.view, grouping]);

  /** ADR-064 / DESIGN-035 D-06 — a view switch: a SCREEN-level change → PUSH a clean URL
   *  (refinements drop — the new shape starts fresh, like a tab switch) + persist the choice. */
  const selectView = (target: { view: 'base' } | { view: 'grouped'; grouping: WallGrouping }) => {
    const currentKey = drilled ? null : groupedCards ? `grouped:${grouping?.dimension}` : 'base';
    const targetKey = target.view === 'base' ? 'base' : `grouped:${target.grouping.dimension}`;
    if (currentKey !== targetKey) {
      const params = new URLSearchParams();
      params.set('tab', wall);
      params.set('view', target.view === 'base' ? WALL_VIEW_DEFAULTS[wall].view : 'grouped');
      if (target.view === 'grouped' && target.grouping !== defaultGrouping) {
        params.set('by', target.grouping.dimension);
      }
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    }
    const level = registryFor(
      target.view === 'grouped' && target.grouping.level !== undefined
        ? target.grouping.level
        : (`${wall}:wall` as ViewLevelKey),
    );
    const keys = level.sorts.map((s) => s.key);
    const keep =
      stored != null && keys.includes(stored.sortField)
        ? { field: stored.sortField, dir: stored.sortDir }
        : { field: level.defaultSort.field, dir: level.defaultSort.dir };
    setPreference.mutate({
      wall,
      view: target.view === 'base' ? WALL_VIEW_DEFAULTS[wall].view : 'grouped',
      groupBy: target.view === 'grouped' ? target.grouping.dimension : null,
      sortField: keep.field,
      sortDir: keep.dir,
    });
  };

  // The search INPUT is a local draft (initialised from ?q on mount — tab switches remount
  // via the key) debounced 250ms into the URL; the QUERY reads ?q, so URL and results always
  // agree and a shared link restores the text.
  const [query, setQuery] = useState(qParam);
  // DESIGN-035 D-16/D-17 — the collection-drill Wanted-tile force-search target (null = closed). The
  // Wanted tiles carry the shared @hnet/ui <MediaAction action="forceSearch"> which opens the shipped
  // ForceSearchDialog for that member (the existing per-item Radarr search — reused, not re-rolled).
  const [fsItem, setFsItem] = useState<{ id: string; arrKind: string; title: string } | null>(null);
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
    const param = enumFacets.find((f) => f.key === field)!.param;
    patchParams({ [param]: values.length > 0 ? values : null });
  };

  // ── sort control (the ported nextSort/arrowFor engine, columns from the registry) ──
  // Two-state click cycle per column: first click → the registry's firstDir, then it just toggles
  // direction (no cleared state — the active column always shows an arrow).
  const clickCycle = Object.fromEntries(
    entry.sorts.map((c) => [
      c.key,
      c.firstDir === 'asc'
        ? { asc: `${c.key}:asc`, desc: `${c.key}:desc` }
        : { asc: `${c.key}:desc`, desc: `${c.key}:asc` },
    ]),
  ) as Record<string, { asc: string; desc: string }>;
  // Direction-true map for the ▲/▼ glyph.
  const arrowCycle = Object.fromEntries(
    entry.sorts.map((c) => [c.key, { asc: `${c.key}:asc`, desc: `${c.key}:desc` }]),
  ) as Record<string, { asc: string; desc: string }>;
  const cycleSort = (col: string) => {
    const next = nextSort<string, string>(sortToken, col, clickCycle);
    const [field, dir] = next.split(':') as [string, WallSortDir];
    // A sort change is a REFINEMENT (replace, D-19) and drops any armed A–Z jump; the explicit
    // token stays in the URL for shareability. Persist the last-used sort (R6) — an explicit
    // user selection, the one sanctioned write point. A DRILLED grid's sort is a transient
    // refinement of that one collection screen, not the wall preference (the books-drill rule).
    patchParams({ sort: next, at: null });
    if (!drilled) {
      // The persisted row carries the ACTIVE shape (the base flat/hierarchy grid, or the grouped
      // Collections view with its dimension — PLAN-037) + the newly chosen sort.
      setPreference.mutate({
        wall,
        view: groupedCards ? 'grouped' : WALL_VIEW_DEFAULTS[wall].view,
        groupBy: groupedCards ? (grouping?.dimension ?? null) : WALL_VIEW_DEFAULTS[wall].groupBy,
        sortField: field,
        sortDir: dir,
      });
    }
  };

  // ── facets + search (D-09) ──
  const facets = trpc.ledger.filterFacets.useQuery({ arrKind });
  // filterFacets already returns resolutions in RESOLUTIONS enum order (server-side, D-09) —
  // no client re-sort needed; every facet is used verbatim. Decades arrive newest-first.
  const facetValues = (field: LibraryField): readonly string[] => {
    if (facets.data === undefined) return [];
    if (field === 'decade') return facets.data.decades.map((d) => String(d));
    return facets.data[field];
  };

  const resolutionsInput = filterValues(filters, 'resolutions').filter((v): v is ResolutionName =>
    Object.hasOwn(RESOLUTION_LABELS, v),
  );
  const decadesInput = filterValues(filters, 'decade')
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n));
  // ADR-064 / DESIGN-035 D-03 (PLAN-037) — the Collections group cards (grouped view), also read
  // while DRILLED so the drill header can name the collection (the key is a ratingKey, not a title).
  const groupsQuery = trpc.ledger.collectionGroups.useQuery(
    {
      arrKind: arrKind as 'radarr' | 'sonarr',
      // D-11' — the server filters the CARDS; categoryCounts come back unfiltered, so the chip set
      // holds steady while toggling. Never applied to the drill's label lookup.
      ...(groupedCards && ctype !== undefined ? { category: ctype } : {}),
    },
    {
      enabled: hasSelector && (groupedCards || drilled),
      refetchOnWindowFocus: false,
      placeholderData: (prev) => prev,
    },
  );

  // The active sort must be an A–Z sort for the jump letter to bite (registry azSorts, asc).
  const azActive = (entry.azSorts as readonly string[]).includes(sort.field) && sort.dir === 'asc';
  const search = trpc.ledger.search.useInfiniteQuery(
    {
      query: qParam.trim() === '' ? undefined : qParam.trim(),
      arrKind,
      onDisk,
      ...(wantedOnly ? { wanted: true } : {}),
      // The registry pinned this wall's keys to LibrarySortField at compile time (library-view-registry).
      sort: { field: sort.field as LibrarySortField, dir: sort.dir },
      ...(filters.genres ? { genres: filters.genres } : {}),
      ...(resolutionsInput.length > 0 ? { resolutions: resolutionsInput } : {}),
      ...(filters.requesters ? { requesters: filters.requesters } : {}),
      ...(filters.sourceCollections ? { sourceCollections: filters.sourceCollections } : {}),
      ...(ratingMin !== undefined ? { ratingMin } : {}),
      ...(ratingMax !== undefined ? { ratingMax } : {}),
      // PLAN-029 — the Decade / Release-Date-range / watch-state facets + the A–Z jump letter.
      ...(decadesInput.length > 0 ? { decades: decadesInput } : {}),
      ...(releasedFromDay !== undefined
        ? { releasedFrom: `${releasedFromDay}T00:00:00.000Z` }
        : {}),
      ...(releasedToDay !== undefined ? { releasedTo: `${releasedToDay}T23:59:59.999Z` } : {}),
      ...(watchState !== undefined ? { watchState } : {}),
      ...(azActive && letter !== null ? { letter } : {}),
      // ADR-064 / DESIGN-035 D-04 (PLAN-037) — the drilled collection IS its filter: one EXISTS
      // predicate server-side; everything else about the wall composes unchanged.
      ...(drilled ? { collection: group! } : {}),
      limit: 50,
    },
    {
      // Wait for the stored preference so the first paint already wears the resolved sort
      // (skeleton → resolved grid; never default-then-snap). The grouped CARD view reads
      // collectionGroups instead — the item query stays off until a drill or a view switch.
      enabled: prefsReady && !groupedCards,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      // Keep the previous grid rendered (dimmed below) while a filter/sort refetch resolves —
      // results swap in place, the layout never jumps (ADR-015).
      placeholderData: (prev) => prev,
    },
  );

  const items = search.data?.pages.flatMap((p) => p.items) ?? [];
  const refreshing = search.isPlaceholderData && search.isFetching;

  // Grouped cards: client-side label search + card sort (the level's registry keys — label/count).
  // Plain computations — the React Compiler memoizes them; the group lists are small (a household
  // server carries tens-to-hundreds of collections).
  const groupList = groupsQuery.data?.groups ?? [];
  const groupQ = qParam.trim().toLowerCase();
  const groupsFound =
    groupQ === '' ? groupList : groupList.filter((g) => g.label.toLowerCase().includes(groupQ));
  const groupDir = sort.dir === 'desc' ? -1 : 1;
  const groups =
    sort.field === 'count'
      ? [...groupsFound].sort(
          (a, b) => (a.count - b.count) * groupDir || a.label.localeCompare(b.label),
        )
      : [...groupsFound].sort((a, b) => a.label.localeCompare(b.label) * groupDir);
  const groupsRefreshing = groupsQuery.isPlaceholderData && groupsQuery.isFetching;
  // The drill header names the collection (the ?group= key is a ratingKey, not a title).
  const drilledLabel = drilled ? (groupList.find((g) => g.key === group)?.label ?? '') : '';
  // DESIGN-043 D-01/D-09 amend (2026-07-18, owner-ruled) — the "Edit collection" nav-out target for
  // the Movies/TV walls. The Kometa join is by TITLE (no clean recipe id client-side), so the link
  // lands on the right media tab WITHOUT an `edit` param — never a fabricated id. Music has no tab.
  const collectionsTab: 'movies' | 'tv' | null =
    wall === 'movies' ? 'movies' : wall === 'tv' ? 'tv' : null;

  // DESIGN-026 D-09 — the A–Z jump rail (a fixed overlay — never reflows the grid; visibility per
  // the showJumpBar rule: A–Z sort + big wall, or a jump already armed). Never over group cards.
  const jumpVisible =
    !groupedCards &&
    showJumpBar({
      isAzSort: azActive,
      activeLetter: letter,
      itemCount: items.length,
      hasNextPage: search.hasNextPage === true,
    });

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
      {/* ADR-064 / DESIGN-035 D-04 (PLAN-037) — the drill-in header: the collection's name + the way
          back UP to the grouped wall. A screen of its own (reached by a PUSH), so this header is
          static per screen (ADR-015). */}
      {drilled && grouping !== undefined ? (
        <div className="library-drill" data-testid="library-drill">
          <Link
            className="btn sm library-drill__back"
            href={`${pathname}?tab=${wall}&view=grouped${
              grouping !== defaultGrouping ? `&by=${encodeURIComponent(grouping.dimension)}` : ''
            }`}
            scroll={false}
          >
            ‹ {grouping.allLabel}
          </Link>
          <span className="library-drill__label">{drilledLabel}</span>
          {/* DESIGN-043 D-01/D-09 amend — the quiet nav-out to the collection manager. Movies/TV drills
              key by a Plex ratingKey (the Kometa join is by title), so this lands on the right media
              tab WITHOUT an edit param — landing on the correct tab is still correct, never a
              fabricated id. Static per screen — no reflow (ADR-015); tokens-only `.btn.sm`. */}
          {collectionsTab !== null ? (
            <Link
              className="btn sm library-drill__edit"
              href={`/collections?tab=${collectionsTab}`}
              data-testid="library-drill-edit"
            >
              Edit collection
            </Link>
          ) : null}
        </div>
      ) : null}

      <div className="library-toolbar">
        <div className="library-controls">
          {/* DESIGN-035 D-09 — the view selector (the books-browser `.seg` idiom): Collections | the
              base grid. Renders only on multi-shape walls, never inside a drill. */}
          {hasSelector && !drilled && groupings.length > 0 ? (
            <div className="seg" role="group" aria-label="View" data-testid="view-selector">
              {groupings.map((g) => {
                const isActive = groupedCards && grouping === g;
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
              <button
                type="button"
                className={!groupedCards ? 'is-active' : undefined}
                aria-pressed={!groupedCards}
                onClick={() => selectView({ view: 'base' })}
              >
                {spec.flatLabel}
              </button>
            </div>
          ) : null}
          <input
            type="search"
            className="library-search"
            placeholder={
              groupedCards
                ? `Search ${grouping?.selectorLabel.toLowerCase() ?? 'groups'}…`
                : `Search ${label.toLowerCase()}…`
            }
            aria-label="Search the library"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {/* Item-only narrowings (on-disk / Wanted) hide over group cards — a card grid can't
              answer them (the registry's never-offer-what-it-can't-answer rule). */}
          {!groupedCards ? (
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
          ) : null}
        </div>

        {/* Filter chip bar (D-10 engine, DESIGN-026 D-03 contents): the registry declares exactly
            which facets THIS wall answers — one permanent chip per declared facet (empty chips are
            the ghost "add a filter" affordance), rendered in registry order; the per-user watch
            chip appears only for a viewer with watch data (ADR-051 C-06 — gated, so it sits LAST).
            A FIXED-HEIGHT single row that scrolls horizontally when crowded (ADR-015: the bar
            never grows, so the grid never shifts); editors overlay via fixed positioning.
            The grouped-collection levels declare exactly ONE facet — the PLAN-053 Type chip row
            (DESIGN-035 D-11); item facets stay absent from grouped levels (registry-enforced). */}
        {entry.facets.length > 0 ? (
          <div className="library-chipbar" role="group" aria-label="Filters">
            {entry.facets.map((facet) => {
              if (facet.key === 'category') {
                // DESIGN-035 D-11' / R-214 — the category chip row: single-select, All default, always
                // visible (owner ruling: the chip FILTERS, never hides). ?ctype= is a D-19 replace
                // refinement; the SERVER filters the cards. The chip vocabulary is DYNAMIC — one chip
                // per DISTINCT category actually present (categoryCounts keys), ordered
                // hint-list-then-alphabetical (orderCollectionCategories); a new owner label becomes a
                // new chip with zero code change, and there is no "Other" bucket. Both walls render it
                // identically. The `.library-chipbar` stays a fixed-height row that pans horizontally
                // when crowded (ADR-015: never reflows the grid).
                const categoryOptions = orderCollectionCategories(
                  Object.keys(groupsQuery.data?.categoryCounts ?? {}),
                );
                return (
                  <div key={facet.key} className="seg" role="group" aria-label="Collection type">
                    <button
                      type="button"
                      className={ctype === undefined ? 'is-active' : undefined}
                      aria-pressed={ctype === undefined}
                      onClick={() => patchParams({ [facet.param]: null })}
                    >
                      All
                    </button>
                    {categoryOptions.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={ctype === c ? 'is-active' : undefined}
                        aria-pressed={ctype === c}
                        onClick={() => patchParams({ [facet.param]: ctype === c ? null : c })}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                );
              }
              if (facet.kind === 'enum') {
                const field = facet.key as LibraryField;
                return (
                  <FilterChip
                    key={facet.key}
                    fieldLabel={facet.label}
                    values={filterValues(filters, field)}
                    kind="enum"
                    enumValues={facetValues(field)}
                    enumLabel={
                      facet.key === 'resolutions'
                        ? (v) => RESOLUTION_LABELS[v] ?? v
                        : facet.key === 'decade'
                          ? decadeLabel
                          : undefined
                    }
                    labels={CHIP_LABELS}
                    onAdd={(v) =>
                      setFieldValues(field, filterValues(addFilterValue(filters, field, v), field))
                    }
                    onRemove={(v) =>
                      setFieldValues(
                        field,
                        filterValues(removeFilterValue(filters, field, v), field),
                      )
                    }
                    onClear={() => setFieldValues(field, [])}
                  />
                );
              }
              if (facet.kind === 'range-date') {
                return (
                  <DateRangeChip
                    key={facet.key}
                    label={facet.label}
                    from={releasedFromDay}
                    to={releasedToDay}
                    onChange={(from, to) => patchParams({ rfrom: from ?? null, rto: to ?? null })}
                  />
                );
              }
              if (facet.kind === 'range-rating') {
                // The bounded rating chip — D-09's ratingMin/Max COALESCE(imdb_rating, tmdb_rating), so
                // the Sonarr community rating (in the tmdb slots, ADR-018 C-07) filters too.
                return (
                  <RatingChip
                    key={facet.key}
                    min={ratingMin}
                    max={ratingMax}
                    onChange={(min, max) =>
                      patchParams({
                        rmin: min === undefined ? null : String(min),
                        rmax: max === undefined ? null : String(max),
                      })
                    }
                  />
                );
              }
              if (facet.kind === 'select' && facet.gate === 'watch') {
                // ADR-053 / DESIGN-026 D-07 — the per-user watch-state facet, offered ONLY when the
                // viewer has any attributed watch rows (populated-value gate — never a dead chip).
                if (!gates.watch) return null;
                return (
                  <SelectChip
                    key={facet.key}
                    label={facet.label}
                    value={watchState}
                    options={WATCH_STATE_OPTIONS}
                    onChange={(v) => patchParams({ watch: v ?? null })}
                  />
                );
              }
              return null;
            })}
          </div>
        ) : null}

        {/* Sort bar (D-10 nextSort/arrowFor over the REGISTRY's keys — DESIGN-026 D-02: this wall
            offers exactly the sorts it can answer; R6 default = recently-added for the video walls).
            Each column toggles best-first ↔ reversed (two-state — the active column always shows an
            arrow). Same fixed-height scroll-row pattern as the chip bar. */}
        <div className="library-sortbar" role="group" aria-label="Sort">
          <span className="library-sortbar__label">Sort</span>
          {entry.sorts.map((c) => {
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
                {/* fixed-width slot: the arrow appearing never nudges neighbors (ADR-015) */}
                <span className="sort-btn__arrow" aria-hidden="true">
                  {arrowFor<string, string>(sortToken, c.key, arrowCycle).trim()}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {jumpVisible ? (
        <LetterJumpBar active={letter} onJump={(l) => patchParams({ at: l })} />
      ) : null}

      {!prefsReady || (groupedCards ? groupsQuery.isPending : search.isPending) ? (
        // Initial load: skeleton poster boxes hold the exact grid geometry (ADR-015 — no
        // spinner that collapses into a differently-sized result).
        <PosterGridSkeleton testId="poster-skeleton" />
      ) : groupedCards ? (
        // ADR-064 / DESIGN-035 D-03/D-09 (PLAN-037) — the Collections group cards (GroupCard: the
        // member cover fan in the reserved 2:3 box + label + accessible count). Drill-in = PUSH.
        groupsQuery.error ? (
          <p className="alert" role="alert">
            Failed to load collections: {groupsQuery.error.message}
          </p>
        ) : groups.length === 0 ? (
          <section className="card empty-state" data-testid="collections-empty">
            <p className="muted">
              {groupQ !== '' || ctype !== undefined
                ? 'Nothing matches your filters.'
                : 'No collections yet. They fill in as the Plex mirror syncs.'}
            </p>
          </section>
        ) : (
          <PosterGrid refreshing={groupsRefreshing} testId="collections-groups">
            {groups.map((g) => (
              <GroupCard
                key={g.key}
                href={`${pathname}?tab=${wall}${
                  grouping !== undefined && grouping !== defaultGrouping
                    ? `&by=${encodeURIComponent(grouping.dimension)}`
                    : ''
                }&group=${encodeURIComponent(g.key)}`}
                art={grouping?.art ?? 'covers'}
                label={g.label}
                imageUrl={g.imageUrl}
                coverUrls={g.coverUrls}
                kind={arrKind}
                count={g.count}
                wantedCount={g.wantedCount}
                provenance={g.provenance}
              />
            ))}
          </PosterGrid>
        )
      ) : search.error ? (
        <p className="alert" role="alert">
          Failed to load the library: {search.error.message}
        </p>
      ) : items.length === 0 ? (
        <section className="card empty-state">
          <p>Nothing matches — the ledger fills in as sync runs.</p>
        </section>
      ) : (
        <PosterGrid refreshing={refreshing}>
          {items.map((item) => {
            const disk = onDiskSummary(item);
            // A 0 upstream rating means "unrated" — collapse it so no ★ 0.0 badge renders
            // (DESIGN-008 live-validation fix). Prefer IMDb, else TMDb, each 0-suppressed.
            const imdbRating = ratingOrNull(item.metadata.imdbRating);
            const tmdbRating = ratingOrNull(item.metadata.tmdbRating);
            const rating = formatRating(imdbRating ?? tmdbRating);
            const ratingSource = imdbRating !== null ? 'IMDb' : 'TMDb';
            // Slim badge row (owner densify 2026-07-06): the kind badge is dropped — the active
            // tab already names the kind — leaving the rating star + on-disk state (Wanted /
            // On disk — the badge the Books/Goodreads walls clone) and the tombstone flag.
            const card = (
              <MediaCard
                href={`/library/${item.id}`}
                posterUrl={item.posterUrl}
                kind={item.arrKind}
                title={item.title}
                year={item.year}
                badges={[
                  rating !== null
                    ? { label: `★ ${rating}`, tone: 'rating', title: `${ratingSource} rating` }
                    : null,
                  { label: disk.label, tone: disk.tone },
                  item.tombstoned ? { label: 'Removed', tone: 'danger' } : null,
                ]}
              />
            );
            // DESIGN-035 D-16/D-17 — a Wanted member of a DRILLED movies (radarr) collection gets the
            // shared force-search action overlaid on its tile (the shipped per-item Radarr search). The
            // action is a corner overlay (a sibling of the card link, never nested in the <a>) so the tile
            // keeps its uniform size — recolors on arm, never reflows (ADR-015).
            const wantedFsSeam =
              drilled && item.arrKind === 'radarr' && disk.label === 'Wanted' && !item.tombstoned;
            if (!wantedFsSeam) return <Fragment key={item.id}>{card}</Fragment>;
            return (
              <div key={item.id} className="coll-wanted">
                {card}
                <span className="coll-wanted__fs">
                  <MediaAction
                    action="forceSearch"
                    size="sm"
                    onFire={() =>
                      setFsItem({ id: item.id, arrKind: item.arrKind, title: item.title })
                    }
                    testId="collection-wanted-forcesearch"
                    ariaLabel={`Force search ${item.title}`}
                  />
                </span>
              </div>
            );
          })}
        </PosterGrid>
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

      {/* DESIGN-035 D-16/D-17 — the shipped Force Search dialog, reused for a collection-drill Wanted
          member (the shared per-item Radarr search; opened by the tile's <MediaAction forceSearch>). */}
      <ForceSearchDialog
        open={fsItem !== null}
        item={fsItem ?? { id: '', arrKind: 'radarr', title: '' }}
        onClose={() => setFsItem(null)}
        onSubmitted={() => {
          // The search runs async; refresh the drill so the member's on-disk state updates when it lands.
          void search.refetch();
        }}
      />
    </>
  );
}

// The bounded rating chip moved to components/filter-chips.tsx (shared with /ledger,
// DESIGN-009 D-08) — same skin, same overlay geometry, one implementation.

// The client shell — the `/library` server component (page.tsx) resolves the caller's `ytdlsub` section
// visibility server-side (ADR-038 C-05) and passes it down so the Peloton/YouTube tabs render only when
// permitted. Wrapped in Suspense because the tab state is driven by useSearchParams (App Router).
export function LibraryClient({
  ytdlsubVisible,
  booksVisible,
  mediaVisible,
  ytdlsubLibraries,
}: {
  ytdlsubVisible: boolean;
  booksVisible: boolean;
  mediaVisible: MediaVisible;
  ytdlsubLibraries: YtdlsubLibsVisible;
}) {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <LibraryContent
        ytdlsubVisible={ytdlsubVisible}
        booksVisible={booksVisible}
        mediaVisible={mediaVisible}
        ytdlsubLibraries={ytdlsubLibraries}
      />
    </Suspense>
  );
}
