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
import { useRef, useState, type ReactNode } from 'react';
import { ConfirmButton } from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import { Modal } from '@/components/modal';
import { MediaPoster } from '@/components/media-poster';
import {
  LibraryCornerLink,
  WallGlyphSvg,
  WatchedAgoNote,
  type TrashAccess,
} from '@/components/trash-shield';
import {
  PendingWall,
  useInfiniteScroll,
  usePendingSaves,
  type PendingWallItem,
} from '@/components/pending-wall';
import { formatBytes, formatDay, formatRating, ratingOrNull } from '@/lib/media';
import { appCodeOf, describeMutationError } from '@/lib/app-error';
import {
  candidatesAsOfLabel,
  daysUntil,
  deadlineCountdown,
  lastWatchedLabel,
  watchedLongAgo,
} from '@/lib/trash';
import {
  BATCH_STATE_LABELS,
  BYTES_PER_GB,
  LEAVING_SOON_NAMES,
  TARGET_STRATEGIES,
  TARGET_STRATEGY_LABELS,
  batchStateTone,
  countdownCopy,
  forceExpireConfirmMatches,
  previewTargetSelection,
  sweepReportRows,
  tileTappable,
  wallCounts,
  wallGlyph,
  wallInteractive,
  type BatchItemStateName,
  type BatchStateName,
  type TargetCandidate,
  type TargetStrategy,
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
  /** build B — 'requested' marks a SYSTEM auto-save (person-shield); null is an ordinary rescue. */
  savedReason: 'requested' | null;
  /** build B — a human un-saved a requester auto-save (the sweep will delete it). */
  requestedOverride: boolean;
  posterUrl: string | null;
  imdbRating: number | null;
  tmdbRating: number | null;
  recentlyWatched: boolean;
  /** DESIGN-010 D-12 — cross-server watch visibility (info, not protection). */
  lastWatchedAt: string | null;
  lastWatchedServer: string | null;
  requesters: string[];
}

/** The pending-candidate fields the new-candidates diff + the Start-a-batch target preview read (a
 *  subset of trash.pending items). Size/rating/protectedByTag feed `previewTargetSelection`. */
interface PendingCandidate {
  maintainerrMediaId: string | null;
  mediaItemId: string | null;
  title: string;
  year: number | null;
  posterUrl: string | null;
  sizeBytes: number;
  imdbRating: number | null;
  tmdbRating: number | null;
  protectedByTag: boolean;
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
  requesters: readonly string[] = [],
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
      // ADR-025 errata — a protected batch item is held by a live exclusion; tap un-protects it (removes
      // the exclusion, then re-classifies). Inert copy is kept for read-only phases.
      return tappable
        ? `${title} is protected — tap to un-protect it`
        : `${title} is protected — already safe from deletion`;
    case 'eye':
      return `${title} was watched recently — the guardian keeps it`;
    case 'requested': {
      const who =
        requesters.length > 0 ? `${title} was requested by ${requesters.join(', ')}` : `${title} was requested`;
      // build B — on the batch wall the person-shield is a system auto-save: tappable ⇒ un-save it
      // (it then deletes at sweep). Inert ⇒ the read-only "protected from deletion".
      return tappable ? `${who} — auto-saved; tap to un-save it` : `${who} — protected from deletion`;
    }
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
  const unprotect = trpc.trash.batches.unprotectItem.useMutation();
  const fromKey = fromKeyFor(kind);

  const effectiveState = (item: BatchItemWire): BatchItemStateName =>
    overrides.get(item.id) ?? item.state;

