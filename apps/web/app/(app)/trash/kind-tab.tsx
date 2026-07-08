'use client';

// ADR-033 / DESIGN-011 D-07 (amended 2026-07-07) — the per-kind Trash surface. The old "Batches"
// tab is GONE: one open batch per kind is the enforced invariant, so a batch is a PROPERTY of the
// Movies/TV tab, not a separate browsable collection. This one state-aware component drives the
// whole per-kind lifecycle off that kind's open batch (trash.batches.list scoped to kind — reusing
// EVERY existing wire call, zero backend change):
//
//   • no open batch  → the live-candidates poster wall (passed in as `pendingWall`) + an admin-only
//                       "Start a batch" header; terminal batches collapse into the Past-batches strip.
//   • admin_review    → the batch wall RENDERS THE BATCH (X/shield curation) + a lifecycle header
//                       (state chip · Green-light · Cancel) + an admin-only "new candidates since
//                       this batch" strip.
//   • leaving_soon    → countdown banner + the family save wall + "Who rescued what" + Expire-now
//                       (window-close-gated), same new-candidates strip.
//   • terminal        → falls back to the live wall + the Past-batches strip.
//
// Owner refinement 2026-07-07: the wall is a FAST tap-toggle (poster/glyph flips trash⇄shield);
// /library nav is a distinct corner icon; per-item expedite lives on the item page now.
import { useState, type ReactNode } from 'react';
import { ConfirmButton } from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import { Modal } from '@/components/modal';
import { MediaPoster } from '@/components/media-poster';
import {
  LibraryCornerLink,
  WallGlyphSvg,
  type TrashAccess,
} from '@/components/trash-shield';
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

/** The pending-candidate fields the new-candidates diff reads (a subset of trash.pending items). */
interface PendingCandidate {
  maintainerrMediaId: string | null;
  mediaItemId: string | null;
  title: string;
  year: number | null;
  posterUrl: string | null;
}

interface SafetyLike {
  safe: boolean;
  reachable: boolean;
}

const OPEN_STATES: readonly BatchStateName[] = ['draft', 'admin_review', 'leaving_soon'];
const TERMINAL_STATES: readonly BatchStateName[] = ['deleted', 'cancelled'];

const windowStillOpen = (expiresAt: string | null): boolean =>
  expiresAt !== null && Date.parse(expiresAt) > Date.now();

/** The kind → `?from=` key so a poster-nav returns to THIS tab (Part 2). */
const fromKeyFor = (kind: 'movie' | 'tv'): string => (kind === 'movie' ? 'trash-movies' : 'trash-tv');

function tileLabel(
  title: string,
  glyph: WallGlyph,
  tappable: boolean,
  savedByName: string | null,
): string {
  switch (glyph) {
    case 'trash':
      return tappable
        ? `${title} is slated to delete — tap to save it`
        : `${title} is slated to delete`;
    case 'shield':
      if (tappable) return `${title} is saved — tap to un-save it`;
      return savedByName !== null ? `${title} — saved by ${savedByName}` : `${title} is saved`;
    case 'check':
      return `${title} is protected — already safe from deletion`;
    case 'eye':
      return `${title} was watched recently — the guardian keeps it`;
    case 'skip':
      return `${title} was kept — it couldn’t be verified safe, so it was never deleted`;
    case 'gone':
      return `${title} was deleted`;
  }
}

