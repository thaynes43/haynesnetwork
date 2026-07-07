'use client';

// ADR-025 / DESIGN-011 D-07 — the Trash CURATION area: batches, the poster wall, Leaving Soon.
// This is the owner's centerpiece surface: a phone-first wall of proposed-deletion posters where
// every tile carries an X (slated to delete) that a tap flips to a lock (rescued). Layout rules:
//
// - THE WALL IS THE PAGE. The lifecycle strip, countdown, and running counts are compact,
//   fixed-height rows above it; admin ceremony (history, save stats, settings) sits below.
// - ADR-015: a tap swaps the overlay glyph and deepens color IN PLACE — the tile never moves,
//   resizes, or reflows neighbors (the overlay occupies a fixed reserved corner; captions are
//   fixed-height single lines). The counts header changes numbers only (tabular figures).
// - Saves are OPTIMISTIC: the overlay flips immediately, then reconciles with the server
//   response. On `changed:false` (an inert tap — the item was really protected/skipped/deleted)
//   the tile renders the RETURNED state, so the wall self-corrects to the truth (D-05).
// - Phase-aware permissions mirror the server gate (D-05 setItemSaved): admin_review ⇒
//   manage_batches; leaving_soon ⇒ save_leaving_soon while the window is open. During the family
//   window a saver may undo their OWN locks; a manager may release any (lib/trash-batches.ts).
// - Batch-level ceremony per ADR-014: Green-light and Expire-now are explanatory Modals
//   (multi-consequence); Cancel is an inline two-step ConfirmButton; per-tile saves are
//   protective + reversible, so no confirm at all.
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { ConfirmButton } from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import { Modal } from '@/components/modal';
import { MediaPoster } from '@/components/media-poster';
import type { TrashAccess } from '@/components/trash-shield';
import { formatBytes, formatDay, formatRating, ratingOrNull } from '@/lib/media';
import { appCodeOf, describeMutationError } from '@/lib/app-error';
import { daysLeftLabel, daysLeftTone, daysUntil } from '@/lib/trash';
import {
  BATCH_STATE_LABELS,
  LEAVING_SOON_NAMES,
  batchStateTone,
  countdownCopy,
  sweepReportRows,
  tileTappable,
  wallCounts,
  wallGlyph,
  wallInteractive,
  type BatchItemStateName,
  type BatchStateName,
  type WallGlyph,
  type WallTapContext,
} from '@/lib/trash-batches';

// ── wire-shape aliases (structural mirrors of the D-05 contracts; the client never imports
//    server packages — same pattern as trash-client.tsx) ─────────────────────────────────
interface BatchCountsWire {
  pending: number;
  saved: number;
  deleted: number;
  skipped: number;
  protected: number;
  total: number;
}

interface BatchSummaryWire {
  id: string;
  mediaKind: 'movie' | 'tv';
  state: BatchStateName;
  windowDays: number;
  gateSkipped: boolean;
  greenlitAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  deletedAt: string | null;
  cancelledAt: string | null;
  counts: BatchCountsWire;
  reclaimedBytes: number;
}

interface BatchItemWire {
  id: string;
  maintainerrMediaId: string;
  mediaItemId: string | null;
  collectionId: number | null;
  title: string;
  year: number | null;
  sizeBytes: number;
  state: BatchItemStateName;
  savedBy: string | null;
  savedAt: string | null;
  posterUrl: string | null;
  imdbRating: number | null;
  tmdbRating: number | null;
  recentlyWatched: boolean;
}

interface SafetyLike {
  safe: boolean;
  reachable: boolean;
}

const OPEN_STATES: readonly BatchStateName[] = ['draft', 'admin_review', 'leaving_soon'];

const windowStillOpen = (expiresAt: string | null): boolean =>
  expiresAt !== null && Date.parse(expiresAt) > Date.now();

// ── the overlay glyphs (in-theme per DESIGN-006 — stroke-drawn, no borrowed icon set) ────
function GlyphSvg({ glyph }: { glyph: WallGlyph }) {
  const path = (() => {
    switch (glyph) {
      case 'x':
        return <path d="M7 7l10 10M17 7L7 17" />;
      case 'lock':
        return (
          <>
            <rect x="5.5" y="11" width="13" height="8.5" rx="2" />
            <path d="M8.5 11V8.5a3.5 3.5 0 0 1 7 0V11" />
          </>
        );
      case 'eye':
        return (
          <>
            <path d="M3 12s3.2-5.5 9-5.5S21 12 21 12s-3.2 5.5-9 5.5S3 12 3 12Z" />
            <circle cx="12" cy="12" r="2.4" />
          </>
        );
      case 'shield':
        return (
          <>
            <path d="M12 3.5l6.5 2.8v4.6c0 4.1-2.7 7.5-6.5 9.1-3.8-1.6-6.5-5-6.5-9.1V6.3L12 3.5Z" />
            <path d="m9.2 12 2 2 3.6-3.8" />
          </>
        );
      case 'skip':
        return (
          <>
            <circle cx="12" cy="12" r="8.5" />
            <path d="M6.2 6.2l11.6 11.6" />
          </>
        );
      case 'gone':
        return (
          <>
            <path d="M5 7.5h14" />
            <path d="M9.5 7.5V6a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5" />
            <path d="M7 7.5l1 11h8l1-11" />
          </>
        );
    }
  })();
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}

