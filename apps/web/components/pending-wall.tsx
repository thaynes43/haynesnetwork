'use client';

// Owner-directed 2026-07-09 (paginated trash walls) — the SHARED interactive pending poster wall.
// Extracted from trash-client.tsx so the live Movies/TV wall AND the "Potential in future batches"
// strip render as ONE system: same tile grammar, same fast tap-toggle (poster flips trash ⇄ shield),
// same glyph language, same /library corner nav, same keyset-style infinite scroll (a sentinel pulls
// the next page; skeleton boxes hold the exact grid geometry so nothing reflows — ADR-015).
//
// This component is PRESENTATIONAL + a small save/un-save hook: each host owns its own
// trpc.trash.pending infinite query (different inputs — the live wall reads the whole kind; the
// future strip passes excludeOpenBatch) and feeds the flattened page items in. A save = the guarded
// Maintainerr exclusion (trash.saveExclusion) → the item is whitelisted → it never enters a future
// batch; requested items are informational only now (owner ruling 2026-07-09 — a person meta badge,
// not a corner glyph; the corner is the pure save/slate toggle — lib/trash pendingWallGlyph).
import { useEffect, useState, type RefObject } from 'react';
import { trpc } from '@/lib/trpc-client';
import { MediaPoster } from '@/components/media-poster';
import {
  LibraryCornerLink,
  RequestedByBadge,
  WallGlyphSvg,
  WatchNoteBadge,
} from '@/components/trash-shield';
import { formatBytes, formatDay, formatRating, ratingOrNull } from '@/lib/media';
import { describeMutationError } from '@/lib/app-error';
import {
  daysLeftLabel,
  daysUntil,
  pendingWallGlyph,
  pendingWallTappable,
  watchNote,
  type PendingWallGlyph,
} from '@/lib/trash';

/** The pending-item surface a tile renders (a structural mirror of the trash.pending wire item). */
export interface PendingWallItem {
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
  /** DESIGN-010 D-12 — cross-server watch visibility (info, not protection). */
  lastWatchedAt: string | null;
  lastWatchedServer: string | null;
  requesters: string[];
  posterUrl: string | null;
  imdbRating: number | null;
  tmdbRating: number | null;
}

const itemRating = (item: PendingWallItem): number | null =>
  ratingOrNull(item.imdbRating) ?? ratingOrNull(item.tmdbRating);

/** The tile tooltip — the detail the retired table columns carried; the full history is one tap
 *  away on /library/[id]. */
function tileInfo(item: PendingWallItem, glyph: PendingWallGlyph): string {
  const lines: string[] = [
    item.scheduledDeleteAt !== null
      ? `Deletes ${formatDay(item.scheduledDeleteAt)} (${daysLeftLabel(daysUntil(item.scheduledDeleteAt))})`
      : 'No scheduled delete date',
  ];
  if (glyph === 'shield') lines.push('Saved by you — protected from deletion');
  else if (glyph === 'check')
    lines.push(
      item.protectedByTag ? 'Protected — carries the dnd tag' : 'Protected — excluded in Maintainerr',
    );
  // DESIGN-010 D-12 (build C) — the cross-server watch line (info, not protection). BOTH watch
  // states surface here now (the action corner never carries watch info): "Watched recently on
  // <server> — the guardian keeps it at the sweep" or "Last watched on <server> · <Mon YYYY> —
  // still deletable". It never gates the corner action.
  const note = watchNote(item);
  if (note !== null)
    lines.push(note.recent ? `${note.label} — the guardian keeps it at the sweep` : `${note.label} — still deletable`);
  // The requester attribution is INFO ONLY now (owner ruling 2026-07-09) — it never changes the
  // corner action; it rides the tooltip + the meta-line person badge.
  if (item.requesters.length > 0) lines.push(`Requested by ${item.requesters.join(', ')}`);
  if (item.collectionTitle !== null) lines.push(`Rule: ${item.collectionTitle}`);
  lines.push(
    item.mediaItemId !== null
      ? 'Tap the poster for history and fixes'
      : 'Not in our ledger — it can never be expedited (fail closed), only saved',
  );
  return lines.join('\n');
}

