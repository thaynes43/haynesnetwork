'use client';

// DESIGN-005 D-17 / D-15 — the /library/[id] client view: metadata card, the live
// per-episode / per-album list (D-06 ledger.children) with a per-child action —
// Fix when it is on disk (something to repair), Force Search when it is missing
// (nothing to blocklist, just search). Media-hierarchy actions add roll-ups: sonarr
// episodes group into collapsible SEASON sections (each with a season Force Search +
// Fix), and a whole-show / whole-artist Force Search sits in the section header.
// Radarr acts at the movie level in the header. Below: fix history for the item (R-46)
// and the ledger event timeline (R-41).
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import {
  ARR_KIND_LABELS,
  EVENT_TYPE_LABELS,
  FIX_REASON_LABELS,
  FIX_STATUS_LABELS,
  RESOLUTION_LABELS,
  fixStatusTone,
  formatBytes,
  formatRating,
  formatRuntime,
  formatWhen,
  groupBySeason,
  onDiskSummary,
  seasonName,
  type ActionTarget,
  type ArrKindName,
} from '@/lib/media';
import { MediaPoster } from '@/components/media-poster';
import { FixDialog } from './fix-dialog';
import { ForceSearchDialog } from './force-search-dialog';

/** The open dialog: repair (Fix) vs search-only (Force Search), and its scoped target. */
type PendingAction = {
  mode: 'fix' | 'search';
  target: ActionTarget | null;
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

  // Sonarr episodes group into collapsible season sections (media-hierarchy actions).
  const seasons = useMemo(
    () => (arrKind === 'sonarr' ? groupBySeason(children.data ?? []) : []),
    [arrKind, children.data],
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
  // ledger.detail.metadata is now ALWAYS an object (all-null when unharvested — same shape as
  // search, DESIGN-008 D-09), so the old `metadata !== null` guards are dead. The About card
  // still renders only when it has something to show — gate it on real harvested content.
  const meta = item.metadata;
  const hasAbout =
    meta.imdbRating !== null ||
    meta.tmdbRating !== null ||
    meta.rtTomatometer !== null ||
    meta.rtPopcorn !== null ||
    meta.playCount !== null ||
    meta.lastViewedAt !== null ||
    meta.addedAt !== null ||
    meta.genres.length > 0 ||
    meta.requesters.length > 0 ||
    meta.sourceCollections.length > 0;
  const timeline = events.data?.pages.flatMap((p) => p.events) ?? [];

  const refresh = () => {
    void utils.ledger.detail.invalidate({ id: mediaItemId });
    void utils.ledger.events.invalidate();
    void utils.ledger.children.invalidate({ mediaItemId });
    void utils.fix.myFixes.invalidate();
  };

  // Shared "children not loaded yet" node (tombstoned / loading / error / empty) — null
  // when the live child list is ready to render.
  const childrenNotReady = tombstoned ? (
    <p className="muted">This item was removed from the manager — nothing to fix.</p>
  ) : children.isLoading ? (
    <p className="muted">Loading {childNoun}s…</p>
  ) : children.error ? (
    <p className="alert" role="alert">
      Could not load the {childNoun} list: {children.error.message}
    </p>
  ) : (children.data ?? []).length === 0 ? (
    <p className="muted">No {childNoun}s found on the manager.</p>
  ) : null;

  // One child row (owner availability rule 2026-07-04): ON DISK → BOTH Fix (repair the
  // grab) and Force Search (just re-grab); MISSING → Force Search only (nothing on disk
  // to blocklist/delete). Force Search is always available; Fix is gated on hasFile.
  const childRow = (child: { arrChildId: number; label: string; hasFile: boolean }, scope: 'episode' | 'album') => (
    <li key={child.arrChildId} className="child-row">
      <span className="child-row__label">{child.label}</span>
      <span className={`badge badge--${child.hasFile ? 'ok' : 'warn'}`}>
        {child.hasFile ? 'On disk' : 'Missing'}
      </span>
      <span className="child-row__actions">
        {child.hasFile ? (
          <button
            type="button"
            className="btn sm"
            onClick={() =>
              setAction({
                mode: 'fix',
                target: { scope, childId: child.arrChildId, label: child.label },
              })
            }
          >
            Fix
          </button>
        ) : null}
        <button
          type="button"
          className="btn sm"
          onClick={() =>
            setAction({
              mode: 'search',
              target: { scope, childId: child.arrChildId, label: child.label },
            })
          }
        >
          Force Search
        </button>
      </span>
    </li>
  );

  return (
    <>
      <p className="crumbs">
        <Link href="/library">← Library</Link>
      </p>

      <section className="card detail-head">
        {/* DESIGN-008 D-11 — the fixed 2:3 poster box replaces the kind icon; the KindIcon
            fallback lives inside MediaPoster (null poster / load error), so tombstoned or
            unharvested items still read correctly. */}
        <span className="detail-head__poster">
          <MediaPoster posterUrl={item.posterUrl} kind={item.arrKind} alt="" />
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
          {item.metadata.runtimeMinutes !== null || item.metadata.resolution !== null ? (
            <p className="detail-head__meta muted">
              {[
                formatRuntime(item.metadata.runtimeMinutes),
                item.metadata.resolution !== null
                  ? (RESOLUTION_LABELS[item.metadata.resolution] ?? item.metadata.resolution)
                  : null,
              ]
                .filter((part) => part !== null)
                .join(' · ')}
            </p>
          ) : null}
        </div>
        {/* Radarr acts at the movie level (the movie IS the unit — ADR-007). Sonarr/Lidarr
            act per episode/album below, so the show-level nuke is gone (owner feedback).
            Owner availability rule (2026-07-04): ON DISK → BOTH Fix and Force Search;
            MISSING → Force Search only. */}
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
            ) : null}
            <button
              type="button"
              className={item.onDiskFileCount > 0 ? 'btn' : 'btn primary'}
              disabled={item.tombstonedAt !== null}
              onClick={() => setAction({ mode: 'search', target: null })}
            >
              Force Search
            </button>
          </div>
        ) : null}
      </section>

      {/* DESIGN-008 D-11 — the harvested metadata block: ratings row, watch stats, and the
          genre / requester / collection chips. Rendered only once the metadata-refresh harvest
          has run for this item; the layout is static — nothing here re-orients on interaction
          (ADR-015). NB: the facts <dl> is `about-facts`, NOT `.meta-grid` — the Details section
          below owns that class (and the e2e suite targets it singularly). */}
      {hasAbout ? (
        <section className="card admin-section">
          <h2>About</h2>
          <div className="ratings-row" role="group" aria-label="Ratings">
            {item.metadata.imdbRating !== null ? (
              <span
                className="rating-pill"
                title={
                  item.metadata.imdbVotes !== null
                    ? `IMDb — ${item.metadata.imdbVotes.toLocaleString()} votes`
                    : 'IMDb rating'
                }
              >
                <span className="rating-pill__src">IMDb</span>
                <span className="rating-pill__val">{formatRating(item.metadata.imdbRating)}</span>
              </span>
            ) : null}
            {item.metadata.tmdbRating !== null ? (
              <span
                className="rating-pill"
                title={
                  item.metadata.tmdbVotes !== null
                    ? `TMDb — ${item.metadata.tmdbVotes.toLocaleString()} votes`
                    : 'TMDb rating'
                }
              >
                <span className="rating-pill__src">TMDb</span>
                <span className="rating-pill__val">{formatRating(item.metadata.tmdbRating)}</span>
              </span>
            ) : null}
            {item.metadata.rtTomatometer !== null ? (
              <span className="rating-pill" title="Rotten Tomatoes tomatometer">
                <span className="rating-pill__src">RT</span>
                <span className="rating-pill__val">{item.metadata.rtTomatometer}%</span>
              </span>
            ) : null}
            {item.metadata.rtPopcorn !== null ? (
              <span className="rating-pill" title="Rotten Tomatoes audience">
                <span className="rating-pill__src">RT Audience</span>
                <span className="rating-pill__val">{item.metadata.rtPopcorn}%</span>
              </span>
            ) : null}
            {item.metadata.imdbRating === null &&
            item.metadata.tmdbRating === null &&
            item.metadata.rtTomatometer === null &&
            item.metadata.rtPopcorn === null ? (
              <span className="muted">No ratings yet.</span>
            ) : null}
          </div>
          <dl className="about-facts">
            {item.metadata.playCount !== null ? (
              <div>
                <dt>Plays</dt>
                <dd>{item.metadata.playCount}</dd>
              </div>
            ) : null}
            {item.metadata.lastViewedAt !== null ? (
              <div>
                <dt>Last watched</dt>
                <dd>{formatWhen(item.metadata.lastViewedAt)}</dd>
              </div>
            ) : null}
            {item.metadata.addedAt !== null ? (
              <div>
                <dt>Added to the manager</dt>
                <dd>{formatWhen(item.metadata.addedAt)}</dd>
              </div>
            ) : null}
          </dl>
          {item.metadata.genres.length > 0 ? (
            <div className="meta-chips">
              <span className="meta-chips__label">Genres</span>
              <span className="chips">
                {item.metadata.genres.map((g) => (
                  <span key={g} className="chip">
                    {g}
                  </span>
                ))}
              </span>
            </div>
          ) : null}
          {item.metadata.requesters.length > 0 ? (
            <div className="meta-chips">
              <span className="meta-chips__label">Requested by</span>
              <span className="chips">
                {item.metadata.requesters.map((r) => (
                  <span key={r} className="chip chip--requester">
                    {r}
                  </span>
                ))}
              </span>
            </div>
          ) : null}
          {item.metadata.sourceCollections.length > 0 ? (
            <div className="meta-chips">
              <span className="meta-chips__label">Collections</span>
              <span className="chips">
                {item.metadata.sourceCollections.map((c) => (
                  <span key={c} className="chip">
                    {c}
                  </span>
                ))}
              </span>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Sonarr: episodes grouped into collapsible SEASON sections. Each season header
          is a touch target that expands the episode list, and carries a season-level
          Force Search (always) + Fix (when the season has something on disk). The whole
          SHOW gets a Force Search here too — but no whole-show Fix: blocklisting every
          grab of a series is too broad, so on-disk repair stays at season/episode grain
          (owner judgment call — Force Search covers the whole-show "just search" need). */}
      {item.arrKind === 'sonarr' ? (
        <section className="card admin-section">
          <div className="section-head">
            <h2>Episodes</h2>
            {!tombstoned ? (
              <button
                type="button"
                className="btn sm"
                onClick={() =>
                  setAction({ mode: 'search', target: { scope: 'show', label: item.title } })
                }
              >
                Force Search show
              </button>
            ) : null}
          </div>
          {childrenNotReady ?? (
            <div className="season-list">
              {seasons.map((s) => (
                <details key={s.seasonNumber} className="season">
                  <summary className="season__head">
                    <span className="season__title">{seasonName(s.seasonNumber)}</span>
                    <span
                      className={`badge badge--${s.onDiskCount >= s.total ? 'ok' : s.onDiskCount > 0 ? 'info' : 'warn'}`}
                    >
                      {s.onDiskCount}/{s.total} on disk
                    </span>
                    <span className="season__actions">
                      {s.onDiskCount > 0 ? (
                        <button
                          type="button"
                          className="btn sm"
                          onClick={(e) => {
                            e.preventDefault();
                            setAction({
                              mode: 'fix',
                              target: {
                                scope: 'season',
                                seasonNumber: s.seasonNumber,
                                label: seasonName(s.seasonNumber),
                              },
                            });
                          }}
                        >
                          Fix season
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="btn sm"
                        onClick={(e) => {
                          e.preventDefault();
                          setAction({
                            mode: 'search',
                            target: {
                              scope: 'season',
                              seasonNumber: s.seasonNumber,
                              label: seasonName(s.seasonNumber),
                            },
                          });
                        }}
                      >
                        Force Search
                      </button>
                    </span>
                  </summary>
                  <ul className="child-list">{s.episodes.map((ep) => childRow(ep, 'episode'))}</ul>
                </details>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {/* Lidarr: albums as a flat list (albums are the fix unit — no per-track scope in
          our design; DESIGN-005 D-06). The whole ARTIST gets a Force Search roll-up. */}
      {item.arrKind === 'lidarr' ? (
        <section className="card admin-section">
          <div className="section-head">
            <h2>Albums</h2>
            {!tombstoned ? (
              <button
                type="button"
                className="btn sm"
                onClick={() =>
                  setAction({ mode: 'search', target: { scope: 'artist', label: item.title } })
                }
              >
                Force Search artist
              </button>
            ) : null}
          </div>
          {childrenNotReady ?? (
            <ul className="child-list">
              {(children.data ?? []).map((child) => childRow(child, 'album'))}
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
