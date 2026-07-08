'use client';

// ADR-023 / DESIGN-010 D-09 — the /trash section UI over the trash.* wire contracts (D-08).
// This is the app's ONLY user-facing deletion surface, so the layout leads with SAFETY:
//
// - The SAFETY BANNER (trash.status) sits above everything: green when Maintainerr is
//   connected with every required integration; a loud warning (and every destructive control
//   disabled) when an integration is down; danger when unreachable. The server re-runs the
//   audit on every expedite regardless — the banner is the honest mirror, not the enforcement.
// - Movies and TV are separate tabs, NEVER combined; Music does not exist here (R-87).
// - The pending views are POSTER WALLS (2026-07-07 — the owner: the tables were unusable on a
//   phone; the Batches wall grammar is perfect on every device, so it replaced them). Same
//   /library//ledger filter engine (chips + URL contract ?q/genre/res/req/col/rmin/rmax/sort,
//   client-side over the small pending set) plus the /library sort bar (the table headers were
//   the old sort affordance). Each tile: poster (tap ⇒ /library/[id] when ledger-joined — the
//   bulletin-chip pattern; history/fix live there), a fixed-corner SHIELD (check = protected by
//   tag/exclusion, inert · filled = saved by you, tap to un-save · outline = tap to save) and a
//   fixed-corner TRASH-CAN (expedite ⇒ the ADR-014 Modal). Scheduled-delete date, requesters,
//   collection, and guardian facts move into the tile tooltip; the reclaim counts bar rides
//   ABOVE the wall with Expedite-all.
// - Save/whitelist is the shield corner (protective — plain optimistic toggle, ADR-014 reserves
//   two-step for destructive); Expedite ALWAYS goes through a Modal (ADR-014 — never one-click
//   delete), whose copy predicts the guardian partition (deleted NOW / protected /
//   skipped-unverifiable) and whose post-run report distinguishes those three outcomes
//   (skipped ≠ protected — ADR-023 C-07b).
// - "Expedite all" cannot be scoped by filters (the wire contract takes only the media kind),
//   so with filters active the Modal REFUSES to arm and offers to clear them — the dangerous
//   "looks filtered, deletes everything" state is unexpressible (DESIGN-010 D-09).
// - ADR-015: the banner reserves its height; the counts bar is persistent with constant-width
//   controls; a fixed-height error slot recolors, never shifts the wall; refetches dim the wall
//   in place; a shield tap swaps the corner glyph and deepens color — tiles never move.
// - ADR-032 (2026-07-07): the RULES tab and the Trash-settings card are settings, not
//   user-facing surfaces — they moved to /settings/trash (reached from the user menu,
//   trash-Edit gated).
// - ADR-033 (2026-07-07): the "Batches" tab is FOLDED into the per-kind tabs — one open batch
//   per kind is the invariant, so a batch is a property of Movies/TV, not a separate collection.
//   /trash keeps Movies · TV · Recently Deleted · Activity; each kind tab is one state-aware
//   surface (no batch ⇒ this pending wall; admin_review/leaving_soon ⇒ the batch lifecycle;
//   terminal ⇒ back to the wall + a Past-batches strip). See kind-tab.tsx. Owner refinement: the
//   wall is a fast tap-toggle (poster flips trash⇄shield), /library nav is a corner icon, and
//   per-item expedite moved to the item page — the wall keeps only bulk "Expedite all…".
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  FilterChip,
  ConfirmButton,
  addFilterValue,
  removeFilterValue,
  filterValues,
  nextSort,
  arrowFor,
  type FilterMap,
} from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import { Modal } from '@/components/modal';
import { MediaPoster } from '@/components/media-poster';
import { CHIP_LABELS, RatingChip } from '@/components/filter-chips';
import {
  LibraryCornerLink,
  WallGlyphSvg,
  type TrashAccess,
} from '@/components/trash-shield';
import { SafetyBanner, type SafetyStatus } from '@/components/trash-safety';
import { ExpediteReport, type ExpediteOutcome } from '@/components/trash-expedite';
import { KindTab } from './kind-tab';
import { TrashOverview, type OverviewData } from './trash-overview';
import {
  RESOLUTION_LABELS,
  formatBytes,
  formatDay,
  formatRating,
  formatWhen,
  ratingOrNull,
} from '@/lib/media';
import { appCodeOf, describeMutationError } from '@/lib/app-error';
import {
  daysLeftLabel,
  daysUntil,
  expediteErrorAction,
  overviewBadge,
  partitionForExpedite,
  pendingWallGlyph,
  pendingWallTappable,
  reclaimLabel,
  type PendingWallGlyph,
} from '@/lib/trash';

export type { TrashAccess };

// ADR-032 — Rules is a SETTING now (/settings/trash). ADR-033 — "Batches" is folded into the
// per-kind tabs (a batch is a property of Movies/TV). DESIGN-010 amendment (2026-07-08) — OVERVIEW
// is the new DEFAULT landing (aggregate before navigating; supersedes the default-Movies landing);
// only Movies/TV carry a count badge. These are the user-facing surfaces.
const TRASH_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'movies', label: 'Movies' },
  { key: 'tv', label: 'TV' },
  { key: 'deleted', label: 'Recently Deleted' },
  { key: 'activity', label: 'Activity' },
] as const;
type TabKey = (typeof TRASH_TABS)[number]['key'];

