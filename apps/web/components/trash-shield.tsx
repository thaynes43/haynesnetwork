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
import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { formatBytes, formatDay } from '@/lib/media';
import { describeMutationError } from '@/lib/app-error';
import { daysLeftLabel, daysLeftTone, daysUntil, type TrashActionName } from '@/lib/trash';

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
  // Session-local shield override: the dnd tag only lands on the NEXT *arr sync, so a fresh
  // save/un-save is reflected here rather than waiting for protectedByTag to catch up.
  const [override, setOverride] = useState<'saved' | 'unsaved' | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const on = override === 'saved' || (item.protectedByTag && override !== 'unsaved');
  const days = daysUntil(item.scheduledDeleteAt);
  const canSave = access.actions.includes('save_exclude');
  const canUnsave = access.actions.includes('remove_exclude');

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
    </section>
  );
}
