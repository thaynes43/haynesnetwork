'use client';

// ADR-057 / DESIGN-029 (PLAN-045) — the Goodreads SUB-SECTION: two ?tab= views over one route (the
// Metrics/Trash hub precedent; a tab switch is a SCREEN-level change → router.push, D-19):
//
//   • OVERVIEW (the stats page) — the fixed link card (PR #258 UX), the WANT-SHELF headline
//     coverage (owner ruling Q-02), the per-shelf breakdown + request/Missing summary tiles (the
//     Trash-Overview card idiom; a card click pushes into the items wall pre-filtered), last-sync.
//   • ITEMS — a REAL library wall over every synced shelf, rendered as the SAME cohesive poster block
//     as the Movies/Books walls (owner-corrected, DESIGN-029 amendment): `.media-list.poster-grid` of
//     `media-card poster-card` tiles (MediaPoster cover where the want matched, the designed KindIcon
//     tile elsewhere) + the shared card-family caption (title, author, ONE shelf + ONE status
//     badge), the shared filter/sort chrome, and the SHELF CHIPS — exactly the Helpdesk ticket
//     state-chip semantics (multi-select union, superset "All", counts, repeated `?shelf=` params via
//     router.replace, populated-value-gated — DESIGN-012 D-12 ported).
//
// PLAN-047 (owner Wanted-parity ruling — DESIGN-029 amendment-2): each item card is now a WHOLE-card
// click-through (the Movies/TV poster→detail idiom) — a "Have it" card opens the library detail
// (`/library/books/[id]`), any other want opens the Wanted DETAIL page (`/library/books/wanted/[requestId]`)
// where per-format Force-Search + requester attribution live. The old corner force-search puck is retired.
//
// The v0.49.0 flat Requests & Missing wall FOLDED INTO this sub-section: the items wall subsumes it
// (poster tiles + status badge), and the overview carries its summary.
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ConfirmButton, nextSort, arrowFor } from '@hnet/ui';
import { KindIcon } from '@/components/kind-icon';
import {
  PosterGrid,
  PosterGridSkeleton,
  RequestCard,
  activityStageBadge,
  type PosterBadge,
  type InFlightBadge,
  type CardActivityStage,
} from '@/components/cards';
import { trpc, type RouterOutputs } from '@/lib/trpc-client';
import { coverageView, isFirstSyncPending } from '@/lib/integrations-coverage';
import {
  PHASE_META,
  SHELF_WALL_SORTS,
  filterShelfWallItems,
  shelfLabel,
  shelfParamsForSelection,
  shelfSelectionFromParams,
  shelfSort,
  sortShelfWallItems,
  toggleShelf,
  type RequestPhaseName,
  type ShelfWallSort,
} from '@/lib/goodreads-shelf-wall';
import type { BookRequestStatus } from '@hnet/db';

const PENDING_POLL_MS = 4000;

type ItemWire = RouterOutputs['integrations']['items']['items'][number];
type OverviewWire = RouterOutputs['integrations']['overview'];

const STATUS_LABEL: Record<BookRequestStatus, string> = {
  requested: 'Requested',
  wanted: 'Wanted',
  grabbed: 'Grabbed',
  landed: 'Have it',
  missing: 'Missing',
};

// PLAN-045 owner-correction — the DOMINANT status badge for an items-wall card (the Movies badge slot).
// One compact badge per card, toned exactly like the Movies/Books walls: Have it (green) · Wanted
// (amber) · Missing (red) · Parked (muted). Comics carry the "Comic · <status>" label (ADR-056). The
// per-format detail (Ebook/Audio) rides the badge tooltip, never a stack of pills.
const PHASE_BADGE: Record<RequestPhaseName, { label: string; tone: 'ok' | 'warn' | 'danger' | 'muted' }> = {
  have: { label: 'Have it', tone: 'ok' },
  searching: { label: 'Wanted', tone: 'warn' },
  missing: { label: 'Missing', tone: 'danger' },
  parked: { label: 'Parked', tone: 'muted' },
};