  const tap = (item: BatchItemWire) => {
    if (inFlight.has(item.id)) return; // one flip at a time per tile — no queued double-toggles
    const current = effectiveState(item);
    setInFlight((prev) => new Set(prev).add(item.id));
    setWallError(null);
    // Shared reconcile — the server verdict is authoritative. On an INERT tap (changed:false) `state`
    // is the item's REAL current state; the refetch also lands the person-shield savedReason.
    const handlers = {
      onSuccess: (res: { state: BatchItemStateName }) => {
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
    };

    // A `protected` (check) tile UN-PROTECTS: the server removes the live exclusion and re-classifies
    // the row. The optimistic landing mirrors the domain rule (requester-carrying ⇒ the person-shield
    // 'saved'; else the slated 'pending'); the refetch reconciles the exact verdict + savedReason.
    if (current === 'protected') {
      const optimistic: BatchItemStateName = item.requesters.length > 0 ? 'saved' : 'pending';
      setOverrides((prev) => new Map(prev).set(item.id, optimistic));
      unprotect.mutate({ batchId, itemId: item.id }, handlers);
      return;
    }

    const desired = current !== 'saved';
    setOverrides((prev) => new Map(prev).set(item.id, desired ? 'saved' : 'pending'));
    setSaved.mutate({ batchId, itemId: item.id, saved: desired }, handlers);
  };

  const effective = items.map((item) => ({ item, state: effectiveState(item) }));
  const counts = wallCounts(
    effective.map(({ item, state }) => ({
      state,
      recentlyWatched: item.recentlyWatched,
      requesters: item.requesters,
      sizeBytes: item.sizeBytes,
      savedReason: item.savedReason,
      requestedOverride: item.requestedOverride,
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
          const glyph = wallGlyph(state, item.recentlyWatched, item.requesters, {
            savedReason: item.savedReason,
            requestedOverride: item.requestedOverride,
          });
          const tappable = tileTappable(ctx, glyph, item.savedBy, { state });
          const savedByName = item.savedBy !== null ? (saverNames.get(item.savedBy) ?? null) : null;
          const label = tileLabel(item.title, glyph, tappable, savedByName, item.requesters);
          const rating = formatRating(
            ratingOrNull(item.imdbRating) ?? ratingOrNull(item.tmdbRating),
          );
          // DESIGN-010 D-12 — the muted "watched a while ago" indicator (info, not protection); null
          // unless watched longer ago than the recently-watched window.
          const watchLabel = watchedLongAgo(item)
            ? lastWatchedLabel(item.lastWatchedAt, item.lastWatchedServer)
            : null;
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
                  aria-pressed={glyph === 'shield' || glyph === 'requested' || glyph === 'check'}
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
                <span className="bwall-meta-text">
                  {item.sizeBytes > 0 ? formatBytes(item.sizeBytes) : '—'}
                  {rating !== null ? ` · ★ ${rating}` : ''}
                </span>
                {watchLabel !== null ? <WatchedAgoNote label={watchLabel} /> : null}
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
  windowOpen,
  onClose,
}: {
  batch: BatchSummaryWire;
  items: BatchItemWire[];
  safe: boolean;
  /** The save window is still open ⇒ this is the owner-directed ADMIN OVERRIDE (danger + typed confirm). */
  windowOpen: boolean;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [result, setResult] = useState<SweepBatchWire | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
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

  // Honest preview over the batch's remaining `pending` items (the sweep's only candidates). The
  // sweep guardian keeps recently-watched AND requested items, so neither counts toward willDelete.
  const pending = items.filter((i) => i.state === 'pending');
  const willDelete = pending.filter(
    (i) => !i.recentlyWatched && i.requesters.length === 0 && i.mediaItemId !== null,
  ).length;
  const willKeep = pending.length - willDelete;
  const savedCount = batch.counts.saved;
  const daysLeft = daysUntil(batch.expiresAt);
  // Mid-window force ⇒ require a TYPED confirmation (the word DELETE or the delete count) before arming.
  const typedOk = !windowOpen || forceExpireConfirmMatches(typed, willDelete);

  return (
    <Modal
      open
      title={
        result !== null
          ? 'Deletion report'
          : windowOpen
            ? 'Force-delete this batch now'
            : 'Delete this batch now'
      }
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
          {windowOpen ? (
            <p className="alert" role="alert" data-testid="batch-expire-override-warn">
              <strong className="trash-danger-text">The save window hasn’t closed yet</strong> — it
              still has{' '}
              <strong>
                {daysLeft ?? 0} more day{(daysLeft ?? 0) === 1 ? '' : 's'}
              </strong>{' '}
              to run. This is an admin override: deleting now ends the window early, so anyone still
              hoping to rescue a title loses the chance.
              {savedCount > 0
                ? ` The ${savedCount} already-rescued item${savedCount === 1 ? '' : 's'} stay${savedCount === 1 ? 's' : ''} protected.`
                : ''}
            </p>
          ) : null}
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
          {windowOpen ? (
            <label className="form-row batch-force-confirm" data-testid="batch-expire-typed-row">
              <span>
                Type <strong>DELETE</strong> (or the number <strong>{willDelete}</strong>) to
                confirm this early override:
              </span>
              <input
                type="text"
                className="batch-force-input"
                autoComplete="off"
                value={typed}
                data-testid="batch-expire-typed"
                aria-label="Type DELETE to confirm the early override"
                onChange={(e) => setTyped(e.target.value)}
              />
            </label>
          ) : null}
          <div className="form-actions">
            <button
              type="button"
              className="btn danger"
              data-testid="batch-expire-submit"
              disabled={expire.isPending || !safe || !typedOk}
              title={
                !safe
                  ? 'Disabled — Maintainerr is not in a safe state (see the banner).'
                  : !typedOk
                    ? 'Type DELETE (or the delete count) to confirm the early override.'
                    : windowOpen
                      ? 'Force the deletion sweep now — the save window has not closed (admin override).'
                      : 'Run the deletion sweep for this batch now'
              }
              onClick={() => expire.mutate({ batchId: batch.id, forceOverride: windowOpen })}
            >
              {expire.isPending
                ? 'Deleting…'
                : windowOpen
                  ? 'Force-delete the remaining items now'
                  : 'Delete the remaining items now'}
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

// ── Start-a-batch Modal (DESIGN-011 amendment 2026-07-08 — reclaim-targeted creation) ─────
function StartBatchModal({
  kind,
  label,
  candidates,
  caps,
  onClose,
}: {
  kind: 'movie' | 'tv';
  label: string;
  /** The LIVE actionable pending rows (maintainerrMediaId present) — the preview source. */
  candidates: TargetCandidate[];
  /** The space-policy per-kind caps (DESIGN-014 amendment 2026-07-09, build A) — PRE-FILL the picker
   *  when an admin has configured them; absent ⇒ the plain defaults (all candidates / 20 GB). */
  caps?: {
    maxItems: { enabled: boolean; value: number };
    targetBytes: { enabled: boolean; value: number };
  };
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const capSize = caps?.targetBytes.enabled === true;
  const capCount = caps?.maxItems.enabled === true;
  const anyCap = capSize || capCount;
  const [mode, setMode] = useState<'all' | 'target'>(anyCap ? 'target' : 'all');
  // With no policy caps configured, "Cap the batch" defaults to the SIZE cap on (the classic GB
  // target). A policy maxItems-only cap respects that (size off); a targetBytes cap turns size on.
  const [useSize, setUseSize] = useState<boolean>(capSize || !anyCap);
  const [gb, setGb] = useState(capSize ? String(Math.round((caps!.targetBytes.value / BYTES_PER_GB) * 10) / 10) : '20');
  const [useCount, setUseCount] = useState<boolean>(capCount);
  const [maxItemsStr, setMaxItemsStr] = useState(capCount ? String(caps!.maxItems.value) : '25');
  // Policy batches trim worst-rated first, so pre-fill that when caps drove the picker into target mode.
  const [strategy, setStrategy] = useState<TargetStrategy>(anyCap ? 'worst-rated' : 'largest');
  const [error, setError] = useState<string | null>(null);
  const create = trpc.trash.batches.create.useMutation({
    onSuccess: () => {
      setError(null);
      void utils.trash.batches.invalidate();
      onClose();
    },
    onError: (err: unknown) => setError(describeMutationError(err)),
  });

  const gbNum = Number(gb);
  const gbValid = Number.isFinite(gbNum) && gbNum > 0;
  const maxNum = Number(maxItemsStr);
  const maxValid = Number.isInteger(maxNum) && maxNum > 0;
  const targetBytes = useSize && gbValid ? Math.round(gbNum * BYTES_PER_GB) : undefined;
  const maxItems = useCount && maxValid ? maxNum : undefined;

  // The default "all" batch snapshots every actionable item; only tag-unprotected items free space.
  const allCount = candidates.length;
  const freeableBytes = candidates
    .filter((c) => !c.protectedByTag)
    .reduce((n, c) => n + c.sizeBytes, 0);
  const preview = previewTargetSelection(candidates, { targetBytes, maxItems, strategy });

  const plural = (n: number) => (n === 1 ? '' : 's');
  const capsChosen = (useSize && gbValid) || (useCount && maxValid);
  const canSubmit =
    !create.isPending &&
    (mode === 'all' ? allCount > 0 : capsChosen && preview.poolCount > 0);

  const submit = () => {
    if (mode === 'all') {
      create.mutate({ mediaKind: kind });
    } else {
      create.mutate({ mediaKind: kind, targetBytes, maxItems, strategy });
    }
  };

  return (
    <Modal
      open
      title={`Start a ${label} batch`}
      onClose={() => {
        if (!create.isPending) onClose();
      }}
      banner={
        error !== null ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null
      }
    >
      <div className="trash-confirm" data-testid="batch-start-modal">
        <p>
          Snapshot the current candidates into a review batch. Choose how much to free — the server
          re-picks from a fresh snapshot when you start.
        </p>
        <div className="batch-start-modes" role="radiogroup" aria-label="Batch size">
          <label className="batch-start-mode">
            <input
              type="radio"
              name="batch-size-mode"
              checked={mode === 'all'}
              data-testid="batch-mode-all"
              onChange={() => setMode('all')}
            />
            <span>
              <strong>All current candidates</strong> — {allCount} item{plural(allCount)} · frees{' '}
              {formatBytes(freeableBytes)}
            </span>
          </label>
          <label className="batch-start-mode">
            <input
              type="radio"
              name="batch-size-mode"
              checked={mode === 'target'}
              data-testid="batch-mode-target"
              onChange={() => setMode('target')}
            />
            <span>
              <strong>Cap the batch</strong> — take just enough by size and/or item count.
            </span>
          </label>
        </div>
        {mode === 'target' ? (
          <div className="batch-start-target" data-testid="batch-target-fields">
            <label className="form-row batch-window-row">
              <input
                type="checkbox"
                checked={useSize}
                data-testid="batch-target-usesize"
                aria-label="Cap the batch by size"
                onChange={(e) => setUseSize(e.target.checked)}
              />
              Free about
              <input
                type="number"
                className="batch-window-input"
                min={1}
                value={gb}
                disabled={!useSize}
                data-testid="batch-target-gb"
                aria-label="Target amount to free, in GB"
                onChange={(e) => setGb(e.target.value)}
              />
              GB
            </label>
            <label className="form-row batch-window-row">
              <input
                type="checkbox"
                checked={useCount}
                data-testid="batch-target-usecount"
                aria-label="Cap the batch by item count"
                onChange={(e) => setUseCount(e.target.checked)}
              />
              Up to
              <input
                type="number"
                className="batch-window-input"
                min={1}
                value={maxItemsStr}
                disabled={!useCount}
                data-testid="batch-target-maxitems"
                aria-label="Maximum items in the batch"
                onChange={(e) => setMaxItemsStr(e.target.value)}
              />
              items
            </label>
            <label className="form-row batch-window-row">
              Take the
              <select
                className="batch-strategy-select"
                value={strategy}
                data-testid="batch-target-strategy"
                aria-label="Which candidates to take first"
                onChange={(e) => setStrategy(e.target.value as TargetStrategy)}
              >
                {TARGET_STRATEGIES.map((s) => (
                  <option key={s} value={s}>
                    {TARGET_STRATEGY_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted batch-target-preview" data-testid="batch-target-preview">
              {capsChosen
                ? preview.poolCount === 0
                  ? 'No deletable candidates to target — everything pending is protected.'
                  : `≈ ${preview.count} item${plural(preview.count)} · frees ${formatBytes(preview.bytes)} (of ${preview.poolCount} candidate${plural(preview.poolCount)} · ${formatBytes(preview.poolBytes)} available)`
                : 'Pick a size and/or item cap (both stop at whichever hits first).'}
            </p>
          </div>
        ) : null}
        <div className="form-actions">
          <button
            type="button"
            className="btn primary"
            data-testid="batch-start-submit"
            disabled={!canSubmit}
            onClick={submit}
          >
            {create.isPending
              ? 'Starting…'
              : mode === 'all'
                ? `Start with ${allCount} item${plural(allCount)}`
                : `Start — free ~${formatBytes(preview.bytes)}`}
          </button>
          <button type="button" className="btn" disabled={create.isPending} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── "Potential in future batches" — a FULL interactive paginated wall (owner-directed 2026-07-09) ──
// When a batch is open this strip shows the LIVE candidates NOT in that batch (the server subtracts
// the open batch's members via excludeOpenBatch). It is now the SAME wall as the live pending wall:
// infinite scroll + the fast tap-to-save toggle. A save = the guarded Maintainerr exclusion → the
// item is whitelisted → it never enters a future batch; requested items show the person-shield per
// the shipped precedence. The header keeps the honest server count.
function FutureCandidatesWall({
  kind,
  access,
  status,
}: {
  kind: 'movie' | 'tv';
  access: TrashAccess;
  status: SafetyLike | undefined;
}) {
  const label = kind === 'movie' ? 'Movies' : 'TV';
  const reachable = status?.reachable === true;
  const canSave = access.actions.includes('save_exclude') && reachable;
  const canUnsave = access.actions.includes('remove_exclude') && reachable;
  const fromKey = fromKeyFor(kind);

  const q = trpc.trash.pending.useInfiniteQuery(
    { media: kind, excludeOpenBatch: true, limit: 50 },
    {
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      placeholderData: (prev) => prev,
      enabled: reachable,
    },
  );
  const pages = q.data?.pages ?? [];
  const items: PendingWallItem[] = pages.flatMap((p) => p.items);
  const total = pages[0]?.total ?? 0;
  // ADR-035 — the strip serves the candidate snapshot; carry its honest age in the head line.
  const asOf = candidatesAsOfLabel(pages[0]?.refreshedAt ?? null);
  const refreshing = q.isPlaceholderData && q.isFetching;

  const { overrides, busy, error, toggle } = usePendingSaves(kind);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const canLoadMore = q.hasNextPage === true && !q.isFetchingNextPage && !q.isPlaceholderData;
  useInfiniteScroll(sentinelRef, canLoadMore, () => void q.fetchNextPage());

  // Nothing to show: unreachable Maintainerr, or no candidates left outside the batch. Hide the strip.
  if (!reachable) return null;
  if (!q.isLoading && total === 0) return null;

  return (
    <div className="batch-newcands" data-testid="batch-new-candidates">
      <p className="batch-newcands__head muted">
        Potential in future batches ({total}) — eligible for the next batch; tap a poster to save it
        out.{asOf !== null ? ` ${asOf}.` : ''}
      </p>
      <p className="bwall-error" role="alert" data-testid="future-wall-error">
        {error ?? ''}
      </p>
      <PendingWall
        items={items}
        media={kind}
        fromKey={fromKey}
        overrides={overrides}
        busy={busy}
        canSave={canSave}
        canUnsave={canUnsave}
        onToggle={toggle}
        loading={q.isLoading}
        refreshing={refreshing}
        emptyLabel="Nothing else is eligible for a future batch."
        wallLabel={`Potential future-batch ${label}`}
        sentinelRef={sentinelRef}
        hasNextPage={q.hasNextPage === true}
        isFetchingNextPage={q.isFetchingNextPage}
        onLoadMore={() => void q.fetchNextPage()}
        testId="future-wall"
      />
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

  // tz-correct + hour-aware countdown (DESIGN-011/014 amendment 2026-07-09, build A). Under 48h this
  // reads "closes today 11:04 PM · in 15h"; at 48h+ "closes Jul 21 · in 9 days". Day words are ET
  // calendar comparisons, so an 11:04 PM-ET-today expiry never mislabels as "tomorrow".
  const countdown = deadlineCountdown(batch.expiresAt);
  const saverNames = new Map<string, string>();
  for (const u of saveStats?.byUser ?? []) {
    if (u.userId !== null && u.displayName !== null) saverNames.set(u.userId, u.displayName);
  }

  const windowMeta =
    batch.state === 'leaving_soon' && batch.expiresAt !== null ? (
      <>
        window closes {countdown.whenLabel}
        {countdown.hourLevel ? ' · ' : ' '}
        <span className={`trash-days trash-days--${countdown.tone}`}>{countdown.relLabel}</span>
      </>
    ) : (
      <>created {formatDay(batch.createdAt)}</>
    );

  // The window-open case is NO LONGER a block: a manager may force-expire mid-window (owner-directed
  // admin override — DESIGN-011 amendment 2026-07-08). Only an unsafe install disables the button; the
  // override's danger + typed confirm live in the Modal.
  const expireBlocked = !safe
    ? 'Disabled — Maintainerr is not in a safe state (see the banner).'
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
            Green-light
          </button>
        ) : null}
        {canManage && batch.state === 'leaving_soon' ? (
          <button
            type="button"
            className="btn sm danger"
            data-testid="batch-expire"
            disabled={expireBlocked !== null}
            title={
              expireBlocked ??
              (windowOpen
                ? 'Force the deletion sweep now — the save window has not closed (admin override)'
                : 'Run the deletion sweep for this batch now')
            }
            onClick={() => setModal('expire')}
          >
            Delete now
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
          data-tone={windowOpen ? countdown.tone : 'muted'}
          data-testid="batch-countdown"
          role="status"
        >
          {countdownCopy(countdown.relLabel, windowOpen, wallInteractive(ctx))}
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

      {/* Admin-only: the full interactive paginated wall of live candidates NOT in this batch —
          eligible for the NEXT batch; tap-to-save works exactly like the live wall. */}
      {canManage ? <FutureCandidatesWall kind={kind} access={access} status={status} /> : null}

      {modal === 'greenlight' ? (
        <GreenlightModal
          batch={batch}
          defaultWindowDays={defaultWindowDays}
          onClose={() => setModal(null)}
        />
      ) : null}
      {modal === 'expire' ? (
        <ExpireModal
          batch={batch}
          items={items ?? []}
          safe={safe}
          windowOpen={windowOpen}
          onClose={() => setModal(null)}
        />
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
  // The actionable-candidate list + TRUE count (owner-directed 2026-07-09): the paginated pending
  // wall no longer returns the whole set, so the candidate COUNT header and the Start-a-batch target
  // preview read this lean endpoint (all actionable candidates, no per-page live-exclusion cost). The
  // open-batch "Potential in future batches" wall paginates independently (FutureCandidatesWall).
  const candidates = trpc.trash.pendingCandidates.useQuery(
    { media: kind },
    { enabled: canManage && reachable },
  );
  const settings = trpc.trash.settings.get.useQuery(undefined, { enabled: viewerIsAdmin });
  // Admin-only: the space-policy per-kind caps PRE-FILL the Start-a-batch picker (DESIGN-014 amendment
  // 2026-07-09, build A). storage.policy.get is adminProcedure, so gate the read on viewerIsAdmin — a
  // non-admin batch manager simply gets the un-prefilled picker.
  const policy = trpc.storage.policy.get.useQuery(undefined, { enabled: viewerIsAdmin });
  const kindCaps = policy.data?.perKind?.[kind];

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

  // ── create (Start a batch) — admin-only, only when none is open; opens the target-picker Modal ──
  const [showStart, setShowStart] = useState(false);
  // The LIVE actionable candidates (a Maintainerr id present) — the Start modal's preview source.
  const pendingCandidates: TargetCandidate[] = (
    (candidates.data?.candidates as PendingCandidate[] | undefined) ?? []
  ).map((p) => ({
    sizeBytes: p.sizeBytes,
    imdbRating: p.imdbRating,
    tmdbRating: p.tmdbRating,
    protectedByTag: p.protectedByTag,
  }));

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
          canManage={canManage}
        />
      ) : (
        <>
          {/* No open batch — the live candidates wall + an admin-only "Start a batch". */}
          {canManage ? (
            <div className="batches-head" data-testid="batch-start-head">
              <p className="batches-hint muted" data-testid="batch-candidates">
                {candidates.data !== undefined
                  ? `${candidates.data.count} ${kindNoun} candidate${candidates.data.count === 1 ? '' : 's'} currently proposed by the rules.`
                  : reachable
                    ? 'Checking the current candidates…'
                    : 'Maintainerr is unreachable — candidates can’t be read right now.'}
              </p>
              <span className="batch-strip__spacer" />
              <button
                type="button"
                className="btn sm primary"
                data-testid="batch-start"
                disabled={!reachable}
                title={
                  reachable
                    ? `Snapshot the current pending ${label} into a review batch`
                    : 'Disabled — Maintainerr is unreachable (see the banner).'
                }
                onClick={() => setShowStart(true)}
              >
                Start a batch
              </button>
            </div>
          ) : null}
          {pendingWall}
        </>
      )}

      {showStart ? (
        <StartBatchModal
          kind={kind}
          label={label}
          candidates={pendingCandidates}
          caps={kindCaps}
          onClose={() => setShowStart(false)}
        />
      ) : null}

      <PastBatches batches={pastBatches} kind={kind} />
    </div>
  );
}