/**
 * The session-local save/un-save toggle shared by both walls. A 'saved' override is ALSO the wall's
 * "saved by YOU" signal (pending items carry no ownership), so only the save you just made renders as
 * the tappable filled shield; server-side protection (tag / a foreign exclusion) stays the inert
 * check. On success it invalidates trash.pending so the (paginated) query refetches its loaded pages.
 */
export function usePendingSaves(media: 'movie' | 'tv') {
  const utils = trpc.useUtils();
  const [overrides, setOverrides] = useState<ReadonlyMap<string, 'saved' | 'unsaved'>>(
    () => new Map(),
  );
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const save = trpc.trash.saveExclusion.useMutation();
  const unsave = trpc.trash.removeExclusion.useMutation();

  const toggle = (item: PendingWallItem, glyph: PendingWallGlyph) => {
    const id = item.maintainerrMediaId;
    if (id === null || busy.has(id)) return;
    // A slated `trash` tile saves (tap ⇒ add the exclusion); only the filled `shield` un-saves.
    const saving = glyph === 'trash';
    const prev = overrides.get(id);
    setOverrides((m) => new Map(m).set(id, saving ? 'saved' : 'unsaved'));
    setBusy((s) => new Set(s).add(id));
    setError(null);
    const mutation = saving ? save : unsave;
    mutation.mutate(
      // `media` drives the server's per-kind debounced pool-refresh marker (DESIGN-014 build D).
      { media, maintainerrMediaId: id, mediaItemId: item.mediaItemId },
      {
        onSuccess: () => void utils.trash.pending.invalidate({ media }),
        onError: (err: unknown) => {
          setOverrides((m) => {
            const next = new Map(m);
            if (prev === undefined) next.delete(id);
            else next.set(id, prev);
            return next;
          });
          setError(describeMutationError(err));
        },
        onSettled: () =>
          setBusy((s) => {
            const next = new Set(s);
            next.delete(id);
            return next;
          }),
      },
    );
  };

  return { overrides, busy, error, toggle };
}