// ── THE POSTER WALL (batch curation / Leaving-Soon / terminal review) ───────────────────────
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
  const fromKey = fromKeyFor(kind);

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
          const savedByName = item.savedBy !== null ? (saverNames.get(item.savedBy) ?? null) : null;
          const label = tileLabel(item.title, glyph, tappable, savedByName);
          const rating = formatRating(
            ratingOrNull(item.imdbRating) ?? ratingOrNull(item.tmdbRating),
          );
          const titleYear = `${item.title}${item.year !== null ? ` (${item.year})` : ''}`;
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
                <WallGlyphSvg glyph={glyph} />
              </span>
            </>
          );
          return (
            <li key={item.id} className="bwall-tile" data-glyph={glyph} data-testid="wall-tile">
              {tappable ? (
                <button
                  type="button"
                  className="bwall-tap"
                  aria-pressed={glyph === 'shield'}
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
              {/* The /library nav corner — distinct from the toggle (owner refinement). */}
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
            <strong>The save window opens.</strong> Anyone with the rescue grant can tap a slated
            poster to save it here until it closes; a save is permanent protection.
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
      // DON'T invalidate yet — a successful sweep makes the batch TERMINAL, which would drop this
      // LifecycleView (and its Modal) before the report is read (ADR-033). Defer to close().
      setResult(res.batches.find((b) => b.batchId === batch.id) ?? res.batches[0] ?? null);
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
    if (expire.isPending) return;
    // Now reconcile: a completed sweep flips the batch terminal ⇒ the tab returns to the pending
    // wall + the Past-batches strip (where the final report re-opens).
    if (result !== null) void utils.trash.batches.invalidate();
    onClose();
  };

  // Honest preview over the batch's remaining `pending` items (the sweep's only candidates).
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
              <strong>Batch not finished</strong> — Maintainerr failed mid-run, so the sweep stopped
              early with the partial results below. The batch stays in Leaving Soon and will resume
              on the next sweep.
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
              <strong>Rescued</strong> — saved during the window; untouched.
            </li>
            <li>
              <strong>Protected</strong> — already whitelisted before the batch; untouched.
            </li>
            <li>
              <strong>Skipped</strong> — kept because it couldn’t be verified safe (or the guardian
              stepped in at sweep time). Not the same as rescued — these were never deliberately
              saved, and were never deleted.
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
            unsaved item that passes the fresh safety checks. There is no undo beyond a re-download
            via Restore.
          </p>
          <ul className="ledger-confirm__outcomes">
            <li>
              <strong className="trash-danger-text">
                Up to {willDelete} item{willDelete === 1 ? '' : 's'} will be deleted
              </strong>{' '}
              — each is re-checked fresh first (live whitelist + the watch/requester guardian); only
              verified-cold items delete.
            </li>
            <li>
              <strong>
                {savedCount} rescued item{savedCount === 1 ? '' : 's'} are untouched
              </strong>{' '}
              — a save is permanent protection.
            </li>
            <li>
              <strong>At least {willKeep} will be kept (skipped)</strong> — recently watched,
              unverifiable, or guardian-protected at sweep time.
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

// ── the "new candidates since this batch" strip (admin-only; DESIGN-011 D-07 amendment) ──
function NewCandidatesStrip({
  candidates,
  kind,
}: {
  candidates: PendingCandidate[];
  kind: 'movie' | 'tv';
}) {
  if (candidates.length === 0) return null;
  return (
    <div className="batch-newcands" data-testid="batch-new-candidates">
      <p className="batch-newcands__head muted">
        New candidates since this batch ({candidates.length}) — eligible for the next batch.
      </p>
      <ul className="batch-newcands__grid" aria-label="New candidates since this batch">
        {candidates.map((c) => {
          const titleYear = `${c.title}${c.year !== null ? ` (${c.year})` : ''}`;
          return (
            <li key={c.maintainerrMediaId ?? c.title} className="batch-newcands__tile" title={titleYear}>
              <MediaPoster
                posterUrl={c.posterUrl}
                kind={kind === 'movie' ? 'radarr' : 'sonarr'}
                alt=""
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── the lifecycle view: header → countdown → wall → savers → new-candidates ──────────────
function LifecycleView({
  batch,
  items,
  itemsLoading,
  kind,
  access,
  viewerId,
  status,
  defaultWindowDays,
  saveStats,
  newCandidates,
  canManage,
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
  newCandidates: PendingCandidate[];
  canManage: boolean;
}) {
  const utils = trpc.useUtils();
  const [modal, setModal] = useState<'greenlight' | 'expire' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reachable = status?.reachable === true;
  const safe = status?.safe === true;
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
          <span
            className="badge badge--warn"
            data-testid="batch-gate-skipped"
            title="The audited skip-gate promoted this batch straight to Leaving Soon — no poster review."
          >
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

      {/* Admin-only: live pending items NOT in this batch — eligible for the next one. */}
      {canManage ? <NewCandidatesStrip candidates={newCandidates} kind={kind} /> : null}

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

// ── the Past-batches strip (terminal batches — collapsible, each expands to its final report) ──
function PastBatchRow({ batch, kind }: { batch: BatchSummaryWire; kind: 'movie' | 'tv' }) {
  const [open, setOpen] = useState(false);
  const detail = trpc.trash.batches.get.useQuery(
    { batchId: batch.id },
    { enabled: open, placeholderData: (prev) => prev },
  );
  const stats = trpc.trash.batches.saveStats.useQuery(
    { batchId: batch.id },
    { enabled: open, placeholderData: (prev) => prev },
  );
  const detailData =
    detail.data !== undefined && (detail.data as BatchSummaryWire).id === batch.id
      ? (detail.data as unknown as { items: BatchItemWire[] })
      : undefined;
  const saverNames = new Map<string, string>();
  for (const u of stats.data?.byUser ?? []) {
    if (u.userId !== null && u.displayName !== null) saverNames.set(u.userId, u.displayName);
  }
  // Terminal batches are always read-only (wallInteractive returns false for them).
  const ctx: WallTapContext = {
    batchState: batch.state,
    windowOpen: false,
    reachable: false,
    canManage: false,
    canSaveWindow: false,
    viewerId: '',
  };

  return (
    <details
      className="batch-past__row"
      data-testid="batch-history-row"
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="batch-past__summary">
        <span className="batch-state" data-tone={batchStateTone(batch.state)}>
          {BATCH_STATE_LABELS[batch.state]}
        </span>
        <span className="batch-past__meta muted">
          {formatDay(batch.deletedAt ?? batch.cancelledAt ?? batch.createdAt)} ·{' '}
          {batch.counts.total} item{batch.counts.total === 1 ? '' : 's'} · {batch.counts.saved}{' '}
          rescued · {batch.reclaimedBytes > 0 ? `${formatBytes(batch.reclaimedBytes)} reclaimed` : 'nothing deleted'}
        </span>
      </summary>
      {detailData === undefined ? (
        <p className="muted batch-past__loading">Loading the final report…</p>
      ) : (
        <PosterWall
          key={batch.id}
          batchId={batch.id}
          batch={batch}
          items={detailData.items}
          kind={kind}
          ctx={ctx}
          saverNames={saverNames}
        />
      )}
    </details>
  );
}

function PastBatches({ batches, kind }: { batches: BatchSummaryWire[]; kind: 'movie' | 'tv' }) {
  if (batches.length === 0) return null;
  return (
    <div className="batch-past" data-testid="batch-history">
      <h3 className="batch-savers__title">Past batches</h3>
      {batches.map((b) => (
        <PastBatchRow key={b.id} batch={b} kind={kind} />
      ))}
    </div>
  );
}

// ── the per-kind orchestrator ────────────────────────────────────────────────────────────
export function KindTab({
  kind,
  label,
  access,
  viewerId,
  viewerIsAdmin,
  status,
  pendingWall,
}: {
  kind: 'movie' | 'tv';
  label: string;
  access: TrashAccess;
  viewerId: string;
  viewerIsAdmin: boolean;
  status: SafetyLike | undefined;
  /** The live-candidates poster wall — rendered only when there is no open batch. */
  pendingWall: ReactNode;
}) {
  const utils = trpc.useUtils();

  const canManage = access.actions.includes('manage_batches');
  const reachable = status?.reachable === true;

  const list = trpc.trash.batches.list.useQuery(undefined, {
    placeholderData: (prev) => prev,
  });
  const batches: BatchSummaryWire[] = (list.data ?? []).filter((b) => b.mediaKind === kind);
  const openBatch = batches.find((b) => OPEN_STATES.includes(b.state));
  const pastBatches = batches.filter((b) => TERMINAL_STATES.includes(b.state));

  // The open batch's items (curation / Leaving-Soon wall) — only when one is open.
  const detail = trpc.trash.batches.get.useQuery(
    { batchId: openBatch?.id ?? '00000000-0000-0000-0000-000000000000' },
    { enabled: openBatch !== undefined, placeholderData: (prev) => prev },
  );
  const stats = trpc.trash.batches.saveStats.useQuery(
    { batchId: openBatch?.id ?? '00000000-0000-0000-0000-000000000000' },
    { enabled: openBatch !== undefined, placeholderData: (prev) => prev },
  );
  // The pending set powers BOTH the candidate count (no open batch) and the new-candidates diff
  // (open batch). Shared react-query key with the pendingWall's own read — deduped.
  const pending = trpc.trash.pending.useQuery(
    { media: kind },
    { enabled: canManage && reachable },
  );
  const settings = trpc.trash.settings.get.useQuery(undefined, { enabled: viewerIsAdmin });

  const detailData =
    detail.data !== undefined && (detail.data as BatchSummaryWire).id === openBatch?.id
      ? detail.data
      : undefined;
  const statsData =
    stats.data !== undefined && stats.data.batchId === openBatch?.id ? stats.data : undefined;
  const openSummary: BatchSummaryWire | undefined =
    (detailData as BatchSummaryWire | undefined) ?? openBatch;
  const defaultWindowDays =
    settings.data?.trash_default_window_days ?? openSummary?.windowDays ?? 21;

  // The new-candidates diff (pending items whose Maintainerr id isn't in the open batch).
  const batchMediaIds = new Set(
    ((detailData?.items as BatchItemWire[] | undefined) ?? []).map((i) => i.maintainerrMediaId),
  );
  const newCandidates: PendingCandidate[] = ((pending.data?.items as PendingCandidate[] | undefined) ?? [])
    .filter((p) => p.maintainerrMediaId !== null && !batchMediaIds.has(p.maintainerrMediaId));

  // ── create (Start a batch) — admin-only, only when none is open ──
  const [createError, setCreateError] = useState<string | null>(null);
  const create = trpc.trash.batches.create.useMutation({
    onSuccess: () => {
      setCreateError(null);
      void utils.trash.batches.invalidate();
    },
    onError: (err: unknown) => setCreateError(describeMutationError(err)),
  });

  const kindNoun = kind === 'movie' ? 'movie' : 'TV';

  if (list.isLoading) {
    return (
      <div data-testid="kind-tab">
        <p className="muted">Loading {label}…</p>
      </div>
    );
  }
  if (list.error) {
    return (
      <div data-testid="kind-tab">
        <p className="alert" role="alert">
          Couldn’t load {label}: {list.error.message}
        </p>
      </div>
    );
  }

  return (
    <div data-testid="kind-tab" data-kind={kind}>
      {openSummary !== undefined ? (
        <LifecycleView
          key={openSummary.id}
          batch={openSummary}
          items={detailData?.items as BatchItemWire[] | undefined}
          itemsLoading={detailData === undefined}
          kind={kind}
          access={access}
          viewerId={viewerId}
          status={status}
          defaultWindowDays={defaultWindowDays}
          saveStats={statsData}
          newCandidates={newCandidates}
          canManage={canManage}
        />
      ) : (
        <>
          {/* No open batch — the live candidates wall + an admin-only "Start a batch". */}
          {canManage ? (
            <div className="batches-head" data-testid="batch-start-head">
              <p className="batches-hint muted" data-testid="batch-candidates">
                {pending.data !== undefined
                  ? `${pending.data.count} ${kindNoun} candidate${pending.data.count === 1 ? '' : 's'} currently proposed by the rules.`
                  : reachable
                    ? 'Checking the current candidates…'
                    : 'Maintainerr is unreachable — candidates can’t be read right now.'}
              </p>
              <span className="batch-strip__spacer" />
              <button
                type="button"
                className="btn sm primary"
                data-testid="batch-start"
                disabled={create.isPending || !reachable}
                title={
                  reachable
                    ? `Snapshot the current pending ${label} into a review batch`
                    : 'Disabled — Maintainerr is unreachable (see the banner).'
                }
                onClick={() => create.mutate({ mediaKind: kind })}
              >
                {create.isPending ? 'Starting…' : 'Start a batch'}
              </button>
            </div>
          ) : null}
          {createError !== null ? (
            <p className="alert" role="alert" data-testid="batch-create-error">
              {createError}
            </p>
          ) : null}
          {pendingWall}
        </>
      )}

      <PastBatches batches={pastBatches} kind={kind} />
    </div>
  );
}
