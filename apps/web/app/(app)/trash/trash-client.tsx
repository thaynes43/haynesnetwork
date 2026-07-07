'use client';

// ADR-023 / DESIGN-010 D-09 — the /trash section UI over the trash.* wire contracts (D-08).
// This is the app's ONLY user-facing deletion surface, so the layout leads with SAFETY:
//
// - The SAFETY BANNER (trash.status) sits above everything: green when Maintainerr is
//   connected with every required integration; a loud warning (and every destructive control
//   disabled) when an integration is down; danger when unreachable. The server re-runs the
//   audit on every expedite regardless — the banner is the honest mirror, not the enforcement.
// - Movies and TV are separate tabs, NEVER combined; Music does not exist here (R-87).
// - The pending tables ride the shared /library//ledger filter engine (chips + URL contract
//   ?q/genre/res/req/col/rmin/rmax/sort, client-side over the small pending set) inside the
//   ledger spreadsheet treatment (sticky header + frozen Title column, both-axis internal
//   scroll — the page body never pans, hard rule 9).
// - Save/whitelist is the shield toggle (protective — plain toggle, ADR-014 reserves two-step
//   for destructive); Expedite ALWAYS goes through a Modal (ADR-014 — never one-click delete),
//   whose copy predicts the guardian partition (deleted NOW / protected / skipped-unverifiable)
//   and whose post-run report distinguishes those three outcomes (skipped ≠ protected —
//   ADR-023 C-07b).
// - "Expedite all" cannot be scoped by filters (the wire contract takes only the media kind),
//   so with filters active the Modal REFUSES to arm and offers to clear them — the dangerous
//   "looks filtered, deletes everything" state is unexpressible (DESIGN-010 D-09).
// - ADR-015: the banner reserves its height; the footer bar is persistent with constant-width
//   controls; refetches dim rows in place; arming/toggling recolors, never reflows.
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useRef, useState } from 'react';
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
import { ShieldButton, type TrashAccess } from '@/components/trash-shield';
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
  daysLeftTone,
  daysUntil,
  expediteErrorAction,
  partitionForExpedite,
  previewGuardian,
  reclaimLabel,
} from '@/lib/trash';

export type { TrashAccess };

const TRASH_TABS = [
  { key: 'movies', label: 'Movies' },
  { key: 'tv', label: 'TV' },
  { key: 'deleted', label: 'Recently Deleted' },
  { key: 'rules', label: 'Rules' },
  { key: 'activity', label: 'Activity' },
] as const;
type TabKey = (typeof TRASH_TABS)[number]['key'];

