'use client';

// DESIGN-010 amendment (2026-07-08) — the Trash OVERVIEW landing (the new DEFAULT tab). Owner
// rationale: aggregate what's slated BEFORE navigating, so a TV-only deletion window can never hide
// behind an empty Movies tab. One KIND CARD per kind (Movies, TV) is the star — count slated, the
// open-batch state + deadline, reclaimable bytes, and a state tone (neutral / info admin-review /
// warn leaving-soon / danger ≤3 days). The whole card clicks into its kind tab (keyboard accessible
// — it's a <button>). Below, a light RECENT STRIP: the newest Recently-Deleted rows + Activity
// events, one line each, linking to those tabs. ADR-015: the cards reserve their height; a refetch
// dims in place, never reflows.
import { formatBytes, formatDay, formatWhen } from '@/lib/media';
import { overviewCardTone, overviewDeadlineLabel } from '@/lib/trash';

// ── wire-shape aliases (structural mirrors of the trash.overview contract; the client never imports
//    server packages — same pattern as trash-client.tsx) ──
interface OverviewKind {
  kind: 'movie' | 'tv';
  slatedCount: number;
  reclaimableBytes: number;
  live: boolean;
  batch: { state: string; expiresAt: string | null; pendingCount: number } | null;
}
interface OverviewDeleted {
  mediaItemId: string;
  title: string;
  year: number | null;
  media: 'movie' | 'tv';
  sizeOnDisk: number;
  deletedAt: string | null;
  deletedBy: string | null;
}
interface OverviewEvent {
  id: string;
  type: string;
  title: string;
  body: string;
  createdAt: string;
}
export interface OverviewData {
  kinds: OverviewKind[];
  recentlyDeleted: OverviewDeleted[];
  activity: OverviewEvent[];
}

const KIND_LABELS: Record<'movie' | 'tv', string> = { movie: 'Movies', tv: 'TV' };

function KindCard({ kind, onOpen }: { kind: OverviewKind; onOpen: () => void }) {
  const tone = overviewCardTone(kind.batch);
  const label = KIND_LABELS[kind.kind];
  const hasBatch = kind.batch !== null;
  const unknown = !kind.live && !hasBatch;
  const empty = kind.live && kind.slatedCount === 0 && !hasBatch;
  const deadline = overviewDeadlineLabel(kind.batch, formatDay);
  // The card is one button so the whole surface is the target (keyboard-accessible by default).
  const aria = unknown
    ? `${label}: candidates unavailable — open the ${label} tab`
    : empty
      ? `${label}: nothing pending — open the ${label} tab`
      : `${label}: ${kind.slatedCount} slated${deadline !== '' ? ` — ${deadline}` : ''} — open the ${label} tab`;
  return (
    <button
      type="button"
      className="trash-ovcard"
      data-tone={tone}
      data-testid="trash-ovcard"
      data-kind={kind.kind}
      aria-label={aria}
      onClick={onOpen}
    >
      <span className="trash-ovcard__head">
        <span className="trash-ovcard__kind">{label}</span>
        {hasBatch ? (
          <span className={`trash-ovcard__pill trash-ovcard__pill--${tone}`} data-testid="trash-ovcard-state">
            {kind.batch!.state === 'leaving_soon' ? 'Leaving Soon' : 'In review'}
          </span>
        ) : null}
      </span>

      {unknown ? (
        <span className="trash-ovcard__empty" data-testid="trash-ovcard-unknown">
          Candidates unavailable — Maintainerr is unreachable.
        </span>
      ) : empty ? (
        <span className="trash-ovcard__empty" data-testid="trash-ovcard-empty">
          Nothing pending — nothing is slated for deletion.
        </span>
      ) : (
        <>
          <span className="trash-ovcard__count">
            <span className="trash-ovcard__num" data-testid="trash-ovcard-count">
              {kind.slatedCount}
            </span>{' '}
            <span className="trash-ovcard__unit">slated</span>
          </span>
          {deadline !== '' ? (
            <span className="trash-ovcard__detail" data-testid="trash-ovcard-deadline">
              {deadline}
            </span>
          ) : null}
          {kind.reclaimableBytes > 0 ? (
            <span className="trash-ovcard__bytes" data-testid="trash-ovcard-bytes">
              frees {formatBytes(kind.reclaimableBytes)}
            </span>
          ) : null}
        </>
      )}
    </button>
  );
}

export function TrashOverview({
  overview,
  loading,
  error,
  onOpenKind,
  onOpenTab,
}: {
  overview: OverviewData | undefined;
  loading: boolean;
  error: string | null;
  /** Navigate into a kind tab (movie → ?tab=movies, tv → ?tab=tv). */
  onOpenKind: (kind: 'movie' | 'tv') => void;
  /** Navigate into a strip's tab (Recently Deleted / Activity). */
  onOpenTab: (tab: 'deleted' | 'activity') => void;
}) {
  if (error !== null) {
    return (
      <p className="alert" role="alert" data-testid="trash-overview-error">
        Couldn’t load the overview: {error}
      </p>
    );
  }
  if (loading || overview === undefined) {
    return (
      <div className="trash-overview" data-testid="trash-overview" aria-busy="true">
        <div className="trash-ovcards">
          {(['movie', 'tv'] as const).map((k) => (
            <div key={k} className="trash-ovcard trash-ovcard--skeleton" aria-hidden="true">
              <span className="skeleton-line" />
              <span className="skeleton-line skeleton-line--short" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const deleted = overview.recentlyDeleted;
  const activity = overview.activity;
  const hasStrip = deleted.length > 0 || activity.length > 0;

  return (
    <div className="trash-overview" data-testid="trash-overview">
      <div className="trash-ovcards">
        {overview.kinds.map((kind) => (
          <KindCard key={kind.kind} kind={kind} onOpen={() => onOpenKind(kind.kind)} />
        ))}
      </div>

      {hasStrip ? (
        <div className="trash-ovstrip" data-testid="trash-overview-strip">
          {deleted.length > 0 ? (
            <section className="trash-ovstrip__col">
              <button
                type="button"
                className="trash-ovstrip__head"
                onClick={() => onOpenTab('deleted')}
                data-testid="trash-overview-deleted-link"
              >
                Recently deleted →
              </button>
              <ul className="trash-ovstrip__list">
                {deleted.map((r) => (
                  <li key={r.mediaItemId} data-testid="trash-overview-deleted-row">
                    <span className="trash-ovstrip__title">
                      {r.title}
                      {r.year !== null ? <span className="muted"> ({r.year})</span> : null}
                    </span>
                    <span className="muted trash-ovstrip__meta">
                      {r.deletedBy ?? 'System'} · {r.sizeOnDisk > 0 ? formatBytes(r.sizeOnDisk) : '—'} ·{' '}
                      {r.deletedAt !== null ? formatWhen(r.deletedAt) : '—'}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {activity.length > 0 ? (
            <section className="trash-ovstrip__col">
              <button
                type="button"
                className="trash-ovstrip__head"
                onClick={() => onOpenTab('activity')}
                data-testid="trash-overview-activity-link"
              >
                Activity →
              </button>
              <ul className="trash-ovstrip__list">
                {activity.map((n) => (
                  <li key={n.id} data-testid="trash-overview-activity-row">
                    <span className="trash-ovstrip__title">{n.title !== '' ? n.title : n.type}</span>
                    <span className="muted trash-ovstrip__meta">{formatWhen(n.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : (
        <p className="muted" data-testid="trash-overview-strip-empty">
          No recent trash activity yet.
        </p>
      )}
    </div>
  );
}