function PendingTile({
  item,
  media,
  fromKey,
  overrides,
  busy,
  canSave,
  canUnsave,
  onToggle,
}: {
  item: PendingWallItem;
  media: 'movie' | 'tv';
  fromKey: string;
  overrides: ReadonlyMap<string, 'saved' | 'unsaved'>;
  busy: ReadonlySet<string>;
  canSave: boolean;
  canUnsave: boolean;
  onToggle: (item: PendingWallItem, glyph: PendingWallGlyph) => void;
}) {
  const rating = formatRating(itemRating(item));
  const override =
    item.maintainerrMediaId === null ? undefined : overrides.get(item.maintainerrMediaId);
  const glyph = pendingWallGlyph(item, override);
  const tappable =
    item.maintainerrMediaId !== null && pendingWallTappable(glyph, canSave, canUnsave);
  const info = tileInfo(item, glyph);
  // DESIGN-010 D-12 (build C) — the meta-line watch chip: info-tone eye (recently watched) or muted
  // eye (watched a while ago). Null when there is no watch signal. NEVER in the action corner.
  const note = watchNote(item);
  const titleYear = `${item.title}${item.year !== null ? ` (${item.year})` : ''}`;
  const toggleLabel =
    glyph === 'shield'
      ? tappable
        ? `Un-save ${item.title} — remove its deletion protection`
        : `${item.title} is saved — protected from deletion`
      : glyph === 'check'
        ? `${item.title} is protected from deletion`
        : tappable
          ? `${item.title} is slated to delete — tap to save it`
          : `${item.title} is slated to delete`;
  const inner = (
    <>
      <MediaPoster posterUrl={item.posterUrl} kind={media === 'movie' ? 'radarr' : 'sonarr'} alt="" />
      <span key={glyph} className="bwall-overlay" data-glyph={glyph} aria-hidden="true">
        <WallGlyphSvg glyph={glyph} />
      </span>
    </>
  );
  return (
    <li className="bwall-tile pwall-tile" data-glyph={glyph} data-testid="trash-tile">
      {tappable ? (
        <button
          type="button"
          className="bwall-tap"
          data-testid="trash-toggle"
          aria-pressed={glyph === 'shield'}
          aria-label={toggleLabel}
          title={info}
          aria-busy={
            (item.maintainerrMediaId !== null && busy.has(item.maintainerrMediaId)) || undefined
          }
          onClick={() => onToggle(item, glyph)}
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
        <span className="bwall-meta-text">
          {item.sizeBytes > 0 ? formatBytes(item.sizeBytes) : '—'}
          {rating !== null ? ` · ★ ${rating}` : ''}
        </span>
        <RequestedByBadge requesters={item.requesters} />
        {note !== null ? <WatchNoteBadge label={note.label} tone={note.tone} /> : null}
      </span>
    </li>
  );
}

/**
 * Keyset infinite scroll: a sentinel below the wall pulls the next page as it nears the viewport
 * (the /library pattern). The Load-more button stays as the visible/manual fallback. `canLoadMore`
 * folds in hasNextPage + not-already-fetching + not-placeholder so a filter refetch never chain-loads.
 */
export function useInfiniteScroll(
  sentinelRef: RefObject<HTMLDivElement | null>,
  canLoadMore: boolean,
  fetchNextPage: () => void,
): void {
  useEffect(() => {
    const el = sentinelRef.current;
    if (el === null || !canLoadMore) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) fetchNextPage();
      },
      { rootMargin: '600px 0px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canLoadMore]);
}

/** N skeleton tiles that hold the exact poster-grid geometry (ADR-015 — no collapsing spinner). */
export function PendingWallSkeleton({ count = 8, testId }: { count?: number; testId?: string }) {
  return (
    <ul className="bwall" aria-hidden="true" data-testid={testId}>
      {Array.from({ length: count }, (_, i) => (
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
  );
}

/**
 * The interactive infinite-scroll poster wall. Presentational: the host owns the paginated query and
 * passes the flattened page items + the paging flags; a sentinel ref pulls the next page. Loading
 * shows skeletons that hold the grid geometry; a filter/scroll refetch keeps the grid rendered
 * (dimmed) so it never jumps.
 */
export function PendingWall({
  items,
  media,
  fromKey,
  overrides,
  busy,
  canSave,
  canUnsave,
  onToggle,
  loading,
  refreshing,
  emptyLabel,
  wallLabel,
  sentinelRef,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  testId = 'trash-wall',
}: {
  items: PendingWallItem[];
  media: 'movie' | 'tv';
  fromKey: string;
  overrides: ReadonlyMap<string, 'saved' | 'unsaved'>;
  busy: ReadonlySet<string>;
  canSave: boolean;
  canUnsave: boolean;
  onToggle: (item: PendingWallItem, glyph: PendingWallGlyph) => void;
  loading: boolean;
  refreshing: boolean;
  emptyLabel: string;
  wallLabel: string;
  sentinelRef: RefObject<HTMLDivElement | null>;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  testId?: string;
}) {
  return (
    <>
      {loading ? (
        <PendingWallSkeleton testId={`${testId}-skeleton`} />
      ) : items.length === 0 ? (
        <p className="muted trash-wall-empty" data-testid={`${testId}-empty`}>
          {emptyLabel}
        </p>
      ) : (
        <ul
          className={`bwall pwall${refreshing ? ' is-refreshing' : ''}`}
          aria-busy={refreshing}
          aria-label={wallLabel}
          data-testid={testId}
        >
          {items.map((item) => (
            <PendingTile
              key={`${item.collectionId}:${item.maintainerrMediaId ?? item.title}`}
              item={item}
              media={media}
              fromKey={fromKey}
              overrides={overrides}
              busy={busy}
              canSave={canSave}
              canUnsave={canUnsave}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
      {hasNextPage ? (
        <div className="load-more" ref={sentinelRef}>
          <button
            type="button"
            className="btn"
            data-testid={`${testId}-load-more`}
            disabled={isFetchingNextPage}
            onClick={onLoadMore}
          >
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : null}
    </>
  );
}