function statusBadge(item: ItemWire): PosterBadge {
  const base = PHASE_BADGE[item.phase];
  const label = item.isComic ? `Comic · ${base.label}` : base.label;
  // The tooltip carries the detail the old stacked pills + routing note used to show (never on-card).
  const title =
    item.phase === 'parked' || item.unroutableReason === 'comic'
      ? 'Waiting on a ComicVine match.'
      : item.isComic
        ? item.comicStatus
          ? `Comic: ${STATUS_LABEL[item.comicStatus]}`
          : undefined
        : item.inLibrary || item.phase === 'have'
          ? 'In your library'
          : `Ebook: ${STATUS_LABEL[item.ebookStatus]} · Audio: ${STATUS_LABEL[item.audioStatus]}`;
  return { label, tone: base.tone, title };
}

// fix/live-status-precedence — LIVE-STATE-WINS on the Goodreads items wall (the same class the owner hit on the
// Wanted detail): overlay the live in-flight stage over the reconciled snapshot so a card being actively acquired
// never reads "Missing". The join is the Library-Wanted wall idiom exactly — one `activity.wallStages` read,
// keyed by the Kapowarr volume id (comic) or the LL/GB book id (book, whose ebook + audiobook legs ride the
// `books`/`audiobooks` walls). Most-severe stage wins across the two book legs.
type WallStagesData = RouterOutputs['activity']['wallStages'];
const STAGE_SEVERITY: Record<CardActivityStage, number> = {
  failed: 4,
  importing: 3,
  downloading: 2,
  searching: 1,
  completed: 0,
};
function moreSevere(a: InFlightBadge | null, b: InFlightBadge | null): InFlightBadge | null {
  if (!a) return b;
  if (!b) return a;
  return STAGE_SEVERITY[b.stage] > STAGE_SEVERITY[a.stage] ? b : a;
}
function inFlightForItem(item: ItemWire, wallStages: WallStagesData | undefined): InFlightBadge | null {
  if (!wallStages) return null;
  const toBadge = (s: { stage: CardActivityStage; progress: number | null } | undefined): InFlightBadge | null =>
    s ? { stage: s.stage, progress: s.progress } : null;
  if (item.isComic) {
    return item.kapowarrVolumeId != null ? toBadge(wallStages.comics?.[item.kapowarrVolumeId]) : null;
  }
  if (item.llBookId == null) return null;
  return moreSevere(toBadge(wallStages.books?.[item.llBookId]), toBadge(wallStages.audiobooks?.[item.llBookId]));
}

// ---------------------------------------------------------------------------
// The link card — the PR #258 UX, moved verbatim from the v0.49.0 flat page.
// ---------------------------------------------------------------------------

