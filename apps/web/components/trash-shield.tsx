'use client';

// DESIGN-010 D-09 — the Save/whitelist SHIELD, the Trash section's protective affordance
// (R-83). One shared control for the /trash pending rows and the /library/[id] guard panel:
// off = outline shield ("Save — protect from deletion"), on = filled accent shield ("Saved").
// Save/un-save are PROTECTIVE + reversible, so the shield is a plain toggle (no two-step —
// ADR-014 reserves that for destructive actions); toggling recolors the glyph, never the
// layout (ADR-015 — the button footprint is constant in both states).
//
// The library guard panel (TrashPendingNotice) is the DESIGN-010 Q-02 resolution: the
// detail-page shield renders ONLY while the item is actually in Maintainerr's pending set
// (protect-in-context) — saveExclusion needs the Maintainerr mediaServerId (a Plex ratingKey),
// which exists only on pending rows; Maintainerr has no tmdb/tvdb lookup endpoint to resolve
// one for arbitrary ledger items (D-02), and we never guess ratingKeys.
import Link from 'next/link';
import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { formatBytes, formatDay } from '@/lib/media';
import { describeMutationError } from '@/lib/app-error';
import { daysLeftLabel, daysLeftTone, daysUntil, type TrashActionName } from '@/lib/trash';
import { ItemExpediteModal } from '@/components/trash-expedite';

/** The caller's Trash access, resolved server-side and passed down (session-carried). */
export interface TrashAccess {
  level: 'read_only' | 'edit';
  actions: TrashActionName[];
}

export function ShieldGlyph({ filled }: { filled: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3Z" />
      {filled ? <path d="m9 12 2 2 4-4" stroke="var(--color-surface)" fill="none" /> : null}
    </svg>
  );
}

/** The protected-elsewhere shield-check — outline shield with an inner check, distinct from the
 *  FILLED saved-by-you shield: same 16×16 box + stroke weight as its siblings. Marks pending-wall
 *  tiles protected by the *arr `dnd` tag or a live exclusion made outside this session (inert). */
export function ShieldCheckGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

/** The Expedite trash-can glyph — icon twin of ShieldGlyph, same 16×16 box + stroke weight so the
 *  two per-tile actions read as one equal-weight pair (ADR-015 — constant footprint). */
export function TrashCanGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 7h16" />
      <path d="M10 4h4a1 1 0 0 1 1 1v2H9V5a1 1 0 0 1 1-1Z" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

/** The requester PERSON-SHIELD — a personal requester is on record, so the guardian refuses the
 *  item's deletion at expedite/sweep; inert (a trash-can would be dishonest). A person inside the
 *  shield, deliberately DISTINCT from the exclusion shield-check. Same 16×16 box + stroke weight. */
export function RequesterShieldGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3Z" />
      <circle cx="12" cy="10" r="1.9" />
      <path d="M8.7 15.2c0-1.7 1.5-2.7 3.3-2.7s3.3 1 3.3 2.7" />
    </svg>
  );
}

/** The recently-watched EYE — the guardian keeps it; inert on both walls (a delete-glyph here
 *  would be dishonest). Same 16×16 box + stroke weight as its siblings. */
export function EyeGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12s3.2-5.5 9-5.5S21 12 21 12s-3.2 5.5-9 5.5S3 12 3 12Z" />
      <circle cx="12" cy="12" r="2.4" />
    </svg>
  );
}

/** The SKIP ⊘ — the sweep kept it (unverifiable / guardian at sweep time); kept, NOT saved
 *  (skipped ≠ protected, ADR-023 C-07b). Terminal-batch glyph. */
export function SkipGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6.2 6.2l11.6 11.6" />
    </svg>
  );
}

/** The GONE tombstone — deleted by the sweep. Terminal-batch glyph (the poster grays out too). */
export function GoneGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 7.5h14" />
      <path d="M9.5 7.5V6a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5" />
      <path d="M7 7.5l1 11h8l1-11" />
    </svg>
  );
}

/** The corner LIBRARY-nav glyph (an open book) — the poster now toggles, so /library/[id]
 *  navigation moves to this dedicated corner icon (owner refinement 2026-07-07). Visually
 *  distinct from the shield/trash toggle so it is never a tap-by-accident. */
