'use client';

// DESIGN-005 D-17 / D-15 — the /library/[id] client view: metadata card, the live
// per-episode / per-album list (D-06 ledger.children) with a per-child action —
// Fix when it is on disk (something to repair), Force Search when it is missing
// (nothing to blocklist, just search). Radarr acts at the movie level in the header.
// Below: fix history for the item (R-46) and the ledger event timeline (R-41).
import Link from 'next/link';
import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import {
  ARR_KIND_LABELS,
  EVENT_TYPE_LABELS,
  FIX_REASON_LABELS,
  FIX_STATUS_LABELS,
  fixStatusTone,
  formatBytes,
  formatWhen,
  onDiskSummary,
  type ArrKindName,
} from '@/lib/media';
import { KindIcon } from '@/components/kind-icon';
import { FixDialog } from './fix-dialog';
import { ForceSearchDialog } from './force-search-dialog';

/** The open dialog: repair (Fix) vs search-only (Force Search), and its target. */
type PendingAction = {
  mode: 'fix' | 'search';
  target: { childId: number; label: string } | null;
};

export function ItemDetail({ mediaItemId }: { mediaItemId: string }) {
  const utils = trpc.useUtils();
  const [action, setAction] = useState<PendingAction | null>(null);

  const detail = trpc.ledger.detail.useQuery({ id: mediaItemId });
  const events = trpc.ledger.events.useInfiniteQuery(
    { mediaItemId, limit: 25 },
    { getNextPageParam: (last) => last.nextCursor ?? undefined },
  );

  const arrKind = detail.data?.item.arrKind;
  const tombstoned = detail.data?.item.tombstonedAt != null;
  const needsChildren = arrKind === 'sonarr' || arrKind === 'lidarr';
  const childNoun = arrKind === 'lidarr' ? 'album' : 'episode';
  const children = trpc.ledger.children.useQuery(
    { mediaItemId },
    { enabled: needsChildren && !tombstoned },
  );

  if (detail.isLoading) return <p className="muted">Loading item…</p>;
  if (detail.error) {
    return (
      <p className="alert" role="alert">
        Failed to load this item: {detail.error.message}
      </p>
    );
  }
  const { item, fixes } = detail.data!;
  const disk = onDiskSummary(item);
  const timeline = events.data?.pages.flatMap((p) => p.events) ?? [];

  const refresh = () => {
    void utils.ledger.detail.invalidate({ id: mediaItemId });
    void utils.ledger.events.invalidate();
    void utils.ledger.children.invalidate({ mediaItemId });
    void utils.fix.myFixes.invalidate();
  };

  return (
    <>
      <p className="crumbs">
        <Link href="/library">← Library</Link>
      </p>

      <section className="card detail-head">
        <span className="media-card__icon detail-head__icon">
          <KindIcon kind={item.arrKind} />
        </span>
        <div className="detail-head__body">
          <h1 className="detail-head__title">
            {item.title}
            {item.year !== null ? <span className="muted"> ({item.year})</span> : null}
          </h1>
          <div className="media-card__badges">
            <span className="badge badge--muted">{ARR_KIND_LABELS[item.arrKind as ArrKindName]}</span>
            <span className={`badge badge--${disk.tone}`}>{disk.label}</span>
            {!item.monitored ? <span className="badge badge--muted">Not monitored</span> : null}
            {item.tombstonedAt !== null ? (
              <span className="badge badge--danger">Removed from the manager</span>
            ) : null}
          </div>
        </div>
        {/* Radarr acts at the movie level (the movie IS the unit — ADR-007). Sonarr/Lidarr
            act per episode/album below, so the show-level nuke is gone (owner feedback). */}
        {item.arrKind === 'radarr' ? (
          <div className="detail-head__actions">
            {item.onDiskFileCount > 0 ? (
              <button
                type="button"
                className="btn primary"
                disabled={item.tombstonedAt !== null}
                onClick={() => setAction({ mode: 'fix', target: null })}
              >
                Fix
              </button>
            ) : (
              <button
                type="button"
                className="btn primary"
                disabled={item.tombstonedAt !== null}
                onClick={() => setAction({ mode: 'search', target: null })}
              >
                Force Search
              </button>
            )}
          </div>
        ) : null}
      </section>

      {needsChildren ? (
        <section className="card admin-section">
          <h2>{item.arrKind === 'sonarr' ? 'Episodes' : 'Albums'}</h2>
          {item.tombstonedAt !== null ? (
            <p className="muted">This item was removed from the manager — nothing to fix.</p>
          ) : children.isLoading ? (
            <p className="muted">Loading {childNoun}s…</p>
          ) : children.error ? (
            <p className="alert" role="alert">
              Could not load the {childNoun} list: {children.error.message}
            </p>
          ) : (children.data ?? []).length === 0 ? (
            <p className="muted">No {childNoun}s found on the manager.</p>
          ) : (
            <ul className="child-list">
              {(children.data ?? []).map((child) => {
                const onDisk = child.hasFile;
                return (
                  <li key={child.arrChildId} className="child-row">
                    <span className="child-row__label">{child.label}</span>
                    <span className={`badge badge--${onDisk ? 'ok' : 'warn'}`}>
                      {onDisk ? 'On disk' : 'Missing'}
                    </span>
                    <button
                      type="button"
                      className="btn sm child-row__action"
                      onClick={() =>
                        setAction({
                          mode: onDisk ? 'fix' : 'search',
                          target: { childId: child.arrChildId, label: child.label },
                        })
                      }
                    >
                      {onDisk ? 'Fix' : 'Force Search'}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}

      <section className="card admin-section">
        <h2>Details</h2>
        <dl className="meta-grid">
          <div>
            <dt>Quality profile</dt>
            <dd>{item.qualityProfileName}</dd>
          </div>
          <div>
            <dt>Root folder</dt>
            <dd className="url-cell">{item.rootFolder}</dd>
          </div>
          <div>
            <dt>Size on disk</dt>
            <dd>{item.sizeOnDisk > 0 ? formatBytes(item.sizeOnDisk) : '—'}</dd>
          </div>
          <div>
            <dt>Files</dt>
            <dd>
              {item.onDiskFileCount}/{item.expectedFileCount}
            </dd>
          </div>
          <div>
            <dt>Tags</dt>
            <dd>
              {item.arrTags.length === 0 ? (
                '—'
              ) : (
                <span className="chips">
                  {item.arrTags.map((t) => (
                    <span key={t} className="chip">
                      {t}
                    </span>
                  ))}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>Last synced</dt>
            <dd>{formatWhen(item.lastSeenAt)}</dd>
          </div>
        </dl>
      </section>

      {fixes.length > 0 ? (
        <section className="card admin-section">
          <h2>Fixes on this item</h2>
          <ul className="fix-list">
            {fixes.map((fix) => (
              <li key={fix.id} className="fix-list__row">
                <span className={`badge badge--${fixStatusTone(fix.status)}`}>
                  {FIX_STATUS_LABELS[fix.status] ?? fix.status}
                </span>
                <span className="fix-list__what">
                  {fix.targetLabel ?? 'Whole item'} — {FIX_REASON_LABELS[fix.reason] ?? fix.reason}
                  {fix.reasonText ? `: ${fix.reasonText}` : ''}
                </span>
                <span className="muted fix-list__when">
                  {fix.requesterDisplayName ?? 'someone'} · {formatWhen(fix.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="card admin-section">
        <h2>History</h2>
        {timeline.length === 0 ? (
          <p className="muted">No recorded events yet.</p>
        ) : (
          <ol className="timeline">
            {timeline.map((event) => (
              <li key={event.id}>
                <span className="timeline__type">
                  {EVENT_TYPE_LABELS[event.eventType] ?? event.eventType}
                </span>
                <span className="timeline__detail">
                  {typeof event.payload.sourceTitle === 'string' ? event.payload.sourceTitle : null}
                  {event.eventType === 'requested' ? (
                    <> by {event.requestedByDisplayName ?? 'unattributed'}</>
                  ) : null}
                </span>
                <span className="muted timeline__when">
                  {formatWhen(event.occurredAt)} · {event.source}
                </span>
              </li>
            ))}
          </ol>
        )}
        {events.hasNextPage ? (
          <div className="load-more">
            <button
              type="button"
              className="btn sm"
              disabled={events.isFetchingNextPage}
              onClick={() => void events.fetchNextPage()}
            >
              {events.isFetchingNextPage ? 'Loading…' : 'Older events'}
            </button>
          </div>
        ) : null}
      </section>

      <FixDialog
        open={action?.mode === 'fix'}
        onClose={() => setAction(null)}
        item={{ id: item.id, arrKind: item.arrKind, title: item.title }}
        target={action?.mode === 'fix' ? action.target : null}
        onSubmitted={refresh}
      />
      <ForceSearchDialog
        open={action?.mode === 'search'}
        onClose={() => setAction(null)}
        item={{ id: item.id, arrKind: item.arrKind, title: item.title }}
        target={action?.mode === 'search' ? action.target : null}
        onSubmitted={refresh}
      />
    </>
  );
}