/** The Movies/TV tabs badge a count; the kind their card aggregates. */
const TAB_KIND: Partial<Record<TabKey, 'movie' | 'tv'>> = { movies: 'movie', tv: 'tv' };

function resolveTab(raw: string | null): TabKey {
  // ADR-033 — old `?tab=batches` deep links fold into the per-kind tab (Movies unless the old
  // `?kind=tv` rode along — handled by the redirect effect below).
  if (raw === 'batches') return 'movies';
  // DESIGN-010 amendment — no ?tab (or an unknown one) lands on Overview, not Movies.
  return TRASH_TABS.some((t) => t.key === raw) ? (raw as TabKey) : 'overview';
}

// ── shared wire-shape aliases (inferred from the tRPC hooks at the use sites; these
//    structural types keep the child components honest without importing server packages) ──
interface PendingItem {
  maintainerrMediaId: string | null;
  collectionId: number;
  collectionTitle: string | null;
  sizeBytes: number;
  scheduledDeleteAt: string | null;
  mediaItemId: string | null;
  title: string;
  year: number | null;
  protectedByTag: boolean;
  protectedByExclusion: boolean;
  recentlyWatched: boolean;
  requesters: string[];
  sourceCollections: string[];
  genres: string[];
  resolution: string | null;
  imdbRating: number | null;
  tmdbRating: number | null;
  posterUrl: string | null;
}

// The safety banner + its SafetyStatus wire mirror live in components/trash-safety.tsx
// (shared with /settings/trash — ADR-032).

// ── the pending WALL (one media kind) ───────────────────────────────────────────────────

type PendingField = 'genres' | 'resolution' | 'requesters' | 'sourceCollections';
const FILTER_FIELDS: ReadonlyArray<{ field: PendingField; param: string; label: string }> = [
  { field: 'genres', param: 'genre', label: 'Genre' },
  { field: 'resolution', param: 'res', label: 'Resolution' },
  { field: 'requesters', param: 'req', label: 'Requester' },
  { field: 'sourceCollections', param: 'col', label: 'Collection' },
];

const SORT_FIELDS = ['scheduled', 'title', 'size', 'rating'] as const;
type SortField = (typeof SORT_FIELDS)[number];
type SortToken = `${SortField}:${'asc' | 'desc'}`;
const DEFAULT_SORT: SortToken = 'scheduled:asc';

/** The wall's sort bar (the table headers were the old sort affordance — same /library
 *  nextSort/arrowFor engine, same `?sort` token contract, soonest-deleting first by default). */
const SORT_COLUMNS: ReadonlyArray<{
  col: string;
  label: string;
  field: SortField;
  firstDir: 'asc' | 'desc';
}> = [
  { col: 'scheduled', label: 'Deletes', field: 'scheduled', firstDir: 'asc' },
  { col: 'title', label: 'Title', field: 'title', firstDir: 'asc' },
  { col: 'size', label: 'Size', field: 'size', firstDir: 'desc' },
  { col: 'rating', label: 'Rating', field: 'rating', firstDir: 'desc' },
];

function parseSortToken(raw: string | null): { field: SortField; dir: 'asc' | 'desc' } {
  const [field, dir] = (raw ?? '').split(':');
  if (
    (SORT_FIELDS as readonly string[]).includes(field ?? '') &&
    (dir === 'asc' || dir === 'desc')
  ) {
    return { field: field as SortField, dir };
  }
  return { field: 'scheduled', dir: 'asc' };
}

function parseRatingBound(raw: string | null): number | undefined {
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 10 ? n : undefined;
}

const itemRating = (item: PendingItem): number | null =>
  ratingOrNull(item.imdbRating) ?? ratingOrNull(item.tmdbRating);

const fieldValuesOf = (item: PendingItem, field: PendingField): string[] =>
  field === 'resolution' ? (item.resolution === null ? [] : [item.resolution]) : item[field];

/** Nulls-last comparator over the client sort fields (the pending set is small — D-08 returns
 *  the whole kind's set, so shaping is honest to do in the browser). */
function compareItems(
  a: PendingItem,
  b: PendingItem,
  field: SortField,
  dir: 'asc' | 'desc',
): number {
  const sign = dir === 'asc' ? 1 : -1;
  const num = (x: number | null, y: number | null): number => {
    if (x === null && y === null) return 0;
    if (x === null) return 1; // nulls last regardless of direction
    if (y === null) return -1;
    return (x - y) * sign;
  };
  switch (field) {
    case 'title':
      return a.title.localeCompare(b.title) * sign;
    case 'size':
      return num(a.sizeBytes, b.sizeBytes);
    case 'rating':
      return num(itemRating(a), itemRating(b));
    case 'scheduled':
      return num(
        a.scheduledDeleteAt === null ? null : Date.parse(a.scheduledDeleteAt),
        b.scheduledDeleteAt === null ? null : Date.parse(b.scheduledDeleteAt),
      );
  }
}

/** The tile tooltip — the detail the table's columns carried (scheduled date + days-left,
 *  protection reason, guardian facts, requesters, source rule), phone-first: title-attr on the
 *  poster; the full history lives one tap away on /library/[id]. */
