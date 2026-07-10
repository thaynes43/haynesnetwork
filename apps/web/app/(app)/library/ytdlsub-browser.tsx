'use client';

// ADR-038 / DESIGN-017 D-05 (PLAN-022) — a ytdl-sub Library sub-tab (Peloton / YouTube). Reuses the
// Library idioms wholesale: the `.media-list.poster-grid` of `.poster-card` tiles, `MediaPoster` (null /
// load-error → KindIcon fallback tile), and the `@hnet/ui` sort engine (nextSort / arrowFor /
// sortRowsClientSide) + the `.sort-btn` fixed-arrow idiom. The data is read DIRECTLY from the k8plex Plex
// server via `ytdlsub.list` (no *arr, no ledger). Filter + sort are client-side over the (small) show set;
// a one-shot query (no poll). Reflow-free (ADR-015): fixed 2:3 poster boxes, dim-in-place on refetch, a
// fixed-height sort row, and skeleton tiles on first load.
import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  arrowFor,
  cmpNum,
  cmpStr,
  nextSort,
  sortRowsClientSide,
  type FieldSpec,
} from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import { MediaPoster } from '@/components/media-poster';
import type { YtdlsubShow } from '@hnet/api';

type SortCol = 'title' | 'added';
type SortToken = 'title:asc' | 'title:desc' | 'added:asc' | 'added:desc';

const SORT_COLUMNS: Array<{ col: SortCol; label: string }> = [
  { col: 'title', label: 'Title' },
  { col: 'added', label: 'Recently added' },
];

const SORT_CYCLE: Record<SortCol, { asc: SortToken; desc: SortToken }> = {
  title: { asc: 'title:asc', desc: 'title:desc' },
  added: { asc: 'added:asc', desc: 'added:desc' },
};

const SORT_FIELDS: Partial<Record<SortToken, FieldSpec<YtdlsubShow>>> = {
  'title:asc': { get: (r) => r.title, compare: cmpStr, dir: 'asc' },
  'title:desc': { get: (r) => r.title, compare: cmpStr, dir: 'desc' },
  'added:asc': { get: (r) => r.addedAt, compare: cmpNum, dir: 'asc' },
  'added:desc': { get: (r) => r.addedAt, compare: cmpNum, dir: 'desc' },
};

/** "4 seasons · 128 episodes" — omits either half when the count is absent. */
function countLine(show: YtdlsubShow): string | null {
  const parts: string[] = [];
  if (show.seasonCount !== null) {
    parts.push(`${show.seasonCount} ${show.seasonCount === 1 ? 'season' : 'seasons'}`);
  }
  if (show.episodeCount !== null) {
    parts.push(`${show.episodeCount} ${show.episodeCount === 1 ? 'episode' : 'episodes'}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function YtdlsubBrowser({ library, label }: { library: 'peloton' | 'youtube'; label: string }) {
  const [query, setQuery] = useState('');
  const [sortToken, setSortToken] = useState<SortToken>('title:asc');

  const list = trpc.ytdlsub.list.useQuery(
    { library },
    { placeholderData: (prev) => prev, refetchOnWindowFocus: false },
  );

  const shows = useMemo(() => {
    const rows = list.data?.items ?? [];
    const q = query.trim().toLowerCase();
    const filtered = q === '' ? rows : rows.filter((r) => r.title.toLowerCase().includes(q));
    return sortRowsClientSide(filtered, sortToken, {
      fields: SORT_FIELDS,
      tiebreaker: (a, b) => cmpStr(a.title, b.title),
    });
  }, [list.data, query, sortToken]);

  const refreshing = list.isFetching && !list.isLoading;

  return (
    <>
      <div className="library-toolbar">
        <div className="library-controls">
          <input
            type="search"
            className="library-search"
            placeholder={`Search ${label.toLowerCase()}…`}
            aria-label={`Search ${label}`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {/* Sort bar — the shared `.sort-btn` idiom (fixed-width arrow slot ⇒ no reflow, ADR-015). */}
        <div className="library-sortbar" role="group" aria-label="Sort">
          {SORT_COLUMNS.map((c) => {
            const isActive = sortToken.startsWith(`${c.col}:`);
            return (
              <button
                key={c.col}
                type="button"
                className={`sort-btn${isActive ? ' is-active' : ''}`}
                aria-pressed={isActive}
                onClick={() => setSortToken(nextSort<SortToken, SortCol>(sortToken, c.col, SORT_CYCLE))}
              >
                {c.label}
                <span className="sort-btn__arrow" aria-hidden="true">
                  {arrowFor<SortToken, SortCol>(sortToken, c.col, SORT_CYCLE).trim()}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {list.isLoading ? (
        <div className="media-list poster-grid" aria-hidden="true" data-testid="ytdlsub-skeleton">
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i} className="poster-card poster-card--skeleton">
              <div className="poster-box" />
              <span className="poster-card__body">
                <span className="skeleton-line" />
                <span className="skeleton-line skeleton-line--short" />
              </span>
            </div>
          ))}
        </div>
      ) : list.error ? (
        <p className="alert" role="alert">
          Failed to load {label}: {list.error.message}
        </p>
      ) : list.data?.unavailable ? (
        <section className="card empty-state" data-testid="ytdlsub-unavailable">
          <p className="muted">Couldn’t reach the {label} library right now — try again shortly.</p>
        </section>
      ) : list.data?.found === false ? (
        <section className="card empty-state" data-testid="ytdlsub-missing">
          <p className="muted">The {label} library isn’t on the server yet.</p>
        </section>
      ) : shows.length === 0 ? (
        <section className="card empty-state">
          <p>Nothing matches your search.</p>
        </section>
      ) : (
        <div
          className={`media-list poster-grid${refreshing ? ' is-refreshing' : ''}`}
          aria-busy={refreshing}
          data-testid="ytdlsub-grid"
        >
          {shows.map((show) => {
            const counts = countLine(show);
            return (
              // DESIGN-017 D-09 (R-132) — tiles are click-throughs to the read-only drill-in
              // (the MediaBrowser card idiom; supersedes the action-free-tile scope note).
              <Link
                key={show.ratingKey}
                href={`/library/ytdlsub/${library}/${show.ratingKey}`}
                className="media-card poster-card"
              >
                <MediaPoster posterUrl={show.posterUrl} kind="show" alt="" />
                <span className="poster-card__body">
                  <span className="media-card__title">
                    {show.title}
                    {show.year !== null ? <span className="muted"> ({show.year})</span> : null}
                  </span>
                  {counts !== null ? (
                    <span className="media-card__badges">
                      <span className="badge">{counts}</span>
                    </span>
                  ) : null}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