function LinkCard() {
  const utils = trpc.useUtils();
  const statusQ = trpc.integrations.status.useQuery(undefined, {
    refetchInterval: (query) => {
      const d = query.state.data;
      return d && isFirstSyncPending(d.integration.linked, d.integration.lastSyncedAt)
        ? PENDING_POLL_MS
        : false;
    },
  });
  const [profileRef, setProfileRef] = useState('');
  const link = trpc.integrations.link.useMutation({
    onSuccess: () => {
      setProfileRef('');
      void utils.integrations.invalidate();
    },
  });
  const unlink = trpc.integrations.unlink.useMutation({
    onSuccess: () => void utils.integrations.invalidate(),
  });

  const integration = statusQ.data?.integration;
  const linked = integration?.linked ?? false;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (profileRef.trim().length === 0) return;
    link.mutate({ profileRef: profileRef.trim() });
  };

  return (
    <section className="card integrations-card" data-testid="integrations-link-card">
      <header className="integrations-card__head">
        <span className="integrations-provider">
          <span className="integrations-provider__glyph" aria-hidden="true">
            G
          </span>
          <span className="integrations-provider__name">Goodreads</span>
        </span>
        {linked ? (
          <span className="badge badge--ok" data-testid="integrations-linked">
            Linked
          </span>
        ) : (
          <span className="badge badge--muted">Not linked</span>
        )}
      </header>

      {linked && integration ? (
        <div className="integrations-linked-state">
          <p className="integrations-linked-state__ref">
            {integration.profileRef ?? `Goodreads user ${integration.externalUserId}`}
          </p>
          <p className="muted integrations-linked-state__sub">
            Syncing shelves: {integration.shelves.map(shelfLabel).join(' · ')}
            {integration.lastSyncError ? (
              <span className="integrations-error"> — last sync: {integration.lastSyncError}</span>
            ) : null}
          </p>
          {/* Unlink is destructive-ish → the two-step confirm (hard rule 8 / ADR-014); reserved
              armed-label width so the swap never reflows (ADR-015). */}
          <ConfirmButton
            className="btn sm danger"
            data-testid="integrations-unlink-btn"
            disabled={unlink.isPending}
            label={unlink.isPending ? 'Unlinking…' : 'Unlink'}
            confirmLabel="Confirm unlink?"
            restingAriaLabel="Unlink your Goodreads account — click twice to confirm"
            confirmAriaLabel="Confirm unlink your Goodreads account"
            onConfirm={() => unlink.mutate()}
          />
        </div>
      ) : (
        <form className="integrations-link-form" onSubmit={onSubmit}>
          <label className="field">
            <span className="field__label">Your public Goodreads profile</span>
            <input
              type="text"
              inputMode="url"
              className="integrations-input"
              placeholder="https://www.goodreads.com/yourname"
              value={profileRef}
              onChange={(e) => setProfileRef(e.target.value)}
              aria-invalid={link.isError || undefined}
              data-testid="integrations-profile-input"
            />
            <span className="field-hint">
              Paste your profile URL or numeric id. Your shelves must be PUBLIC (Settings → Privacy).
            </span>
          </label>
          {link.isError ? (
            <p className="field-error" role="alert" data-testid="integrations-link-error">
              {link.error.message}
            </p>
          ) : null}
          <div className="form-actions">
            <button
              type="submit"
              className="btn primary"
              data-testid="integrations-link-btn"
              disabled={link.isPending || profileRef.trim().length === 0}
            >
              {link.isPending ? 'Linking…' : 'Link Goodreads'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// OVERVIEW — the stats page (headline want-shelf coverage, per-shelf breakdown, phase tiles).
// ---------------------------------------------------------------------------

function OverviewTab({
  overview,
  pending,
  onOpenItems,
}: {
  overview: OverviewWire | undefined;
  pending: boolean;
  onOpenItems: (shelf?: string) => void;
}) {
  const headline = overview?.headline ?? { total: 0, covered: 0, pct: 0 };
  const lastSyncedAt = overview?.integration.lastSyncedAt ?? null;
  const view = coverageView({ lastSyncedAt, coverage: headline });
  const phases = overview?.phases ?? { have: 0, searching: 0, missing: 0, parked: 0 };
  const phaseOrder: RequestPhaseName[] = ['have', 'searching', 'missing', 'parked'];

  return (
    <>
      {/* The headline stat — WANT-SHELF coverage (Q-02). Pending and data states share one reserved
          footprint (ADR-015 — the first-sync → coverage swap never reflows the cards below). */}
      <section className="card integrations-summary" data-testid="integrations-summary">
        {view.kind === 'pending' ? (
          <>
            <div
              className="integrations-stat integrations-stat--pending"
              data-testid="integrations-coverage"
              data-pending="true"
            >
              <span className="integrations-stat__spinner" aria-hidden="true" />
              <span className="integrations-stat__label">First sync in progress</span>
            </div>
            <div className="integrations-summary__detail">
              <p className="integrations-summary__count">Pulling your shelves…</p>
              <p className="muted">
                We’re reading your shelves and matching them against the library. Coverage appears
                here as soon as the first sync finishes.
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="integrations-stat" data-testid="integrations-coverage">
              <span className="integrations-stat__value">{view.pct}%</span>
              <span className="integrations-stat__label">of your want-to-read shelf</span>
            </div>
            <div className="integrations-summary__detail">
              <p className="integrations-summary__count">
                We have <strong>{view.covered}</strong> of <strong>{view.total}</strong> books on your
                want-to-read shelf.
              </p>
              <p className="muted">
                {lastSyncedAt ? `Last synced ${new Date(lastSyncedAt).toLocaleString()}` : ''}
              </p>
            </div>
          </>
        )}
      </section>

      {/* Per-shelf breakdown — one card per POPULATED shelf (A3 gate), the Trash-Overview whole-card
          button idiom: a click opens the items wall pre-filtered to the shelf (a PUSH, D-19). */}
      {(overview?.shelves.length ?? 0) > 0 ? (
        <div className="gr-ovcards" data-testid="gr-shelf-cards">
          {overview!.shelves
            .filter((s) => s.total > 0)
            .map((s) => (
              <button
                key={s.shelf}
                type="button"
                className="gr-ovcard"
                data-testid={`gr-shelf-card-${s.shelf}`}
                onClick={() => onOpenItems(s.shelf)}
              >
                <span className="gr-ovcard__head">{shelfLabel(s.shelf)}</span>
                <span className="gr-ovcard__count">
                  <span className="gr-ovcard__num">{s.total}</span>
                  <span className="gr-ovcard__unit">{s.total === 1 ? 'book' : 'books'}</span>
                </span>
                <span className="gr-ovcard__detail">
                  {s.covered} in the library · {s.pct}%
                </span>
              </button>
            ))}
        </div>
      ) : null}

      {/* Requests & Missing summary tiles (the v0.49.0 wall's rollup — the wall itself lives on the
          items tab now). Empty phases render muted, populated ones tone up; parked hides at 0. */}
      {!pending ? (
        <div className="gr-phases" data-testid="gr-phase-tiles">
          {phaseOrder
            .filter((p) => p !== 'parked' || phases[p] > 0)
            .map((p) => (
              <button
                key={p}
                type="button"
                className={`gr-phase${phases[p] > 0 ? '' : ' gr-phase--empty'}`}
                data-phase={p}
                data-testid={`gr-phase-${p}`}
                onClick={() => onOpenItems()}
              >
                <span className="gr-phase__num">{phases[p]}</span>
                <span className="gr-phase__label">{PHASE_META[p].label}</span>
              </button>
            ))}
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// ITEMS — the shelf library wall (shelf chips + shared filter/sort chrome + poster grid).
// ---------------------------------------------------------------------------

function ItemTile({
  item,
  focused,
  inFlight,
}: {
  item: ItemWire;
  focused: boolean;
  /** fix/live-status-precedence — the live in-flight badge (from `activity.wallStages`) when this want is
   *  currently being acquired; it OVERRIDES the reconciled snapshot status badge (live-state-wins). */
  inFlight: InFlightBadge | null;
}) {
  // One callback ref stores the card element for the one-time `?focus=` deep-link scroll (legacy
  // links still land + highlight).
  const ref = useRef<HTMLElement | null>(null);
  const setRef = (el: HTMLElement | null) => {
    ref.current = el;
  };
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'center' });
  }, [focused]);

  // The two-badge caption row (max two — the primary shelf + the dominant status). The remaining
  // shelves ride the shelf badge's tooltip; per-format detail rides the status badge's (never pills).
  const shelvesSorted = shelfSort(item.shelves);
  const primaryShelf = shelvesSorted[0];
  const shelfBadge: PosterBadge | null = primaryShelf
    ? {
        label: shelfLabel(primaryShelf),
        tone: 'muted',
        title: shelvesSorted.map(shelfLabel).join(' · '),
      }
    : null;

  // PLAN-047 (owner Wanted-parity ruling) — the WHOLE card click-throughs into a detail page (the Movies/TV
  // poster→detail idiom; the corner force-search puck is retired — force-search lives on the detail page).
  // "Have it" → the existing library detail (`/library/books/[id]`); any other want → the Wanted detail
  // parity page. A want with no request row yet (pre-mint) stays non-interactive (RequestCard href null).
  const href = item.matchedBooksItemId
    ? `/library/books/${item.matchedBooksItemId}?from=goodreads-items`
    : item.requestId
      ? `/library/books/wanted/${item.requestId}?from=goodreads-items`
      : null;

  // LIVE-STATE-WINS: a live in-flight/landed signal replaces the reconciled snapshot badge, so the card never
  // reads "Missing" while it is actively downloading (the terminology guard). `data-phase` keeps the snapshot
  // for the filter chips; only the visible badge is overlaid.
  const status = inFlight ? activityStageBadge(inFlight) : statusBadge(item);

  return (
    <RequestCard
      href={href}
      posterUrl={item.posterUrl}
      isComic={item.isComic}
      title={item.title}
      author={item.author}
      shelfBadge={shelfBadge}
      statusBadge={status}
      phase={item.phase}
      requestId={item.requestId}
      focused={focused}
      cardRef={setRef}
    />
  );
}

function ItemsTab({ items, pending }: { items: ItemWire[]; pending: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // fix/live-status-precedence — ONE live wall-stage read (the Library-Wanted wall idiom), enabled only when
  // the wall has items. Each card overlays its live in-flight stage over the reconciled snapshot; polls in
  // place (ADR-015). Books-gated server-side — an integrations-only viewer just sees the snapshot (no overlay).
  const wallStagesQ = trpc.activity.wallStages.useQuery(undefined, {
    enabled: items.length > 0,
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
    placeholderData: (prev) => prev,
  });

  // ── shelf chips (the Helpdesk state-chip semantics — DESIGN-012 D-12 ported) ──
  // Populated-value-gated: only shelves that actually hold items grow a chip (A3 — an absent
  // did-not-finish shelf renders nothing).
  const shelfCounts = new Map<string, number>();
  for (const item of items) {
    for (const s of item.shelves) shelfCounts.set(s, (shelfCounts.get(s) ?? 0) + 1);
  }
  const populated = shelfSort([...shelfCounts.keys()]);
  const selected = shelfSelectionFromParams(searchParams.getAll('shelf'), populated);
  const allActive = populated.length > 0 && populated.every((s) => selected.has(s));

  // Refinements REPLACE (D-19) — shelf chips, the status chip, search text and sort never mint
  // history entries; only the tab switch (the sub-section screens) pushes.
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

  const writeSelection = (next: Set<string>) => {
    patchParams({ shelf: shelfParamsForSelection(next, populated) });
  };

  // ── the status (phase) select — a lean shared-engine narrower ──
  const phaseRaw = searchParams.get('state');
  const phase = (['have', 'searching', 'missing', 'parked'] as const).find((p) => p === phaseRaw);

  // ── search + sort ──
  const qParam = searchParams.get('q') ?? '';
  const [query, setQuery] = useState(qParam);
  useEffect(() => {
    const t = setTimeout(() => {
      const current = new URLSearchParams(window.location.search).get('q') ?? '';
      if (query !== current) patchParams({ q: query });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const sortKeys = SHELF_WALL_SORTS.map((s) => s.key);
  const sortRaw = searchParams.get('sort');
  const parsed = sortRaw?.split(':') ?? [];
  const sort: { field: ShelfWallSort; dir: 'asc' | 'desc' } =
    parsed.length === 2 && (sortKeys as string[]).includes(parsed[0]!) && (parsed[1] === 'asc' || parsed[1] === 'desc')
      ? { field: parsed[0] as ShelfWallSort, dir: parsed[1] }
      : { field: 'shelved', dir: 'desc' };
  const sortToken = `${sort.field}:${sort.dir}`;
  const clickCycle = Object.fromEntries(
    SHELF_WALL_SORTS.map((c) => [
      c.key,
      c.firstDir === 'asc'
        ? { asc: `${c.key}:asc`, desc: `${c.key}:desc` }
        : { asc: `${c.key}:desc`, desc: `${c.key}:asc` },
    ]),
  ) as Record<string, { asc: string; desc: string }>;
  const arrowCycle = Object.fromEntries(
    SHELF_WALL_SORTS.map((c) => [c.key, { asc: `${c.key}:asc`, desc: `${c.key}:desc` }]),
  ) as Record<string, { asc: string; desc: string }>;

  const focus = searchParams.get('focus');

  const visible = sortShelfWallItems(
    filterShelfWallItems(items, { query: qParam, shelves: selected, ...(phase ? { phase } : {}) }),
    sort.field,
    sort.dir,
  );

  return (
    <>
      <div className="library-toolbar">
        <div className="library-controls">
          <input
            type="search"
            className="library-search"
            placeholder="Search your shelves…"
            aria-label="Search your shelved books"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {/* The SHELF CHIPS — the Helpdesk semantics verbatim: additive multi-select union, a
            superset "All" that lights when every chip is on, counts always visible, aria-pressed,
            recolor-only toggles (ADR-015). */}
        {populated.length > 0 ? (
          <div className="seg gr-shelfbar" role="group" aria-label="Filter by shelf">
            <button
              type="button"
              className={allActive ? 'is-active' : undefined}
              aria-pressed={allActive}
              data-testid="shelf-chip-all"
              onClick={() => writeSelection(new Set(populated))}
            >
              All · {items.length}
            </button>
            {populated.map((s) => {
              const on = selected.has(s);
              return (
                <button
                  key={s}
                  type="button"
                  className={on ? 'is-active' : undefined}
                  aria-pressed={on}
                  data-testid={`shelf-chip-${s}`}
                  onClick={() => writeSelection(toggleShelf(selected, s))}
                >
                  {shelfLabel(s)} · {shelfCounts.get(s) ?? 0}
                </button>
              );
            })}
          </div>
        ) : null}

        {/* Status narrower + sort bar (the shared chrome). */}
        <div className="library-chipbar" role="group" aria-label="Filters">
          <div className="seg" role="group" aria-label="Filter by status">
            {(['have', 'searching', 'missing', 'parked'] as const).map((p) => {
              const count = items.filter((i) => i.phase === p).length;
              if (count === 0) return null;
              const on = phase === p;
              return (
                <button
                  key={p}
                  type="button"
                  className={on ? 'is-active' : undefined}
                  aria-pressed={on}
                  data-testid={`gr-state-${p}`}
                  onClick={() => patchParams({ state: on ? null : p })}
                >
                  {PHASE_META[p].label} · {count}
                </button>
              );
            })}
          </div>
        </div>

        <div className="library-sortbar" role="group" aria-label="Sort">
          <span className="library-sortbar__label">Sort</span>
          {SHELF_WALL_SORTS.map((c) => {
            const isActive = sort.field === c.key;
            return (
              <button
                key={c.key}
                type="button"
                className={`sort-btn${isActive ? ' is-active' : ''}`}
                aria-pressed={isActive}
                onClick={() => patchParams({ sort: nextSort<string, string>(sortToken, c.key, clickCycle) })}
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

      {pending ? (
        <PosterGridSkeleton count={8} testId="gr-items-skeleton" />
      ) : items.length === 0 ? (
        <section className="card empty-state" data-testid="gr-items-empty">
          <p>No shelved books yet.</p>
          <p className="muted">
            Add books to your Goodreads shelves; the next sync brings them in — and requests the ones
            we don’t have.
          </p>
        </section>
      ) : visible.length === 0 ? (
        <section className="card empty-state" data-testid="gr-items-none">
          <p className="muted">
            {selected.size === 0
              ? 'No shelves selected — pick a shelf chip above.'
              : 'Nothing matches your filters.'}
          </p>
        </section>
      ) : (
        // The SAME poster grid as the Movies/Books walls (the owner-corrected cohesive blocks).
        <PosterGrid testId="gr-items-grid">
          {visible.map((item) => (
            <ItemTile
              key={item.key}
              item={item}
              focused={focus !== null && item.requestId === focus}
              inFlight={inFlightForItem(item, wallStagesQ.data)}
            />
          ))}
        </PosterGrid>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The sub-section shell — header, link card, tabs (PUSH — D-19).
// ---------------------------------------------------------------------------

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'items', label: 'Items' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

function resolveTab(raw: string | null): TabKey {
  return TABS.some((t) => t.key === raw) ? (raw as TabKey) : 'overview';
}

export function GoodreadsClient() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = resolveTab(searchParams.get('tab'));
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Normalize a bare /integrations/goodreads (or an unknown ?tab) to Overview — the hub contract
  // (replace-only: canonicalizing must not mint a history entry). A deep link that carries a valid
  // ?tab (e.g. ?tab=items&focus=…) is left untouched, so wanted-card deep links keep their focus.
  useEffect(() => {
    if (searchParams.get('tab') !== active) {
      const params = new URLSearchParams();
      params.set('tab', active);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    }
  }, [searchParams, active, pathname, router]);

  const statusQ = trpc.integrations.status.useQuery(undefined, {
    refetchInterval: (query) => {
      const d = query.state.data;
      return d && isFirstSyncPending(d.integration.linked, d.integration.lastSyncedAt)
        ? PENDING_POLL_MS
        : false;
    },
  });
  const integration = statusQ.data?.integration;
  const linked = integration?.linked ?? false;
  const pending = isFirstSyncPending(linked, integration?.lastSyncedAt ?? null);

  const overviewQ = trpc.integrations.overview.useQuery(undefined, {
    enabled: linked,
    refetchInterval: pending ? PENDING_POLL_MS : false,
  });
  const itemsQ = trpc.integrations.items.useQuery(undefined, {
    enabled: linked,
    refetchInterval: pending ? PENDING_POLL_MS : false,
    placeholderData: (prev) => prev,
  });

  /** A sub-section tab switch is a SCREEN-level view change → PUSH, keeping only ?tab (+ an
   *  optional pre-filter the overview cards hand across) — DESIGN-004 D-19: refinements never leak
   *  across tabs. */
  const selectTab = (key: TabKey, extra?: Record<string, string>) => {
    const params = new URLSearchParams();
    params.set('tab', key);
    for (const [k, v] of Object.entries(extra ?? {})) params.set(k, v);
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextIndex = (index + 1) % TABS.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') nextIndex = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') nextIndex = 0;
    else if (e.key === 'End') nextIndex = TABS.length - 1;
    if (nextIndex === null) return;
    e.preventDefault();
    selectTab(TABS[nextIndex]!.key);
    tabRefs.current[nextIndex]?.focus();
  };

  return (
    <div className="integrations-page">
      <div className="gr-head">
        <Link className="btn sm" href="/integrations" data-testid="gr-back">
          ‹ Integrations
        </Link>
        <h1 className="page-title gr-head__title">
          <KindIcon kind="book" className="gr-head__icon" /> Goodreads
        </h1>
      </div>

      <LinkCard />

      {linked ? (
        <>
          <div className="library-tabs" role="tablist" aria-label="Goodreads views">
            {TABS.map((t, index) => (
              <button
                key={t.key}
                ref={(el) => {
                  tabRefs.current[index] = el;
                }}
                type="button"
                role="tab"
                id={`grtab-${t.key}`}
                aria-selected={active === t.key}
                aria-controls="gr-panel"
                tabIndex={active === t.key ? 0 : -1}
                data-testid={`gr-tab-${t.key}`}
                onClick={() => selectTab(t.key)}
                onKeyDown={(e) => onTabKeyDown(e, index)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div id="gr-panel" role="tabpanel" aria-labelledby={`grtab-${active}`}>
            {active === 'overview' ? (
              <OverviewTab
                overview={overviewQ.data}
                pending={pending}
                onOpenItems={(shelf) => selectTab('items', shelf ? { shelf } : undefined)}
              />
            ) : (
              <ItemsTab items={itemsQ.data?.items ?? []} pending={itemsQ.isPending} />
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