function tileInfo(item: PendingItem, glyph: PendingWallGlyph): string {
  const lines: string[] = [
    item.scheduledDeleteAt !== null
      ? `Deletes ${formatDay(item.scheduledDeleteAt)} (${daysLeftLabel(daysUntil(item.scheduledDeleteAt))})`
      : 'No scheduled delete date',
  ];
  if (glyph === 'shield') lines.push('Saved by you — protected from deletion');
  else if (glyph === 'check')
    lines.push(
      item.protectedByTag
        ? 'Protected — carries the dnd tag'
        : 'Protected — excluded in Maintainerr',
    );
  if (item.recentlyWatched) lines.push('Recently watched — the guardian keeps it');
  if (item.requesters.length > 0) lines.push(`Requested by ${item.requesters.join(', ')}`);
  if (item.collectionTitle !== null) lines.push(`Rule: ${item.collectionTitle}`);
  lines.push(
    item.mediaItemId !== null
      ? 'Tap the poster for history and fixes'
      : 'Not in our ledger — it can never be expedited (fail closed), only saved',
  );
  return lines.join('\n');
}

// Per-item expedite moved to the item page (owner refinement 2026-07-07); the wall keeps only the
// bulk "Expedite all…". ExpediteOutcome is the shared partition shape (trash-expedite.tsx).
type ExpediteTarget = { scope: 'all' };