function resolveTab(raw: string | null): TabKey {
  return TRASH_TABS.some((t) => t.key === raw) ? (raw as TabKey) : 'movies';
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

interface SafetyStatus {
  safe: boolean;
  reachable: boolean;
  version: string | null;
  integrations: Record<string, boolean>;
  armedRules: number;
  activeCollections: number;
}

const INTEGRATION_LABELS: Record<string, string> = {
  plex: 'Plex',
  radarr: 'Radarr',
  sonarr: 'Sonarr',
  tautulli: 'Tautulli',
  seerr: 'Seerr',
};

/** DESIGN-010 D-04 — the safety banner. Reserved height in every state (ADR-015). */
function SafetyBanner({
  status,
  loading,
  failed,
}: {
  status: SafetyStatus | undefined;
  loading: boolean;
  failed: boolean;
}) {
  let state: 'loading' | 'safe' | 'warn' | 'down';
  let body: React.ReactNode;
  if (loading) {
    state = 'loading';
    body = <span className="muted">Checking Maintainerr…</span>;
  } else if (failed || status === undefined || !status.reachable) {
    state = 'down';
    body = (
      <span>
        <strong>Maintainerr is unreachable.</strong> Trash is read-only until it’s back — nothing
        can be saved, expedited, or edited.
      </span>
    );
  } else if (!status.safe) {
    const down = Object.entries(status.integrations)
      .filter(([, ok]) => !ok)
      .map(([k]) => INTEGRATION_LABELS[k] ?? k);
    state = 'warn';
    body = (
      <span>
        <strong>Maintainerr safety check failed</strong> — {down.join(', ')} not connected. Deletion
        actions are disabled until every integration is back (the watch/keep signal chain can’t be
        trusted without them).
      </span>
    );
  } else {
    state = 'safe';
    body = (
      <span>
        <strong>Maintainerr connected</strong>
        {status.version !== null ? ` · v${status.version}` : ''} · {status.armedRules} rule
        {status.armedRules === 1 ? '' : 's'} armed · {status.activeCollections} active collection
        {status.activeCollections === 1 ? '' : 's'}
      </span>
    );
  }
  return (
    <div className="trash-safety" data-state={state} data-testid="trash-safety" role="status">
      <span className="trash-safety__dot" aria-hidden="true" />
      {body}
    </div>
  );
}

// ── the pending table (one media kind) ──────────────────────────────────────────────────

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

type ExpediteTarget = { scope: 'all' } | { scope: 'item'; item: PendingItem };
interface ExpediteOutcome {
  protectedCount: number;
  expeditedCount: number;
  skippedCount: number;
  /** F2 — scope 'all': snapshot ids that were no longer pending at run time. 0 for scope 'item'. */
  stalePending: number;
}

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
  const canExpediteItem = access.actions.includes('expedite_item');
  const canExpediteAll = access.actions.includes('expedite_all');

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

  // Session-local shield overrides (the dnd tag lands on the next *arr sync — D-09).
  const [shieldOverrides, setShieldOverrides] = useState<ReadonlyMap<string, 'saved' | 'unsaved'>>(
    () => new Map(),
  );
  const isProtected = (item: PendingItem): boolean => {
    const o =
      item.maintainerrMediaId === null ? undefined : shieldOverrides.get(item.maintainerrMediaId);
    if (o === 'saved') return true;
    if (o === 'unsaved') return false;
    // tag OR live Maintainerr exclusion (D-08/D-09) — an exclusion made outside this session shows
    // Protected before its `dnd` tag round-trips into arrTags.
    return item.protectedByTag || item.protectedByExclusion;
  };

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

  // ── save / un-save ──
  const [rowError, setRowError] = useState<string | null>(null);
  const save = trpc.trash.saveExclusion.useMutation({
    onError: (err: unknown) => setRowError(describeMutationError(err)),
    onSuccess: (_res, vars) => {
      setRowError(null);
      setShieldOverrides((prev) => new Map(prev).set(vars.maintainerrMediaId, 'saved'));
      void utils.trash.pending.invalidate({ media });
    },
  });
  const unsave = trpc.trash.removeExclusion.useMutation({
    onError: (err: unknown) => setRowError(describeMutationError(err)),
    onSuccess: (_res, vars) => {
      setRowError(null);
      setShieldOverrides((prev) => new Map(prev).set(vars.maintainerrMediaId, 'unsaved'));
      void utils.trash.pending.invalidate({ media });
    },
  });

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
  const expediteItem = trpc.trash.expediteItem.useMutation({
    onError: onExpediteError,
    onSuccess: afterExpedite,
  });
  const expediteAll = trpc.trash.expediteAll.useMutation({
    onError: onExpediteError,
    onSuccess: afterExpedite,
  });
  const expediteBusy = expediteItem.isPending || expediteAll.isPending;

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

  // ── sortable headers (shared nextSort/arrowFor cycle) ──
  interface Col {
    key: string;
    label: string;
    className?: string;
    sortField?: SortField;
    firstDir?: 'asc' | 'desc';
  }
  // A caller with no row action at all (browse-only) gets no empty Actions column.
  const showActionsCol = canSave || canUnsave || canExpediteItem;
  const cols: Col[] = [
    { key: 'title', label: 'Title', className: 'col-title', sortField: 'title', firstDir: 'asc' },
    { key: 'size', label: 'Size', sortField: 'size', firstDir: 'desc' },
    { key: 'scheduled', label: 'Deletes', sortField: 'scheduled', firstDir: 'asc' },
    { key: 'rating', label: 'Rating', sortField: 'rating', firstDir: 'desc' },
    { key: 'status', label: 'Status', className: 'col-list' },
    { key: 'requesters', label: 'Requested by', className: 'col-list' },
    { key: 'collection', label: 'Collection', className: 'col-list' },
    ...(showActionsCol ? [{ key: 'actions', label: 'Actions' }] : []),
  ];
  const sortableCols = cols.filter((c) => c.sortField !== undefined);
  const clickCycle = Object.fromEntries(
    sortableCols.map((c) => [
      c.key,
      c.firstDir === 'asc'
        ? { asc: `${c.sortField}:asc` as SortToken, desc: `${c.sortField}:desc` as SortToken }
        : { asc: `${c.sortField}:desc` as SortToken, desc: `${c.sortField}:asc` as SortToken },
    ]),
  ) as Record<string, { asc: SortToken; desc: SortToken }>;
  const arrowCycle = Object.fromEntries(
    sortableCols.map((c) => [
      c.key,
      { asc: `${c.sortField}:asc` as SortToken, desc: `${c.sortField}:desc` as SortToken },
    ]),
  ) as Record<string, { asc: SortToken; desc: SortToken }>;
  const cycleSort = (colKey: string) => {
    const next = nextSort<SortToken, string>(sortToken, colKey, clickCycle);
    patchParams({ sort: next === undefined || next === DEFAULT_SORT ? null : next });
  };

  const colCount = cols.length;

  const statusBadges = (item: PendingItem) => {
    const badges: React.ReactNode[] = [];
    if (isProtected(item)) {
      badges.push(
        <span key="prot" className="badge badge--shield" data-testid="badge-protected">
          Protected
        </span>,
      );
    }
    if (item.recentlyWatched) {
      badges.push(
        <span key="watch" className="badge badge--info" data-testid="badge-watched">
          Recently watched
        </span>,
      );
    }
    if (item.requesters.length > 0) {
      badges.push(
        <span key="req" className="badge badge--info" data-testid="badge-requested">
          Requested
        </span>,
      );
    }
    if (item.mediaItemId === null) {
      badges.push(
        <span
          key="unk"
          className="badge badge--warn"
          data-testid="badge-unverified"
          title="Not in our ledger — it can never be expedited (fail closed), only saved."
        >
          Not in ledger
        </span>,
      );
    }
    return badges.length > 0 ? badges : <span className="muted">—</span>;
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
      </div>

      {rowError !== null ? (
        <p className="alert" role="alert">
          {rowError}
        </p>
      ) : null}

      <div
        className={`ledger-tablewrap trash-tablewrap${refreshing ? ' is-refreshing' : ''}`}
        data-testid="trash-tablewrap"
      >
        <table
          className="ledger-table ledger-table--noselect trash-table"
          aria-busy={refreshing}
          aria-label={`Pending ${label} deletions`}
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
                    {sortButton}
                  </th>
                );
              })}
            </tr>
          </thead>
          {pending.isLoading ? (
            <tbody data-testid="trash-skeleton" aria-hidden="true">
              {Array.from({ length: 4 }, (_, i) => (
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
          ) : pending.error ? (
            <tbody>
              <tr>
                <td colSpan={colCount}>
                  <p className="alert" role="alert">
                    Couldn’t load the pending list: {pending.error.message}
                  </p>
                </td>
              </tr>
            </tbody>
          ) : items.length === 0 ? (
            <tbody>
              <tr>
                <td colSpan={colCount} className="ledger-empty muted">
                  {allItems.length === 0
                    ? `Nothing pending — no ${label.toLowerCase()} are scheduled for deletion.`
                    : 'Nothing matches the filters.'}
                </td>
              </tr>
            </tbody>
          ) : (
            <tbody>
              {items.map((item) => {
                const rating = formatRating(itemRating(item));
                const days = daysUntil(item.scheduledDeleteAt);
                const on = isProtected(item);
                const rowKey = `${item.collectionId}:${item.maintainerrMediaId ?? item.title}`;
                return (
                  <tr key={rowKey} className="ledger-row" data-testid="trash-row">
                    <td className="col-title">
                      <span className="ledger-titlecell trash-titlecell">
                        <span className="trash-poster" aria-hidden="true">
                          <MediaPoster
                            posterUrl={item.posterUrl}
                            kind={media === 'movie' ? 'radarr' : 'sonarr'}
                            alt=""
                          />
                        </span>
                        {item.mediaItemId !== null ? (
                          <Link
                            href={`/library/${item.mediaItemId}`}
                            className="ledger-title"
                            title={item.title}
                          >
                            {item.title}
                          </Link>
                        ) : (
                          <span className="ledger-title" title={item.title}>
                            {item.title}
                          </span>
                        )}
                        {item.year !== null ? <span className="muted"> ({item.year})</span> : null}
                      </span>
                    </td>
                    <td className="col-num">
                      {item.sizeBytes > 0 ? formatBytes(item.sizeBytes) : '—'}
                    </td>
                    <td className="trash-when">
                      {item.scheduledDeleteAt !== null ? (
                        <>
                          {formatDay(item.scheduledDeleteAt)}{' '}
                          <span className={`trash-days trash-days--${daysLeftTone(days)}`}>
                            {daysLeftLabel(days)}
                          </span>
                        </>
                      ) : (
                        <span className="muted">no date</span>
                      )}
                    </td>
                    <td className="col-num">{rating !== null ? `★ ${rating}` : '—'}</td>
                    <td className="col-list trash-status">{statusBadges(item)}</td>
                    <td className="col-list" title={item.requesters.join(', ')}>
                      {item.requesters.length > 0 ? item.requesters.join(', ') : '—'}
                    </td>
                    <td className="col-list" title={item.collectionTitle ?? undefined}>
                      {item.collectionTitle ?? '—'}
                    </td>
                    <td className="trash-actions">
                      <span className="row-actions">
                        {(canSave || canUnsave) && item.maintainerrMediaId !== null ? (
                          <ShieldButton
                            on={on}
                            itemTitle={item.title}
                            canSave={canSave}
                            canUnsave={canUnsave}
                            busy={save.isPending || unsave.isPending}
                            onSave={() =>
                              save.mutate({
                                maintainerrMediaId: item.maintainerrMediaId!,
                                mediaItemId: item.mediaItemId,
                              })
                            }
                            onUnsave={() =>
                              unsave.mutate({
                                maintainerrMediaId: item.maintainerrMediaId!,
                                mediaItemId: item.mediaItemId,
                              })
                            }
                          />
                        ) : null}
                        {canExpediteItem && item.maintainerrMediaId !== null ? (
                          <button
                            type="button"
                            className="btn sm danger"
                            data-testid="trash-expedite-item"
                            disabled={!safe}
                            title={
                              safe
                                ? `Expedite the deletion of ${item.title}`
                                : 'Disabled — Maintainerr is not in a safe state (see the banner).'
                            }
                            onClick={() => openExpedite({ scope: 'item', item })}
                          >
                            Expedite
                          </button>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          )}
        </table>
      </div>

      {/* The filter-aware total-space footer — persistent, constant-height (ADR-015). */}
      <div className="trash-footer" role="toolbar" aria-label="Pending totals and actions">
        <span className="trash-footer__total" data-testid="trash-total">
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
        ) : expedite.scope === 'item' ? (
          <ExpediteItemConfirm
            item={expedite.item}
            busy={expediteBusy}
            onCancel={closeExpedite}
            onConfirm={() =>
              expediteItem.mutate({
                media,
                collectionId: expedite.item.collectionId,
                maintainerrMediaId: expedite.item.maintainerrMediaId!,
                mediaItemId: expedite.item.mediaItemId,
              })
            }
          />
        ) : hasFilters ? (
          <div className="trash-confirm" data-testid="trash-expedite-refusal">
            <p className="alert" role="alert">
              Filters can’t scope “Expedite all” — it processes the <strong>entire</strong> pending{' '}
              {label} set ({allItems.length} item{allItems.length === 1 ? '' : 's'}), including the{' '}
              {allItems.length - items.length} your filters currently hide.
            </p>
            <p className="muted">
              Clear the filters to expedite the whole set, or use each row’s Expedite button for
              specific items.
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

/**
 * The single-item confirm body — copy keyed to the guardian's predicted verdict.
 *
 * F1(b) (2026-07-06 review): the verdict comes SOLELY from the unit-tested guardian mirror
 * (`previewGuardian`) over the item's server-declared fields — never the session-local shield
 * override. The old short-circuit ("saved this session ⇒ protected_tag ⇒ nothing deletes") reported
 * a protection the server did not yet honor. With the server-side live-exclusion seam (F1a) a
 * genuinely-saved item is now protected server-side, so the honest outcome shows in the report; the
 * shield badge stays display-only.
 */
function ExpediteItemConfirm({
  item,
  busy,
  onCancel,
  onConfirm,
}: {
  item: PendingItem;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const verdict = previewGuardian(item);
  const title = `${item.title}${item.year !== null ? ` (${item.year})` : ''}`;
  return (
    <div className="trash-confirm" data-testid="trash-expedite-item-confirm">
      <p>
        Expedite <strong>{title}</strong>
        {item.sizeBytes > 0 ? <> — {formatBytes(item.sizeBytes)} on disk.</> : '.'}
      </p>
      {verdict === 'deletable' ? (
        <p className="alert" role="alert">
          This deletes the files <strong>NOW</strong> — immediate and permanent. It is not the
          scheduled cleanup; there is no undo beyond a re-download via Restore.
        </p>
      ) : verdict === 'unverifiable' ? (
        <p className="status-note status-note--warn">
          This item can’t be verified safe (it isn’t in our ledger), so the server will{' '}
          <strong>keep it</strong> — nothing will be deleted.
        </p>
      ) : (
        <p className="status-note">
          This item is{' '}
          {verdict === 'protected_watched'
            ? 'recently watched'
            : verdict === 'protected_requested'
              ? 'personally requested'
              : 'whitelisted'}{' '}
          — instead of deleting, Maintainerr will <strong>protect it</strong> (auto-whitelist).
        </p>
      )}
      <div className="form-actions">
        <button
          type="button"
          className={`btn ${verdict === 'deletable' ? 'danger' : 'primary'}`}
          data-testid="trash-expedite-item-submit"
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? 'Working…' : verdict === 'deletable' ? 'Delete now' : 'Run it (nothing deletes)'}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The post-run report — deleted / protected / skipped are THREE different things (ADR-023
 *  C-07b): skipped means "could not be verified safe, kept", NOT deliberately whitelisted. */
function ExpediteReport({ outcome, onClose }: { outcome: ExpediteOutcome; onClose: () => void }) {
  return (
    <div className="trash-confirm" data-testid="trash-expedite-report">
      <p className="ledger-report__summary" data-testid="trash-expedite-summary">
        <span className={`badge badge--${outcome.expeditedCount > 0 ? 'danger' : 'muted'}`}>
          {outcome.expeditedCount} deleted
        </span>{' '}
        <span className={`badge badge--${outcome.protectedCount > 0 ? 'ok' : 'muted'}`}>
          {outcome.protectedCount} protected
        </span>{' '}
        <span className={`badge badge--${outcome.skippedCount > 0 ? 'warn' : 'muted'}`}>
          {outcome.skippedCount} skipped
        </span>
        {outcome.stalePending > 0 ? (
          <>
            {' '}
            <span className="badge badge--muted" data-testid="trash-expedite-stale-count">
              {outcome.stalePending} no longer pending
            </span>
          </>
        ) : null}
      </p>
      <ul className="ledger-confirm__outcomes">
        <li>
          <strong>Deleted</strong> — handed to Maintainerr’s per-item delete handler; the files are
          being removed now.
        </li>
        <li>
          <strong>Protected</strong> — deliberately kept: recently watched, requested, or
          whitelisted/saved (watched/requested items were auto-whitelisted during this run).
        </li>
        <li>
          <strong>Skipped</strong> — could not be verified safe <em>or</em> its protection could not
          be applied, so it was <em>kept, never deleted</em>. Not the same as protected: these items
          are unknown to the ledger (or unactionable) and are never deleted blind.
        </li>
        {outcome.stalePending > 0 ? (
          <li>
            <strong>No longer pending</strong> — you saw these when you opened the dialog, but
            Maintainerr’s pending set changed before the run, so they were left untouched.
          </li>
        ) : null}
      </ul>
      <div className="form-actions">
        <button type="button" className="btn" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
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

// ── Rules (readable list + arm/disarm/delete this pass — DESIGN-010 D-09 scope) ─────────

/** GET /rules `dataType` is a STRING `MediaItemType` ('movie'|'show'|'season'|'episode') on v3.17.0
 *  (verified against source — the rule_group column is varchar; DESIGN-010 D-02 flag (a), resolved).
 *  Display-only: we still accept the legacy numeric spelling (1=movie…) defensively, but this label
 *  NEVER feeds the arm/disarm PUT — that round-trips dataType verbatim (a coerced value would be a
 *  crucial-setting change that wipes the collection). */
function ruleKindLabel(dataType: unknown): string {
  if (dataType === 1 || dataType === 'movie') return 'Movies';
  if (dataType === 2 || dataType === 'show') return 'TV';
  if (dataType === 3 || dataType === 'season') return 'TV (seasons)';
  if (dataType === 4 || dataType === 'episode') return 'TV (episodes)';
  return '—';
}

function RulesTab({ access, reachable }: { access: TrashAccess; reachable: boolean }) {
  const utils = trpc.useUtils();
  const rules = trpc.trash.rules.useQuery();
  const [error, setError] = useState<string | null>(null);
  const canEditRules =
    access.level === 'edit' && access.actions.includes('edit_rules') && reachable;

  const invalidate = () => {
    void utils.trash.rules.invalidate();
    void utils.trash.status.invalidate();
  };
  const saveRule = trpc.trash.saveRule.useMutation({
    onError: (err: unknown) => setError(describeMutationError(err)),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
  });
  const deleteRule = trpc.trash.deleteRule.useMutation({
    onError: (err: unknown) => setError(describeMutationError(err)),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
  });
  const busy = saveRule.isPending || deleteRule.isPending;

  if (rules.isLoading) return <p className="muted">Loading rules…</p>;
  if (rules.error) {
    return (
      <p className="alert" role="alert">
        Couldn’t load the rules: {rules.error.message}
      </p>
    );
  }
  const list = rules.data ?? [];

  return (
    <div data-testid="trash-rules">
      <p className="muted">
        Maintainerr’s rules decide what lands in the pending tables.{' '}
        {canEditRules
          ? 'You can arm, disarm, or delete a rule here; building new rules still happens in Maintainerr for now.'
          : 'Read-only — changing rules needs Trash access = Edit plus the edit-rules grant.'}
      </p>
      {error !== null ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {list.length === 0 ? (
        <p className="muted">No rules configured — nothing is scheduled for deletion.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Rule</th>
              <th>Applies to</th>
              <th>Deletes after</th>
              <th>State</th>
              {canEditRules ? <th>Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {list.map((rule, i) => {
              // The wire schema is passthrough (round-trip PUTs) — normalize the shell keys.
              const ruleId = typeof rule.id === 'number' ? rule.id : null;
              const ruleName = typeof rule.name === 'string' ? rule.name : `Rule ${ruleId ?? i}`;
              const description = typeof rule.description === 'string' ? rule.description : '';
              const collection = (rule.collection ?? {}) as Record<string, unknown>;
              const deleteAfterDays =
                typeof collection.deleteAfterDays === 'number' ? collection.deleteAfterDays : null;
              const active = rule.isActive === true;
              return (
                <tr key={ruleId ?? i} data-testid="trash-rule-row">
                  <td data-label="Rule">
                    <strong>{ruleName}</strong>
                    {description !== '' ? <span className="muted"> — {description}</span> : null}
                  </td>
                  <td data-label="Applies to">{ruleKindLabel(rule.dataType)}</td>
                  <td data-label="Deletes after">
                    {deleteAfterDays !== null ? `${deleteAfterDays} days` : '—'}
                  </td>
                  <td data-label="State">
                    <span className={`badge badge--${active ? 'warn' : 'muted'}`}>
                      {active ? 'Armed' : 'Disarmed'}
                    </span>
                  </td>
                  {canEditRules ? (
                    <td data-label="Actions">
                      <span className="row-actions">
                        <button
                          type="button"
                          className="btn sm"
                          data-testid="trash-rule-toggle"
                          disabled={busy}
                          onClick={() =>
                            saveRule.mutate({ payload: { ...rule, isActive: !active } })
                          }
                        >
                          {active ? 'Disarm' : 'Arm'}
                        </button>
                        {ruleId !== null ? (
                          <ConfirmButton
                            className="btn sm danger"
                            data-testid="trash-rule-delete"
                            disabled={busy}
                            label="Delete"
                            restingAriaLabel={`Delete rule ${ruleName} — its collection stops scheduling deletions — click twice to confirm`}
                            confirmAriaLabel={`Confirm delete rule ${ruleName}`}
                            onConfirm={() => deleteRule.mutate({ ruleGroupId: ruleId })}
                          />
                        ) : null}
                      </span>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
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

function TrashContent({ access }: { access: TrashAccess }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = resolveTab(searchParams.get('tab'));
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const status = trpc.trash.status.useQuery();

  const selectTab = (key: TabKey) => {
    // Same contract as /library and /ledger: switching keeps ONLY ?tab.
    const params = new URLSearchParams();
    params.set('tab', key);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

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
        {TRASH_TABS.map((tab, index) => (
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
            {tab.label}
          </button>
        ))}
      </div>

      <div id="trash-panel" role="tabpanel" aria-labelledby={`trashtab-${active}`}>
        {active === 'movies' ? (
          <PendingTab
            key="movie"
            media="movie"
            label="Movies"
            access={access}
            status={status.data}
          />
        ) : active === 'tv' ? (
          <PendingTab key="tv" media="tv" label="TV" access={access} status={status.data} />
        ) : active === 'deleted' ? (
          <RecentlyDeletedTab access={access} />
        ) : active === 'rules' ? (
          <RulesTab access={access} reachable={status.data?.reachable === true} />
        ) : (
          <ActivityTab />
        )}
      </div>
    </>
  );
}

export function TrashClient({ access }: { access: TrashAccess }) {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <TrashContent access={access} />
    </Suspense>
  );
}