function tileLabel(
  title: string,
  glyph: WallGlyph,
  tappable: boolean,
  savedByName: string | null,
): string {
  switch (glyph) {
    case 'x':
      return tappable ? `${title} is slated to delete — tap to save it` : `${title} is slated to delete`;
    case 'lock':
      if (tappable) return `${title} is saved — tap to un-save it`;
      return savedByName !== null ? `${title} — saved by ${savedByName}` : `${title} is saved`;
    case 'eye':
      return `${title} was watched recently — the guardian keeps it`;
    case 'shield':
      return `${title} is protected — already safe from deletion`;
    case 'skip':
      return `${title} was kept — it couldn’t be verified safe, so it was never deleted`;
    case 'gone':
      return `${title} was deleted`;
  }
}

// ── THE POSTER WALL ───────────────────────────────────────────────────────────────────────
function PosterWall({
  batchId,
  batch,
  items,
  kind,
  ctx,
  saverNames,
}: {
  batchId: string;
  batch: BatchSummaryWire;
  items: BatchItemWire[];
  kind: 'movie' | 'tv';
  ctx: WallTapContext;
  saverNames: ReadonlyMap<string, string>;
}) {
  const utils = trpc.useUtils();
  // Optimistic per-tile state, reconciled with every server response (component is keyed by
  // batchId upstream, so switching batches resets this cleanly).
  const [overrides, setOverrides] = useState<ReadonlyMap<string, BatchItemStateName>>(
    () => new Map(),
  );
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(() => new Set());
  const [wallError, setWallError] = useState<string | null>(null);
  const setSaved = trpc.trash.batches.setItemSaved.useMutation();

  const effectiveState = (item: BatchItemWire): BatchItemStateName =>
    overrides.get(item.id) ?? item.state;

  const tap = (item: BatchItemWire) => {
    if (inFlight.has(item.id)) return; // one flip at a time per tile — no queued double-toggles
    const desired = effectiveState(item) !== 'saved';
    setOverrides((prev) => new Map(prev).set(item.id, desired ? 'saved' : 'pending'));
    setInFlight((prev) => new Set(prev).add(item.id));
    setWallError(null);
    setSaved.mutate(
      { batchId, itemId: item.id, saved: desired },
      {
        onSuccess: (res) => {
          // Authoritative reconcile. On an INERT tap (changed:false) `state` is the item's REAL
          // current state — protected/skipped/deleted render their own glyph (D-05).
          setOverrides((prev) => new Map(prev).set(item.id, res.state));
          void utils.trash.batches.get.invalidate({ batchId });
          void utils.trash.batches.list.invalidate();
          void utils.trash.batches.saveStats.invalidate({ batchId });
        },
        onError: (err: unknown) => {
          setOverrides((prev) => {
            const next = new Map(prev);
            next.delete(item.id); // revert the optimistic flip
            return next;
          });
          setWallError(describeMutationError(err));
        },
        onSettled: () => {
          setInFlight((prev) => {
            const next = new Set(prev);
            next.delete(item.id);
            return next;
          });
        },
      },
    );
  };

  const effective = items.map((item) => ({ item, state: effectiveState(item) }));
  const counts = wallCounts(
    effective.map(({ item, state }) => ({
      state,
      recentlyWatched: item.recentlyWatched,
      sizeBytes: item.sizeBytes,
    })),
  );

  // The running header — numbers change in place (tabular figures), the row never grows.
  const headline =
    batch.state === 'deleted'
      ? `Deleted ${counts.deleted} · Rescued ${counts.rescued} · Kept ${counts.kept} · freed ${formatBytes(batch.reclaimedBytes)}`
      : batch.state === 'cancelled'
        ? `Cancelled — nothing was deleted · ${items.length} item${items.length === 1 ? '' : 's'} released`
        : `Deleting ${counts.slated} · Rescued ${counts.rescued} · Kept ${counts.kept} · frees ${formatBytes(counts.slatedBytes)}`;

  return (
    <>
      <div className="bwall-counts" data-testid="wall-counts">
        {headline}
      </div>
      {/* Fixed-height error slot — an error appearing recolors the line, never shifts the wall. */}
      <p className="bwall-error" role="alert" data-testid="wall-error">
        {wallError ?? ''}
      </p>
      <ul className="bwall" data-testid="batch-wall">
        {effective.map(({ item, state }) => {
          const glyph = wallGlyph(state, item.recentlyWatched);
          const tappable = tileTappable(ctx, glyph, item.savedBy);
          const savedByName =
            item.savedBy !== null ? (saverNames.get(item.savedBy) ?? null) : null;
          const label = tileLabel(item.title, glyph, tappable, savedByName);
          const rating = formatRating(ratingOrNull(item.imdbRating) ?? ratingOrNull(item.tmdbRating));
          const inner = (
            <>
              <MediaPoster
                posterUrl={item.posterUrl}
                kind={kind === 'movie' ? 'radarr' : 'sonarr'}
                alt=""
              />
              {/* keyed by glyph: a flip re-mounts the badge so the pop animation replays
                  (transform-only — never layout; killed by prefers-reduced-motion). */}
              <span key={glyph} className="bwall-overlay" data-glyph={glyph} aria-hidden="true">
                <GlyphSvg glyph={glyph} />
              </span>
            </>
          );
          return (
            <li key={item.id} className="bwall-tile" data-glyph={glyph} data-testid="wall-tile">
              {tappable ? (
                <button
                  type="button"
                  className="bwall-tap"
                  aria-pressed={glyph === 'lock'}
                  aria-label={label}
                  title={label}
                  aria-busy={inFlight.has(item.id) || undefined}
                  onClick={() => tap(item)}
                >
                  {inner}
                </button>
              ) : (
                <span className="bwall-tap" role="img" aria-label={label} title={label}>
                  {inner}
                </span>
              )}
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
    </>
  );
}

// ── Green-light Modal (ADR-014 — explanatory, multi-consequence) ─────────────────────────
function GreenlightModal({
  batch,
  defaultWindowDays,
  onClose,
}: {
  batch: BatchSummaryWire;
  defaultWindowDays: number;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [days, setDays] = useState(String(defaultWindowDays));
  const [error, setError] = useState<string | null>(null);
  const greenlight = trpc.trash.batches.greenlight.useMutation({
    onSuccess: () => {
      setError(null);
      void utils.trash.batches.invalidate();
      onClose();
    },
    onError: (err: unknown) => setError(describeMutationError(err)),
  });
  const parsed = Number(days);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 365;
  const pendingCount = batch.counts.pending;
  const collectionName = LEAVING_SOON_NAMES[batch.mediaKind];

  return (
    <Modal
      open
      title="Green-light this batch"
      onClose={() => {
        if (!greenlight.isPending) onClose();
      }}
      banner={
        error !== null ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null
      }
    >
      <div className="trash-confirm" data-testid="batch-greenlight-confirm">
        <p>
          Promote this batch to <strong>Leaving Soon</strong> — its {pendingCount} slated item
          {pendingCount === 1 ? '' : 's'} go public for a last-chance rescue:
        </p>
        <ul className="ledger-confirm__outcomes">
          <li>
            <strong>A Plex collection appears:</strong> “{collectionName}” shows on Plex Home and
            Recommended, so the family sees what’s on the chopping block.
          </li>
          <li>
            <strong>The save window opens.</strong> Anyone with the rescue grant can tap ✕ → lock
            here until it closes; a lock is permanent protection.
          </li>
          <li>
            <strong>When the window closes, the sweep deletes what’s left</strong> — one item at a
            time, each re-checked fresh; watched, requested, protected, or unverifiable items are
            kept, never deleted blind.
          </li>
        </ul>
        <label className="form-row batch-window-row">
          Save window
          <input
            type="number"
            className="batch-window-input"
            min={1}
            max={365}
            value={days}
            data-testid="batch-window-days"
            aria-label="Save window in days"
            onChange={(e) => setDays(e.target.value)}
          />
          days
        </label>
        <div className="form-actions">
          <button
            type="button"
            className="btn primary"
            data-testid="batch-greenlight-submit"
            disabled={greenlight.isPending || !valid}
            onClick={() => greenlight.mutate({ batchId: batch.id, windowDays: parsed })}
          >
            {greenlight.isPending
              ? 'Green-lighting…'
              : `Green-light ${pendingCount} item${pendingCount === 1 ? '' : 's'}`}
          </button>
          <button type="button" className="btn" disabled={greenlight.isPending} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Expire-now Modal (ADR-014 — DANGER: this is the deletion) ────────────────────────────
interface SweepBatchWire {
  batchId: string;
  mediaKind: 'movie' | 'tv';
  deletedCount: number;
  skippedCount: number;
  savedCount: number;
  protectedCount: number;
  handleErrors: number;
  raceSkipped: number;
  aborted: boolean;
}

function ExpireModal({
  batch,
  items,
  safe,
  onClose,
}: {
  batch: BatchSummaryWire;
  items: BatchItemWire[];
  safe: boolean;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [result, setResult] = useState<SweepBatchWire | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expire = trpc.trash.batches.expire.useMutation({
    onSuccess: (res: { batchesSwept: number; batches: SweepBatchWire[] }) => {
      setError(null);
      setResult(res.batches.find((b) => b.batchId === batch.id) ?? res.batches[0] ?? null);
      void utils.trash.batches.invalidate();
    },
    onError: (err: unknown) => {
      // Always refetch — a partial/failed run can leave the batch counts stale (same F3
      // discipline as the Expedite modal).
      void utils.trash.batches.invalidate();
      if (appCodeOf(err) === 'MAINTAINERR_UNSAFE') setStale(true);
      else setError(describeMutationError(err));
    },
  });

  const close = () => {
    if (!expire.isPending) onClose();
  };

  // Honest preview over the batch's remaining `pending` items (the sweep's only candidates).
  // Every one is re-verified FRESH server-side, so "up to" is the honest phrasing: requester
  // protection and live whitelists are server-known signals this client cannot see.
  const pending = items.filter((i) => i.state === 'pending');
  const willDelete = pending.filter((i) => !i.recentlyWatched && i.mediaItemId !== null).length;
  const willKeep = pending.length - willDelete;
  const savedCount = batch.counts.saved;

  return (
    <Modal
      open
      title={result !== null ? 'Deletion report' : 'Expire this batch now'}
      onClose={close}
      banner={
        error !== null ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null
      }
    >
      {stale ? (
        <div className="trash-confirm" data-testid="batch-expire-stale">
          <p>
            <strong>Nothing was deleted.</strong> Maintainerr just failed its safety check, so the
            sweep refused to run. Check the banner and try again once every integration is back.
          </p>
          <div className="form-actions">
            <button type="button" className="btn" onClick={close}>
              Close
            </button>
          </div>
        </div>
      ) : result !== null ? (
        <div className="trash-confirm" data-testid="batch-expire-report">
          {result.aborted ? (
            <p className="alert" data-testid="batch-expire-aborted">
              <strong>Batch not finished</strong> — Maintainerr failed mid-run, so the sweep
              stopped early with the partial results below. The batch stays in Leaving Soon and
              will resume on the next sweep.
            </p>
          ) : null}
          <p className="ledger-report__summary" data-testid="batch-expire-summary">
            {sweepReportRows(result).map((row) => (
              <span key={row.key} className={`badge badge--${row.tone}`}>
                {row.count} {row.label}
              </span>
            ))}
          </p>
          <ul className="ledger-confirm__outcomes">
            <li>
              <strong>Deleted</strong> — verified cold and handed to Maintainerr’s per-item delete
              handler; the files are being removed now.
            </li>
            <li>
              <strong>Rescued</strong> — locked during the window; untouched.
            </li>
            <li>
              <strong>Protected</strong> — already whitelisted before the batch; untouched.
            </li>
            <li>
              <strong>Skipped</strong> — kept because it couldn’t be verified safe (or the
              guardian stepped in at sweep time). Not the same as rescued — these were never
              deliberately saved, and were never deleted.
            </li>
          </ul>
          <div className="form-actions">
            <button type="button" className="btn" onClick={close}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="trash-confirm" data-testid="batch-expire-confirm">
          <p className="alert" role="alert">
            This runs the deletion sweep <strong>NOW</strong> — immediate and permanent for every
            unsaved item that passes the fresh safety checks. There is no undo beyond a
            re-download via Restore.
          </p>
          <ul className="ledger-confirm__outcomes">
            <li>
              <strong className="trash-danger-text">
                Up to {willDelete} item{willDelete === 1 ? '' : 's'} will be deleted
              </strong>{' '}
              — each is re-checked fresh first (live whitelist + the watch/requester guardian);
              only verified-cold items delete.
            </li>
            <li>
              <strong>
                {savedCount} rescued item{savedCount === 1 ? '' : 's'} are untouched
              </strong>{' '}
              — a lock is permanent protection.
            </li>
            <li>
              <strong>
                At least {willKeep} will be kept (skipped)
              </strong>{' '}
              — recently watched, unverifiable, or guardian-protected at sweep time.
            </li>
          </ul>
          <div className="form-actions">
            <button
              type="button"
              className="btn danger"
              data-testid="batch-expire-submit"
              disabled={expire.isPending || !safe}
              title={
                safe
                  ? 'Run the deletion sweep for this batch now'
                  : 'Disabled — Maintainerr is not in a safe state (see the banner).'
              }
              onClick={() => expire.mutate({ batchId: batch.id })}
            >
              {expire.isPending ? 'Deleting…' : 'Delete the remaining items now'}
            </button>
            <button type="button" className="btn" disabled={expire.isPending} onClick={close}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── the per-batch panel: lifecycle strip → countdown → wall → savers ─────────────────────
function BatchPanel({
  batch,
  items,
  itemsLoading,
  kind,
  access,
  viewerId,
  status,
  defaultWindowDays,
  saveStats,
}: {
  batch: BatchSummaryWire;
  items: BatchItemWire[] | undefined;
  itemsLoading: boolean;
  kind: 'movie' | 'tv';
  access: TrashAccess;
  viewerId: string;
  status: SafetyLike | undefined;
  defaultWindowDays: number;
  saveStats:
    | {
        totalSaves: number;
        totalUnsaves: number;
        byUser: Array<{
          userId: string | null;
          displayName: string | null;
          saves: number;
          unsaves: number;
        }>;
      }
    | undefined;
}) {
  const utils = trpc.useUtils();
  const [modal, setModal] = useState<'greenlight' | 'expire' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reachable = status?.reachable === true;
  const safe = status?.safe === true;
  const canManage = access.actions.includes('manage_batches');
  const canSaveWindow = access.actions.includes('save_leaving_soon');
  const windowOpen = batch.state === 'leaving_soon' && windowStillOpen(batch.expiresAt);
  const ctx: WallTapContext = {
    batchState: batch.state,
    windowOpen,
    reachable,
    canManage,
    canSaveWindow,
    viewerId,
  };

  const cancel = trpc.trash.batches.cancel.useMutation();
  const cancelBatch = async (): Promise<'ok' | 'failed'> => {
    try {
      await cancel.mutateAsync({ batchId: batch.id });
      setActionError(null);
      void utils.trash.batches.invalidate();
      return 'ok';
    } catch (err) {
      setActionError(describeMutationError(err));
      return 'failed';
    }
  };

  const days = daysUntil(batch.expiresAt);
  const saverNames = new Map<string, string>();
  for (const u of saveStats?.byUser ?? []) {
    if (u.userId !== null && u.displayName !== null) saverNames.set(u.userId, u.displayName);
  }

  const windowMeta =
    batch.state === 'leaving_soon' && batch.expiresAt !== null ? (
      <>
        window closes {formatDay(batch.expiresAt)}{' '}
        <span className={`trash-days trash-days--${daysLeftTone(days)}`}>
          {daysLeftLabel(days)}
        </span>
      </>
    ) : batch.state === 'deleted' && batch.deletedAt !== null ? (
      <>swept {formatDay(batch.deletedAt)}</>
    ) : batch.state === 'cancelled' && batch.cancelledAt !== null ? (
      <>cancelled {formatDay(batch.cancelledAt)}</>
    ) : (
      <>created {formatDay(batch.createdAt)}</>
    );

  const expireBlocked = !safe
    ? 'Disabled — Maintainerr is not in a safe state (see the banner).'
    : windowOpen && batch.expiresAt !== null
      ? `The save window hasn’t closed yet — the sweep can only run after ${formatDay(batch.expiresAt)}.`
      : null;

  return (
    <section data-testid="batch-panel">
      {/* Lifecycle strip — one fixed row: state · meta · admin actions (ADR-015: constant
          height; the pill recolors per state, controls swap by state between renders only). */}
      <div className="batch-strip" data-testid="batch-lifecycle">
        <span
          className="batch-state"
          data-tone={batchStateTone(batch.state)}
          data-testid="batch-state"
        >
          {BATCH_STATE_LABELS[batch.state]}
        </span>
        {batch.gateSkipped ? (
          <span className="badge badge--warn" data-testid="batch-gate-skipped" title="The audited skip-gate promoted this batch straight to Leaving Soon — no poster review.">
            Gate skipped
          </span>
        ) : null}
        <span className="batch-strip__meta muted">
          {batch.counts.total} item{batch.counts.total === 1 ? '' : 's'} · {windowMeta}
        </span>
        <span className="batch-strip__spacer" />
        {canManage && batch.state === 'admin_review' ? (
          <button
            type="button"
            className="btn sm primary"
            data-testid="batch-greenlight"
            disabled={!reachable}
            title={
              reachable
                ? 'Promote this batch to Leaving Soon'
                : 'Disabled — Maintainerr is unreachable (see the banner).'
            }
            onClick={() => setModal('greenlight')}
          >
            Green-light…
          </button>
        ) : null}
        {canManage && batch.state === 'leaving_soon' ? (
          <button
            type="button"
            className="btn sm danger"
            data-testid="batch-expire"
            disabled={expireBlocked !== null}
            title={expireBlocked ?? 'Run the deletion sweep for this batch now'}
            onClick={() => setModal('expire')}
          >
            Expire now…
          </button>
        ) : null}
        {canManage && OPEN_STATES.includes(batch.state) ? (
          <ConfirmButton
            className="btn sm danger"
            data-testid="batch-cancel"
            label="Cancel batch"
            reArmOnFailure
            disabled={!reachable}
            restingAriaLabel="Cancel this batch — releases its Leaving Soon collection; nothing is deleted — click twice to confirm"
            confirmAriaLabel="Confirm cancelling this batch"
            onConfirm={cancelBatch}
          />
        ) : null}
      </div>
      {actionError !== null ? (
        <p className="alert" role="alert" data-testid="batch-action-error">
          {actionError}
        </p>
      ) : null}

      {batch.state === 'leaving_soon' ? (
        <div
          className="batch-countdown"
          data-tone={windowOpen ? daysLeftTone(days) : 'muted'}
          data-testid="batch-countdown"
          role="status"
        >
          {countdownCopy(daysLeftLabel(days), windowOpen, wallInteractive(ctx))}
        </div>
      ) : null}
      {batch.state === 'draft' ? (
        <p className="status-note status-note--warn">
          This batch is stuck in Draft — the skip-gate promotion didn’t finish (Maintainerr was
          likely unreachable). Cancel it and create a fresh one.
        </p>
      ) : null}

      {items === undefined || itemsLoading ? (
        <ul className="bwall" aria-hidden="true" data-testid="wall-skeleton">
          {Array.from({ length: 6 }, (_, i) => (
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
      ) : (
        <PosterWall
          key={batch.id}
          batchId={batch.id}
          batch={batch}
          items={items}
          kind={kind}
          ctx={ctx}
          saverNames={saverNames}
        />
      )}

      {saveStats !== undefined && saveStats.totalSaves + saveStats.totalUnsaves > 0 ? (
        <div className="batch-savers" data-testid="batch-savers">
          <h3 className="batch-savers__title">Who rescued what</h3>
          <ul>
            {saveStats.byUser.map((u) => (
              <li key={u.userId ?? 'system'}>
                <strong>{u.displayName ?? 'Unknown'}</strong> · {u.saves} saved
                {u.unsaves > 0 ? ` · ${u.unsaves} un-saved` : ''}
              </li>
            ))}
          </ul>
          <p className="muted batch-savers__note">
            Every save and un-save is recorded — this is the dataset that tunes the rules.
          </p>
        </div>
      ) : null}

      {modal === 'greenlight' ? (
        <GreenlightModal
          batch={batch}
          defaultWindowDays={defaultWindowDays}
          onClose={() => setModal(null)}
        />
      ) : null}
      {modal === 'expire' ? (
        <ExpireModal batch={batch} items={items ?? []} safe={safe} onClose={() => setModal(null)} />
      ) : null}
    </section>
  );
}

// ── Trash settings (admin — ADR-025 C-06/C-07) ───────────────────────────────────────────
function TrashSettingsCard() {
  const utils = trpc.useUtils();
  const settings = trpc.trash.settings.get.useQuery();
  const [windowDraft, setWindowDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = trpc.trash.settings.set.useMutation({
    onSuccess: () => {
      setError(null);
      setWindowDraft(null);
      void utils.trash.settings.get.invalidate();
    },
    onError: (err: unknown) => setError(describeMutationError(err)),
  });

  const skipGate = settings.data?.trash_skip_admin_gate === true;
  const serverDays = settings.data?.trash_default_window_days ?? 21;
  const daysValue = windowDraft ?? String(serverDays);
  const parsedDays = Number(daysValue);
  const daysValid = Number.isInteger(parsedDays) && parsedDays >= 1 && parsedDays <= 365;

  const flipGate = async (next: boolean): Promise<'ok' | 'failed'> => {
    try {
      await save.mutateAsync({ trashSkipAdminGate: next });
      return 'ok';
    } catch {
      return 'failed'; // save.onError already set the message
    }
  };

  return (
    <section className="card batch-settings" data-testid="trash-settings">
      <h2 className="batch-settings__head">Trash settings</h2>
      {error !== null ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      <div className="batch-settings__row">
        <div className="batch-settings__copy">
          <strong>Admin gate</strong>
          <p className="muted">
            With the gate on, every batch waits in Admin review for the poster pass. Skipping it
            sends new batches <strong>straight to Leaving Soon</strong> — no human review before
            the save window opens. The flip is audited either way.
          </p>
          <p data-testid="skipgate-state">
            {settings.isLoading
              ? 'Loading…'
              : skipGate
                ? 'Skip-gate is ON — new batches go straight to Leaving Soon.'
                : 'Gate is ON — every batch waits for admin review.'}
          </p>
        </div>
        {skipGate ? (
          <button
            type="button"
            className="btn sm"
            data-testid="skipgate-disable"
            disabled={save.isPending || settings.isLoading}
            onClick={() => void save.mutateAsync({ trashSkipAdminGate: false }).catch(() => undefined)}
          >
            Restore the admin gate
          </button>
        ) : (
          <ConfirmButton
            className="btn sm danger"
            data-testid="skipgate-enable"
            label="Skip the admin gate"
            reArmOnFailure
            disabled={save.isPending || settings.isLoading}
            restingAriaLabel="Skip the admin gate — new batches go straight to Leaving Soon without review — click twice to confirm"
            confirmAriaLabel="Confirm skipping the admin gate"
            onConfirm={() => flipGate(true)}
          />
        )}
      </div>
      <div className="batch-settings__row">
        <div className="batch-settings__copy">
          <strong>Default save window</strong>
          <p className="muted">
            How long a green-lit batch stays in Leaving Soon before the sweep deletes the
            remainder. Green-light can override per batch.
          </p>
        </div>
        <span className="batch-settings__field">
          <input
            type="number"
            className="batch-window-input"
            min={1}
            max={365}
            value={daysValue}
            data-testid="settings-window"
            aria-label="Default save window in days"
            onChange={(e) => setWindowDraft(e.target.value)}
          />
          <span className="muted">days</span>
          <button
            type="button"
            className="btn sm"
            data-testid="settings-window-save"
            disabled={save.isPending || !daysValid || windowDraft === null}
            onClick={() => save.mutate({ trashDefaultWindowDays: parsedDays })}
          >
            Save
          </button>
        </span>
      </div>
    </section>
  );
}

// ── the tab shell: kind switch · create · current batch · history · settings ─────────────
export function BatchesTab({
  access,
  viewerId,
  viewerIsAdmin,
  status,
}: {
  access: TrashAccess;
  viewerId: string;
  viewerIsAdmin: boolean;
  status: SafetyLike | undefined;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const utils = trpc.useUtils();

  const kind: 'movie' | 'tv' = searchParams.get('kind') === 'tv' ? 'tv' : 'movie';
  const canManage = access.actions.includes('manage_batches');
  const reachable = status?.reachable === true;

  const setKind = (next: 'movie' | 'tv') => {
    // Kind switch starts fresh (keeps ONLY tab+kind — the ?batch selection belongs to a kind).
    const params = new URLSearchParams();
    params.set('tab', 'batches');
    if (next === 'tv') params.set('kind', 'tv');
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };
  const selectBatch = (id: string) => {
    const params = new URLSearchParams(window.location.search);
    params.set('batch', id);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const list = trpc.trash.batches.list.useQuery(undefined, {
    placeholderData: (prev) => prev,
  });
  const batches: BatchSummaryWire[] = (list.data ?? []).filter((b) => b.mediaKind === kind);
  const openBatch = batches.find((b) => OPEN_STATES.includes(b.state));
  const batchParam = searchParams.get('batch');
  const selectedId =
    batchParam !== null && batches.some((b) => b.id === batchParam)
      ? batchParam
      : (openBatch?.id ?? batches[0]?.id);

  const detail = trpc.trash.batches.get.useQuery(
    { batchId: selectedId ?? '00000000-0000-0000-0000-000000000000' },
    { enabled: selectedId !== undefined, placeholderData: (prev) => prev },
  );
  const stats = trpc.trash.batches.saveStats.useQuery(
    { batchId: selectedId ?? '00000000-0000-0000-0000-000000000000' },
    { enabled: selectedId !== undefined, placeholderData: (prev) => prev },
  );
  // The candidate peek for the empty state — how many pending items a new batch would snapshot.
  const candidates = trpc.trash.pending.useQuery(
    { media: kind },
    { enabled: canManage && openBatch === undefined && reachable },
  );
  // Green-light's window default: the admin-readable setting; non-admin batch managers fall back
  // to the batch's own column default (the settings surface is adminProcedure — D-05).
  const settings = trpc.trash.settings.get.useQuery(undefined, { enabled: viewerIsAdmin });

  const [createError, setCreateError] = useState<string | null>(null);
  const create = trpc.trash.batches.create.useMutation({
    onSuccess: (res: { batchId: string }) => {
      setCreateError(null);
      void utils.trash.batches.invalidate();
      selectBatch(res.batchId);
    },
    // The server error NAMES the blocker (open batch id + state, or "nothing to batch").
    onError: (err: unknown) => setCreateError(describeMutationError(err)),
  });

  // placeholderData keeps the PREVIOUS batch's payload rendered during a switch — only trust the
  // detail/stats payloads once they belong to the currently-selected batch (else the strip would
  // briefly show another batch's state).
  const detailData =
    detail.data !== undefined && (detail.data as BatchSummaryWire).id === selectedId
      ? detail.data
      : undefined;
  const statsData =
    stats.data !== undefined && stats.data.batchId === selectedId ? stats.data : undefined;
  const selectedSummary: BatchSummaryWire | undefined =
    (detailData as BatchSummaryWire | undefined) ?? batches.find((b) => b.id === selectedId);
  const defaultWindowDays =
    settings.data?.trash_default_window_days ?? selectedSummary?.windowDays ?? 21;

  return (
    <div data-testid="batches-tab">
      <div className="batches-head">
        <div className="seg" role="group" aria-label="Batch media kind">
          <button
            type="button"
            className={kind === 'movie' ? 'is-active' : undefined}
            onClick={() => setKind('movie')}
          >
            Movies
          </button>
          <button
            type="button"
            className={kind === 'tv' ? 'is-active' : undefined}
            onClick={() => setKind('tv')}
          >
            TV
          </button>
        </div>
        <span className="batch-strip__spacer" />
        {canManage ? (
          <button
            type="button"
            className="btn sm"
            data-testid="batch-create"
            disabled={create.isPending || !reachable}
            title={
              reachable
                ? `Snapshot the current pending ${kind === 'movie' ? 'movies' : 'TV'} into a new batch`
                : 'Disabled — Maintainerr is unreachable (see the banner).'
            }
            onClick={() => create.mutate({ mediaKind: kind })}
          >
            {create.isPending ? 'Creating…' : 'Create batch'}
          </button>
        ) : null}
      </div>
      {createError !== null ? (
        <p className="alert" role="alert" data-testid="batch-create-error">
          {createError}
        </p>
      ) : null}
      {canManage && openBatch === undefined ? (
        <p className="muted batches-hint" data-testid="batch-candidates">
          {candidates.data !== undefined
            ? `${candidates.data.count} ${kind === 'movie' ? 'movie' : 'TV'} candidate${candidates.data.count === 1 ? '' : 's'} currently proposed by the rules.`
            : reachable
              ? 'Checking the current candidates…'
              : 'Maintainerr is unreachable — candidates can’t be read right now.'}
        </p>
      ) : null}

      {list.isLoading ? (
        <p className="muted">Loading batches…</p>
      ) : list.error ? (
        <p className="alert" role="alert">
          Couldn’t load the batches: {list.error.message}
        </p>
      ) : selectedSummary === undefined ? (
        <section className="card empty-state" data-testid="batches-empty">
          <p>No {kind === 'movie' ? 'movie' : 'TV'} batches yet.</p>
          <p className="muted">
            {canManage
              ? 'Create one to snapshot the current proposed deletions into a poster review.'
              : 'When an admin opens a curation batch, its poster wall shows up here.'}
          </p>
        </section>
      ) : (
        <BatchPanel
          key={selectedSummary.id}
          batch={selectedSummary}
          items={detailData?.items as BatchItemWire[] | undefined}
          itemsLoading={detailData === undefined}
          kind={kind}
          access={access}
          viewerId={viewerId}
          status={status}
          defaultWindowDays={defaultWindowDays}
          saveStats={statsData}
        />
      )}

      {batches.length > 1 ? (
        <div className="batch-history" data-testid="batch-history">
          <h3 className="batch-savers__title">Past batches</h3>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Created</th>
                <th>State</th>
                <th>Items</th>
                <th>Rescued</th>
                <th>Freed</th>
                <th aria-label="Select" />
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr
                  key={b.id}
                  data-testid="batch-history-row"
                  className={b.id === selectedId ? 'is-selected' : undefined}
                >
                  <td data-label="Created">{formatDay(b.createdAt)}</td>
                  <td data-label="State">
                    <span className="batch-state" data-tone={batchStateTone(b.state)}>
                      {BATCH_STATE_LABELS[b.state]}
                    </span>
                    {b.gateSkipped ? (
                      <span className="badge badge--warn" title="Promoted by the audited skip-gate — no admin review.">
                        Gate skipped
                      </span>
                    ) : null}
                  </td>
                  <td data-label="Items">{b.counts.total}</td>
                  <td data-label="Rescued">{b.counts.saved}</td>
                  <td data-label="Freed">
                    {b.reclaimedBytes > 0 ? formatBytes(b.reclaimedBytes) : '—'}
                  </td>
                  <td data-label="">
                    {b.id === selectedId ? (
                      <span className="muted">Viewing</span>
                    ) : (
                      <button
                        type="button"
                        className="btn sm"
                        data-testid="batch-history-view"
                        onClick={() => selectBatch(b.id)}
                      >
                        View
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {viewerIsAdmin ? <TrashSettingsCard /> : null}
    </div>
  );
}