export function LibraryLinkGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 6.5C10.5 5.2 8.5 4.5 5.5 4.5H4v13.5h1.5c3 0 5 .7 6.5 2 1.5-1.3 3.5-2 6.5-2H20V4.5h-1.5c-3 0-5 .7-6.5 2Z" />
      <path d="M12 6.5v13" />
    </svg>
  );
}

/**
 * The corner LIBRARY-nav link for a wall tile (owner refinement 2026-07-07 — the poster toggles,
 * so /library/[id] navigation moves to this dedicated, visually-distinct corner). Carries the
 * `?from=` context (Part 2) so the item page's back link returns here with scroll/filters intact.
 */
export function LibraryCornerLink({
  href,
  title,
  ariaLabel,
}: {
  href: string;
  title: string;
  ariaLabel: string;
}) {
  return (
    <Link
      className="pwall-corner pwall-liblink"
      href={href}
      data-testid="wall-lib-link"
      title={title}
      aria-label={ariaLabel}
    >
      <LibraryLinkGlyph />
    </Link>
  );
}

/**
 * The shared wall overlay glyph (both the /trash pending candidates wall and the batch curation
 * wall — owner-directed unification 2026-07-07). Keep the keys in lockstep with
 * `lib/trash-batches.ts` `WallGlyph` and `lib/trash.ts` `PendingWallGlyph`.
 */
export function WallGlyphSvg({
  glyph,
}: {
  glyph: 'trash' | 'shield' | 'check' | 'eye' | 'requested' | 'skip' | 'gone';
}) {
  switch (glyph) {
    case 'trash':
      return <TrashCanGlyph />;
    case 'shield':
      return <ShieldGlyph filled />;
    case 'check':
      return <ShieldCheckGlyph />;
    case 'eye':
      return <EyeGlyph />;
    case 'requested':
      return <RequesterShieldGlyph />;
    case 'skip':
      return <SkipGlyph />;
    case 'gone':
      return <GoneGlyph />;
  }
}

export interface ShieldButtonProps {
  /** Is the item currently protected (excluded / dnd-tagged / saved this session)? */
  on: boolean;
  itemTitle: string;
  canSave: boolean;
  canUnsave: boolean;
  busy?: boolean;
  onSave: () => void;
  onUnsave: () => void;
}

/** The shield toggle. Renders a static (disabled) filled shield when the item is protected
 *  but the caller lacks remove_exclude — the state still reads, it just isn't actionable. */
export function ShieldButton({
  on,
  itemTitle,
  canSave,
  canUnsave,
  busy = false,
  onSave,
  onUnsave,
}: ShieldButtonProps) {
  const actionable = on ? canUnsave : canSave;
  const label = on
    ? canUnsave
      ? `Un-save ${itemTitle} — remove its deletion protection`
      : `${itemTitle} is protected from deletion`
    : `Save ${itemTitle} — protect it from deletion`;
  return (
    <button
      type="button"
      className={`shield-btn${on ? ' is-on' : ''}`}
      data-testid="trash-shield"
      data-on={on || undefined}
      aria-pressed={on}
      aria-label={label}
      title={label}
      disabled={busy || !actionable}
      onClick={on ? onUnsave : onSave}
    >
      <ShieldGlyph filled={on} />
    </button>
  );
}

/**
 * DESIGN-010 D-09 / Q-02 — the /library/[id] deletion-guard panel (Movies + TV only; the
 * caller never mounts this for music). Looks the item up in the live pending set; renders
 * nothing when the item isn't pending (or the pending read fails — the detail page must never
 * break on Maintainerr trouble). When pending: the scheduled-delete warning + the shield.
 */