function PendingTab({
  media,
  label,
  access,
  status,
}: {
  media: 'movie' | 'tv';
  label: string;
  access: TrashAccess;
  status: SafetyStatus | undefined;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const utils = trpc.useUtils();

  const safe = status?.safe === true;
  const reachable = status?.reachable === true;
  const canSave = access.actions.includes('save_exclude') && reachable;
  const canUnsave = access.actions.includes('remove_exclude') && reachable;
  const canExpediteAll = access.actions.includes('expedite_all');
  const fromKey = media === 'movie' ? 'trash-movies' : 'trash-tv';

  // ── URL → state (same param contract as /library and /ledger) ──
  const qParam = searchParams.get('q') ?? '';
  const filters = useMemo<FilterMap<PendingField>>(() => {
    const out: FilterMap<PendingField> = {};
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

  const [query, setQuery] = useState(qParam);
  // Debounce-free: the set is client-filtered, so typing filters instantly; the URL keeps the
  // canonical value for deep links (patched on change — cheap replace, no server round trip).
  const setSearch = (value: string) => {
    setQuery(value);
    patchParams({ q: value });
  };

  const setFieldValues = (field: PendingField, values: string[]) => {
    const param = FILTER_FIELDS.find((f) => f.field === field)!.param;
    patchParams({ [param]: values.length > 0 ? values : null });
  };

  // ── data ──
  const pending = trpc.trash.pending.useQuery({ media }, { placeholderData: (prev) => prev });
  const allItems: PendingItem[] = pending.data?.items ?? [];
  const refreshing = pending.isPlaceholderData && pending.isFetching;

  // Session-local shield overrides (the dnd tag lands on the next *arr sync — D-09). A 'saved'
  // override is ALSO the wall's "saved by YOU" signal: pending items carry no ownership, so only
  // the save you just made renders as the tappable filled shield — protection that arrives from
  // the server (tag / exclusion made elsewhere or in an earlier session) is the inert check.
  const [shieldOverrides, setShieldOverrides] = useState<ReadonlyMap<string, 'saved' | 'unsaved'>>(
    () => new Map(),
  );
  const [shieldBusy, setShieldBusy] = useState<ReadonlySet<string>>(() => new Set());

  // ── client-side shaping (filter → sort) over the full pending set ──
  const facetValues = (field: PendingField): readonly string[] => {
    const set = new Set<string>();
    for (const item of allItems) for (const v of fieldValuesOf(item, field)) set.add(v);
    return [...set].sort((a, b) => a.localeCompare(b));
  };

  const trimmedQuery = qParam.trim().toLowerCase();
  const filtered = allItems.filter((item) => {
    if (trimmedQuery !== '' && !item.title.toLowerCase().includes(trimmedQuery)) return false;
    for (const f of FILTER_FIELDS) {
      const wanted = filterValues(filters, f.field);
      if (wanted.length === 0) continue;
      const have = fieldValuesOf(item, f.field);
      if (!wanted.some((w) => have.includes(w))) return false;
    }
    if (ratingMin !== undefined || ratingMax !== undefined) {
      const r = itemRating(item);
      if (r === null) return false;
      if (ratingMin !== undefined && r < ratingMin) return false;
      if (ratingMax !== undefined && r > ratingMax) return false;
    }
    return true;
  });
  const items = [...filtered].sort((a, b) => compareItems(a, b, sort.field, sort.dir));
  const hasFilters =
    trimmedQuery !== '' ||
    FILTER_FIELDS.some((f) => filterValues(filters, f.field).length > 0) ||
    ratingMin !== undefined ||
    ratingMax !== undefined;
  const clearFilters = () => {
    setQuery('');
    patchParams({ q: null, genre: null, res: null, req: null, col: null, rmin: null, rmax: null });
  };

  const filteredBytes = items.reduce((sum, i) => sum + i.sizeBytes, 0);

  // ── save / un-save (same wire calls; the whole poster is now the OPTIMISTIC tap-toggle like the
  //    batch wall — owner refinement 2026-07-07: the overlay glyph swaps immediately (trash⇄shield),
  //    reconciles with the response, reverts on error; one flip in flight per tile) ──
  const [rowError, setRowError] = useState<string | null>(null);
  const save = trpc.trash.saveExclusion.useMutation();
  const unsave = trpc.trash.removeExclusion.useMutation();
  const toggleShield = (item: PendingItem, glyph: PendingWallGlyph) => {
    const id = item.maintainerrMediaId;
    if (id === null || shieldBusy.has(id)) return;
    const saving = glyph === 'trash';
    const prev = shieldOverrides.get(id);
    setShieldOverrides((m) => new Map(m).set(id, saving ? 'saved' : 'unsaved'));
    setShieldBusy((s) => new Set(s).add(id));
    setRowError(null);
    const mutation = saving ? save : unsave;
    mutation.mutate(
      { maintainerrMediaId: id, mediaItemId: item.mediaItemId },
      {
        onSuccess: () => void utils.trash.pending.invalidate({ media }),
        onError: (err: unknown) => {
          setShieldOverrides((m) => {
            const next = new Map(m);
            if (prev === undefined) next.delete(id);
            else next.set(id, prev);
            return next;
          });
          setRowError(describeMutationError(err));
        },
        onSettled: () =>
          setShieldBusy((s) => {
            const next = new Set(s);
            next.delete(id);
            return next;
          }),
      },
    );
  };

  // ── expedite (THE destructive path — Modal every time, ADR-014) ──
  const [expedite, setExpedite] = useState<ExpediteTarget | null>(null);
  const [outcome, setOutcome] = useState<ExpediteOutcome | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const afterExpedite = (res: ExpediteOutcome) => {
    setModalError(null);
    setOutcome(res);
    void utils.trash.pending.invalidate();
    void utils.trash.status.invalidate();
  };
  const onExpediteError = (err: unknown) => {
    // F3 — refetch on EVERY error code (not just MAINTAINERR_UNSAFE): a partial/failed run can leave
    // the pending set and thus the confirm's deleted/protected/skipped partition stale, so we always
    // re-partition against fresh data. MAINTAINERR_UNSAFE (item no longer pending, or the install
    // turned unsafe between the banner read and the call) shows the calm "nothing deleted" state.
    const action = expediteErrorAction(appCodeOf(err), describeMutationError(err));
    void utils.trash.pending.invalidate();
    void utils.trash.status.invalidate();
    setStale(action.stale);
    setModalError(action.message);
  };
  const expediteAll = trpc.trash.expediteAll.useMutation({
    onError: onExpediteError,
    onSuccess: afterExpedite,
  });
  const expediteBusy = expediteAll.isPending;

  const openExpedite = (target: ExpediteTarget) => {
    setOutcome(null);
    setModalError(null);
    setStale(false);
    setExpedite(target);
  };
  const closeExpedite = () => {
    if (expediteBusy) return;
    setExpedite(null);
    setOutcome(null);
    setModalError(null);
    setStale(false);
  };

  // The Modal's honest preview — the ENTIRE pending set for 'all' (never the filtered view).
  const partition = partitionForExpedite(allItems);

  // ── the sort bar (shared nextSort/arrowFor cycle over SORT_COLUMNS) ──
  const clickCycle = Object.fromEntries(
    SORT_COLUMNS.map((c) => [
      c.col,
      c.firstDir === 'asc'
        ? { asc: `${c.field}:asc` as SortToken, desc: `${c.field}:desc` as SortToken }
        : { asc: `${c.field}:desc` as SortToken, desc: `${c.field}:asc` as SortToken },
    ]),
  ) as Record<string, { asc: SortToken; desc: SortToken }>;
  const arrowCycle = Object.fromEntries(
    SORT_COLUMNS.map((c) => [
      c.col,
      { asc: `${c.field}:asc` as SortToken, desc: `${c.field}:desc` as SortToken },
    ]),
  ) as Record<string, { asc: SortToken; desc: SortToken }>;
  const cycleSort = (colKey: string) => {
    const next = nextSort<SortToken, string>(sortToken, colKey, clickCycle);
    patchParams({ sort: next === DEFAULT_SORT ? null : next });
  };

  return (
    <>
      <div className="library-toolbar">
        <div className="library-controls">
          <input
            type="search"
            className="library-search"
            placeholder={`Search pending ${label.toLowerCase()}…`}
            aria-label="Search the pending list"
            value={query}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="library-chipbar" role="group" aria-label="Filters">
          {FILTER_FIELDS.map((f) => (
            <FilterChip
              key={f.field}
              fieldLabel={f.label}
              values={filterValues(filters, f.field)}
              kind="enum"
              enumValues={facetValues(f.field)}
              enumLabel={f.field === 'resolution' ? (v) => RESOLUTION_LABELS[v] ?? v : undefined}
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
        </div>

        {/* Sort bar — the /library pattern (the table headers were the old affordance). */}
        <div className="library-sortbar" role="group" aria-label="Sort">
          <span className="library-sortbar__label">Sort</span>
          {SORT_COLUMNS.map((c) => {
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
                <span className="sort-btn__arrow" aria-hidden="true">
                  {arrowFor<SortToken, string>(sortToken, c.col, arrowCycle).trim()}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* The filter-aware reclaim counts bar — persistent, constant-height, ABOVE the wall
          (ADR-015); it carries the bulk Expedite-all pill. */}
      <div className="trash-countsbar" role="toolbar" aria-label="Pending totals and actions">
        <span className="trash-countsbar__total" data-testid="trash-total">
          {pending.isLoading
            ? 'Totaling…'
            : `${reclaimLabel(filteredBytes, items.length, formatBytes)}${
                hasFilters ? ` · filtered from ${allItems.length} pending` : ''
              }`}
        </span>
        <span className="ledger-actionsbar__spacer" />
        {canExpediteAll ? (
          <button
            type="button"
            className="btn sm danger"
            data-testid="trash-expedite-all"
            disabled={!safe || allItems.length === 0}
            title={
              safe
                ? `Expedite the entire pending ${label} set`
                : 'Disabled — Maintainerr is not in a safe state (see the banner).'
            }
            onClick={() => openExpedite({ scope: 'all' })}
          >
            Expedite all…
          </button>
        ) : null}
      </div>

      {/* Fixed-height error slot — an error appearing recolors the line, never shifts the wall. */}
      <p className="bwall-error" role="alert" data-testid="trash-wall-error">
        {rowError ?? ''}
      </p>

      {/* THE PENDING WALL — the Batches wall grammar over the pending set (tables retired
          2026-07-07). Poster taps open /library/[id]; the corners carry the actions. */}
      {pending.isLoading ? (
        <ul className="bwall" aria-hidden="true" data-testid="trash-wall-skeleton">
          {Array.from({ length: 8 }, (_, i) => (
            <li key={i} className="bwall-tile">
              <span className="bwall-tap">
                <div className="poster-box" />
              </span>
              <span className="bwall-caption">
                <span className="skeleton-line" />
              </span>
              <span className="bwall-meta">
                <span className="skeleton-line skeleton-line--short" />
              </span>
            </li>
          ))}
        </ul>
      ) : pending.error ? (
        <p className="alert" role="alert">
          Couldn’t load the pending list: {pending.error.message}
        </p>
      ) : items.length === 0 ? (
        <p className="muted trash-wall-empty" data-testid="trash-wall-empty">
          {allItems.length === 0
            ? `Nothing pending — no ${label.toLowerCase()} are scheduled for deletion.`
            : 'Nothing matches the filters.'}
        </p>
      ) : (
        <ul
          className={`bwall pwall${refreshing ? ' is-refreshing' : ''}`}
          aria-busy={refreshing}
          aria-label={`Pending ${label} deletions`}
          data-testid="trash-wall"
        >
          {items.map((item) => {
            const rating = formatRating(itemRating(item));
            const override =
              item.maintainerrMediaId === null
                ? undefined
                : shieldOverrides.get(item.maintainerrMediaId);
            const glyph = pendingWallGlyph(item, override);
            const tappable =
              item.maintainerrMediaId !== null &&
              pendingWallTappable(glyph, canSave, canUnsave);
            const tileKey = `${item.collectionId}:${item.maintainerrMediaId ?? item.title}`;
            const info = tileInfo(item, glyph);
            const titleYear = `${item.title}${item.year !== null ? ` (${item.year})` : ''}`;
            // The whole poster is the tap-toggle (owner refinement): trash ⇄ shield.
            const toggleLabel =
              glyph === 'shield'
                ? tappable
                  ? `Un-save ${item.title} — remove its deletion protection`
                  : `${item.title} is saved — protected from deletion`
                : glyph === 'check'
                  ? `${item.title} is protected from deletion`
                  : glyph === 'eye'
                    ? `${item.title} was watched recently — the guardian keeps it`
                    : tappable
                      ? `${item.title} is slated to delete — tap to save it`
                      : `${item.title} is slated to delete`;
            const inner = (
              <>
                <MediaPoster
                  posterUrl={item.posterUrl}
                  kind={media === 'movie' ? 'radarr' : 'sonarr'}
                  alt=""
                />
                <span key={glyph} className="bwall-overlay" data-glyph={glyph} aria-hidden="true">
                  <WallGlyphSvg glyph={glyph} />
                </span>
              </>
            );
            return (
              <li
                key={tileKey}
                className="bwall-tile pwall-tile"
                data-glyph={glyph}
                data-testid="trash-tile"
              >
                {tappable ? (
                  <button
                    type="button"
                    className="bwall-tap"
                    data-testid="trash-toggle"
                    aria-pressed={glyph === 'shield'}
                    aria-label={toggleLabel}
                    title={info}
                    aria-busy={
                      (item.maintainerrMediaId !== null &&
                        shieldBusy.has(item.maintainerrMediaId)) ||
                      undefined
                    }
                    onClick={() => toggleShield(item, glyph)}
                  >
                    {inner}
                  </button>
                ) : (
                  <span
                    className="bwall-tap"
                    data-testid="trash-toggle"
                    data-inert="true"
                    role="img"
                    aria-label={toggleLabel}
                    title={info}
                  >
                    {inner}
                  </span>
                )}
                {/* The /library nav corner — distinct from the poster toggle (owner refinement),
                    carrying the ?from context so the item page returns here (Part 2). */}
                {item.mediaItemId !== null ? (
                  <LibraryCornerLink
                    href={`/library/${item.mediaItemId}?from=${fromKey}`}
                    title={`Open ${titleYear} — history and fixes`}
                    ariaLabel={`Open ${titleYear} — its library page`}
                  />
                ) : null}
                <span className="bwall-caption">
                  {item.title}
                  {item.year !== null ? <span className="muted"> ({item.year})</span> : null}
                </span>
                <span className="bwall-meta">
                  {item.sizeBytes > 0 ? formatBytes(item.sizeBytes) : '—'}
                  {rating !== null ? ` · ★ ${rating}` : ''}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {/* ADR-014 — the Expedite Modal (never one-click delete). */}
      <Modal
        open={expedite !== null}
        title={outcome !== null ? 'Expedite report' : 'Expedite deletion'}
        onClose={closeExpedite}
        banner={
          modalError !== null ? (
            <p className="alert" role="alert">
              {modalError}
            </p>
          ) : null
        }
      >
        {expedite === null ? null : stale ? (
          <div className="trash-confirm" data-testid="trash-expedite-stale">
            <p>
              <strong>Nothing was deleted.</strong> Maintainerr refused — the item is no longer
              pending, or the install just failed its safety check. The pending list has been
              refreshed; check the banner and try again from the current list.
            </p>
            <div className="form-actions">
              <button type="button" className="btn" onClick={closeExpedite}>
                Close
              </button>
            </div>
          </div>
        ) : outcome !== null ? (
          <ExpediteReport outcome={outcome} onClose={closeExpedite} />
        ) : hasFilters ? (
          <div className="trash-confirm" data-testid="trash-expedite-refusal">
            <p className="alert" role="alert">
              Filters can’t scope “Expedite all” — it processes the <strong>entire</strong> pending{' '}
              {label} set ({allItems.length} item{allItems.length === 1 ? '' : 's'}), including the{' '}
              {allItems.length - items.length} your filters currently hide.
            </p>
            <p className="muted">
              Clear the filters to expedite the whole set, or open a specific title and use{' '}
              <strong>Delete now…</strong> on its page.
            </p>
            <div className="form-actions">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  clearFilters();
                }}
              >
                Clear filters
              </button>
              <button type="button" className="btn" onClick={closeExpedite}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="trash-confirm" data-testid="trash-expedite-all-confirm">
            <p>
              Expedite the <strong>entire pending {label} set</strong> — {allItems.length} item
              {allItems.length === 1 ? '' : 's'}. Maintainerr will process each item individually:
            </p>
            <ul className="ledger-confirm__outcomes">
              <li>
                <strong className="trash-danger-text">
                  {partition.deletable} will be deleted NOW
                </strong>{' '}
                — immediate and permanent, freeing {formatBytes(partition.deletableBytes)}.
              </li>
              <li>
                <strong>{partition.protected} protected</strong> — recently watched, requested, or
                whitelisted; Maintainerr keeps them.
              </li>
              <li>
                <strong>{partition.unverifiable} kept — can’t be verified safe</strong> — unknown to
                the ledger, so they are skipped, never deleted.
              </li>
            </ul>
            {partition.deletable === 0 ? (
              <p className="muted">
                Every pending item is protected or unverifiable — there is nothing to delete.
              </p>
            ) : null}
            <div className="form-actions">
              <button
                type="button"
                className="btn danger"
                data-testid="trash-expedite-all-submit"
                disabled={expediteBusy || partition.deletable === 0}
                onClick={() =>
                  // F2 — pin the run to the snapshot the user SAW (the entire pending set; filters
                  // can't scope Expedite all). The server processes only this ∩ the current pending
                  // set, so items that became pending after the modal opened are never deleted.
                  expediteAll.mutate({
                    media,
                    maintainerrMediaIds: allItems
                      .map((i) => i.maintainerrMediaId)
                      .filter((id): id is string => id !== null),
                  })
                }
              >
                {expediteBusy
                  ? 'Deleting…'
                  : `Delete ${partition.deletable} item${partition.deletable === 1 ? '' : 's'} now`}
              </button>
              <button type="button" className="btn" disabled={expediteBusy} onClick={closeExpedite}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

// ── Recently Deleted (D-06 — our tombstoned ledger rows) ────────────────────────────────

function RecentlyDeletedTab({ access }: { access: TrashAccess }) {
  const utils = trpc.useUtils();
  const movies = trpc.trash.recentlyDeleted.useQuery({ media: 'movie' });
  const tv = trpc.trash.recentlyDeleted.useQuery({ media: 'tv' });
  const canRestore = access.actions.includes('restore_deleted');
  const [rowStatus, setRowStatus] = useState<ReadonlyMap<string, { ok: boolean; text: string }>>(
    () => new Map(),
  );

  const restore = trpc.trash.restoreDeleted.useMutation();
  const restoreRow = async (mediaItemId: string, media: 'movie' | 'tv') => {
    try {
      const res = await restore.mutateAsync({ media, mediaItemId });
      setRowStatus((prev) =>
        new Map(prev).set(mediaItemId, {
          ok: true,
          text: res.status === 'completed' ? 'Re-added' : `Run ${res.status.replaceAll('_', ' ')}`,
        }),
      );
      void utils.trash.recentlyDeleted.invalidate();
    } catch (err) {
      setRowStatus((prev) =>
        new Map(prev).set(mediaItemId, { ok: false, text: describeMutationError(err) }),
      );
      return 'failed' as const;
    }
    return 'ok' as const;
  };

  if (movies.isLoading || tv.isLoading) return <p className="muted">Loading recently deleted…</p>;
  const loadError = movies.error ?? tv.error;
  if (loadError) {
    return (
      <p className="alert" role="alert">
        Couldn’t load the recently-deleted list: {loadError.message}
      </p>
    );
  }

  const rows = [
    ...(movies.data ?? []).map((r) => ({ ...r, media: 'movie' as const })),
    ...(tv.data ?? []).map((r) => ({ ...r, media: 'tv' as const })),
  ].sort((a, b) => {
    const ax = a.deletedAt === null ? 0 : Date.parse(a.deletedAt);
    const bx = b.deletedAt === null ? 0 : Date.parse(b.deletedAt);
    return bx - ax;
  });

  if (rows.length === 0) {
    return <p className="muted">Nothing here — no movies or shows have been deleted recently.</p>;
  }

  return (
    <table className="admin-table trash-deleted" data-testid="trash-deleted">
      <thead>
        <tr>
          <th>Title</th>
          <th>Kind</th>
          <th>Size</th>
          <th>Deleted</th>
          <th>By</th>
          <th>Restore</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const status = rowStatus.get(row.mediaItemId);
          return (
            <tr key={row.mediaItemId} data-testid="trash-deleted-row">
              <td data-label="Title">
                <span className="trash-titlecell">
                  <span className="trash-poster" aria-hidden="true">
                    <MediaPoster posterUrl={row.posterUrl} kind={row.arrKind} alt="" />
                  </span>
                  <Link href={`/library/${row.mediaItemId}`} className="ledger-title">
                    {row.title}
                  </Link>
                  {row.year !== null ? <span className="muted"> ({row.year})</span> : null}
                </span>
              </td>
              <td data-label="Kind">
                <span className="badge badge--muted">{row.media === 'movie' ? 'Movie' : 'TV'}</span>
              </td>
              <td data-label="Size">{row.sizeOnDisk > 0 ? formatBytes(row.sizeOnDisk) : '—'}</td>
              <td data-label="Deleted">
                {row.deletedAt !== null ? formatDay(row.deletedAt) : '—'}
              </td>
              <td data-label="By" data-testid="trash-deleted-by">
                {row.deletedBy !== null ? (
                  row.deletedBy
                ) : (
                  <span className="muted" title="Removed by a sync pass — no app user attributed.">
                    System
                  </span>
                )}
              </td>
              <td data-label="Restore">
                {status !== undefined ? (
                  <span
                    className={`badge badge--${status.ok ? 'ok' : 'danger'}`}
                    data-testid="trash-restore-status"
                    title={
                      status.ok
                        ? 'Re-added to the manager — this row clears on the next sync.'
                        : status.text
                    }
                  >
                    {status.text}
                  </span>
                ) : canRestore ? (
                  <ConfirmButton
                    className="btn sm"
                    data-testid="trash-restore"
                    label="Restore"
                    reArmOnFailure
                    restingAriaLabel={`Restore ${row.title} — re-add it to the media manager — click twice to confirm`}
                    confirmAriaLabel={`Confirm restore ${row.title}`}
                    onConfirm={() => restoreRow(row.mediaItemId, row.media)}
                  />
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── Activity (D-07 — the Maintainerr notification feed; PLAN-009 extends this) ──────────

function ActivityTab() {
  const activity = trpc.trash.activity.useQuery({ limit: 50 });
  if (activity.isLoading) return <p className="muted">Loading activity…</p>;
  if (activity.error) {
    return (
      <p className="alert" role="alert">
        Couldn’t load the activity feed: {activity.error.message}
      </p>
    );
  }
  const rows = activity.data ?? [];
  if (rows.length === 0) {
    return (
      <p className="muted">
        No Maintainerr activity yet — deletion-lifecycle events land here as Maintainerr reports
        them.
      </p>
    );
  }
  return (
    <ol className="timeline trash-activity" data-testid="trash-activity">
      {rows.map((n) => (
        <li key={n.id}>
          <span className="timeline__type">{n.title ?? n.type ?? 'Event'}</span>
          <span className="timeline__detail">{n.body ?? ''}</span>
          <span className="muted timeline__when">{formatWhen(n.createdAt)}</span>
        </li>
      ))}
    </ol>
  );
}

// ── the section shell ───────────────────────────────────────────────────────────────────

function TrashContent({
  access,
  viewerId,
  viewerIsAdmin,
}: {
  access: TrashAccess;
  viewerId: string;
  viewerIsAdmin: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const rawTab = searchParams.get('tab');
  const active = resolveTab(rawTab);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const status = trpc.trash.status.useQuery();
  // DESIGN-010 amendment — fetched ONCE at the shell for BOTH the Overview cards and the Movies/TV
  // tab badges (the same slated count in both places — one wire read, no double query).
  const overview = trpc.trash.overview.useQuery();
  const overviewByKind = useMemo(() => {
    const map = new Map<'movie' | 'tv', OverviewData['kinds'][number]>();
    for (const k of overview.data?.kinds ?? []) map.set(k.kind, k);
    return map;
  }, [overview.data]);

  const selectTab = (key: TabKey) => {
    // Same contract as /library and /ledger: switching keeps ONLY ?tab.
    const params = new URLSearchParams();
    params.set('tab', key);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  // ADR-033 — canonicalize the retired `?tab=batches` deep link: the old kind seg (`?kind=tv`)
  // maps to the TV tab, else Movies. Clears the dead `?kind`/`?batch` params in one replace.
  useEffect(() => {
    if (rawTab !== 'batches') return;
    const params = new URLSearchParams();
    params.set('tab', searchParams.get('kind') === 'tv' ? 'tv' : 'movies');
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [rawTab, searchParams, pathname, router]);

  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (e.key === 'ArrowRight') next = (index + 1) % TRASH_TABS.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + TRASH_TABS.length) % TRASH_TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TRASH_TABS.length - 1;
    else return;
    e.preventDefault();
    const target = TRASH_TABS[next];
    if (!target) return;
    selectTab(target.key);
    tabRefs.current[next]?.focus();
  };

  return (
    <>
      <h1 className="page-title">Trash</h1>

      <SafetyBanner
        status={status.data}
        loading={status.isLoading}
        failed={status.error !== null}
      />

      <div className="library-tabs" role="tablist" aria-label="Trash sections">
        {TRASH_TABS.map((tab, index) => {
          // DESIGN-010 amendment — the Movies/TV count pill (same count as the kind card;
          // suppressed at zero; warn while a window is open, danger ≤3 days). It rides INSIDE the
          // fixed-height tab row (ADR-015) and never widens it enough to reflow the tablist.
          const kind = TAB_KIND[tab.key];
          const kd = kind !== undefined ? overviewByKind.get(kind) : undefined;
          const badge = kd !== undefined ? overviewBadge(kd) : { show: false, count: 0, tone: 'muted' as const };
          const windowCloses =
            badge.tone !== 'muted' && kd?.batch?.expiresAt != null
              ? `window closes ${formatDay(kd.batch.expiresAt)}`
              : null;
          return (
            <button
              key={tab.key}
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
              type="button"
              role="tab"
              id={`trashtab-${tab.key}`}
              aria-selected={active === tab.key}
              aria-controls="trash-panel"
              tabIndex={active === tab.key ? 0 : -1}
              onClick={() => selectTab(tab.key)}
              onKeyDown={(e) => onTabKeyDown(e, index)}
            >
              <span className="trashtab__label">{tab.label}</span>
              {badge.show ? (
                <span
                  className={`trashtab__badge trashtab__badge--${badge.tone}`}
                  data-testid={`trash-tab-badge-${tab.key}`}
                  title={windowCloses ?? undefined}
                  aria-label={
                    windowCloses !== null
                      ? `${badge.count} slated — ${windowCloses}`
                      : `${badge.count} slated`
                  }
                >
                  {badge.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div id="trash-panel" role="tabpanel" aria-labelledby={`trashtab-${active}`}>
        {active === 'overview' ? (
          <TrashOverview
            overview={overview.data}
            loading={overview.isLoading}
            error={overview.error?.message ?? null}
            onOpenKind={(kind) => selectTab(kind === 'movie' ? 'movies' : 'tv')}
            onOpenTab={(tab) => selectTab(tab)}
          />
        ) : active === 'movies' ? (
          // ADR-033 — the kind tab is state-aware: no open batch ⇒ this pending wall; an open
          // batch ⇒ its lifecycle (KindTab swaps them; the wall is passed as a render prop).
          <KindTab
            key="movie"
            kind="movie"
            label="Movies"
            access={access}
            viewerId={viewerId}
            viewerIsAdmin={viewerIsAdmin}
            status={status.data}
            pendingWall={
              <PendingTab media="movie" label="Movies" access={access} status={status.data} />
            }
          />
        ) : active === 'tv' ? (
          <KindTab
            key="tv"
            kind="tv"
            label="TV"
            access={access}
            viewerId={viewerId}
            viewerIsAdmin={viewerIsAdmin}
            status={status.data}
            pendingWall={
              <PendingTab media="tv" label="TV" access={access} status={status.data} />
            }
          />
        ) : active === 'deleted' ? (
          <RecentlyDeletedTab access={access} />
        ) : (
          <ActivityTab />
        )}
      </div>
    </>
  );
}

export function TrashClient({
  access,
  viewerId,
  viewerIsAdmin,
}: {
  access: TrashAccess;
  /** The session user's id — the wall's "may I undo THIS lock?" rule needs it (D-07). */
  viewerId: string;
  /** Admin unlocks the settings card (trash.settings.* is adminProcedure). */
  viewerIsAdmin: boolean;
}) {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <TrashContent access={access} viewerId={viewerId} viewerIsAdmin={viewerIsAdmin} />
    </Suspense>
  );
}