export function TrashPendingNotice({
  mediaItemId,
  arrKind,
  access,
}: {
  mediaItemId: string;
  arrKind: 'radarr' | 'sonarr';
  access: TrashAccess;
}) {
  const utils = trpc.useUtils();
  const media = arrKind === 'radarr' ? 'movie' : 'tv';
  const pending = trpc.trash.pending.useQuery({ media });
  // The safety verdict gates "Delete now…" exactly like the wall's Expedite (destructive needs a
  // safe install); the shared trash.status query is cached with the /trash banner's read.
  const status = trpc.trash.status.useQuery(undefined, {
    enabled: access.actions.includes('expedite_item'),
  });
  // Session-local shield override: the dnd tag only lands on the NEXT *arr sync, so a fresh
  // save/un-save is reflected here rather than waiting for protectedByTag to catch up.
  const [override, setOverride] = useState<'saved' | 'unsaved' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expediteOpen, setExpediteOpen] = useState(false);

  const invalidate = () => void utils.trash.pending.invalidate({ media });
  const save = trpc.trash.saveExclusion.useMutation({
    onError: (err: unknown) => setError(describeMutationError(err)),
    onSuccess: () => {
      setError(null);
      setOverride('saved');
      invalidate();
    },
  });
  const unsave = trpc.trash.removeExclusion.useMutation({
    onError: (err: unknown) => setError(describeMutationError(err)),
    onSuccess: () => {
      setError(null);
      setOverride('unsaved');
      invalidate();
    },
  });

  if (pending.error) return null; // Maintainerr trouble must never break the detail page.
  const item = pending.data?.items.find((i) => i.mediaItemId === mediaItemId);
  if (item === undefined || item.maintainerrMediaId === null) return null;

  const on =
    override === 'saved' ||
    ((item.protectedByTag || item.protectedByExclusion) && override !== 'unsaved');
  const days = daysUntil(item.scheduledDeleteAt);
  const canSave = access.actions.includes('save_exclude');
  const canUnsave = access.actions.includes('remove_exclude');
  // "Delete now…" — the per-item Expedite relocated off the wall (owner refinement 2026-07-07):
  // admin/expedite_item-gated, only while the item is still slated (not saved/protected) and the
  // install is safe. Always the ADR-014 Modal (never one-click) — via ItemExpediteModal.
  const canExpedite = access.actions.includes('expedite_item');
  const safe = status.data?.safe === true;

  return (
    <section className="card trash-panel" data-testid="trash-guard" role="status">
      <span className="trash-panel__icon" aria-hidden="true">
        <ShieldGlyph filled={on} />
      </span>
      <div className="trash-panel__body">
        <p className="trash-panel__title">
          {on ? 'Protected from deletion' : 'Scheduled for deletion'}
          {item.scheduledDeleteAt !== null && !on ? (
            <>
              {' — '}
              {formatDay(item.scheduledDeleteAt)}{' '}
              <span className={`trash-days trash-days--${daysLeftTone(days)}`}>
                {daysLeftLabel(days)}
              </span>
            </>
          ) : null}
        </p>
        <p className="muted trash-panel__meta">
          {on
            ? 'Maintainerr will keep this item — un-saving puts it back under its deletion rules.'
            : `Maintainerr’s “${item.collectionTitle ?? 'deletion'}” rule flagged it — deleting frees ${formatBytes(item.sizeBytes)}. Save it to keep it.`}
        </p>
        {error !== null ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="trash-panel__actions">
        {canExpedite && !on ? (
          <button
            type="button"
            className="btn sm danger"
            data-testid="trash-delete-now"
            disabled={!safe}
            title={
              safe
                ? 'Expedite this item’s deletion now'
                : 'Disabled — Maintainerr is not in a safe state (see the Trash banner).'
            }
            onClick={() => setExpediteOpen(true)}
          >
            Delete now…
          </button>
        ) : null}
        {canSave || canUnsave ? (
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
      </div>
      {expediteOpen && item.maintainerrMediaId !== null ? (
        <ItemExpediteModal
          media={media}
          item={{
            collectionId: item.collectionId,
            maintainerrMediaId: item.maintainerrMediaId,
            mediaItemId: item.mediaItemId,
            title: item.title,
            year: item.year,
            sizeBytes: item.sizeBytes,
            protectedByTag: item.protectedByTag,
            recentlyWatched: item.recentlyWatched,
            requesters: item.requesters,
          }}
          safe={safe}
          onClose={() => setExpediteOpen(false)}
        />
      ) : null}
    </section>
  );
}
